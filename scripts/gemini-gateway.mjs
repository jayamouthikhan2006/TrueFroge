#!/usr/bin/env node
// Thought-signature gateway for Gemini 3.x behind TrueForge.
//
// Gemini 3.x models return a `thought_signature` with every function call and
// reject the next request (400 "Function call is missing a thought_signature")
// unless the client sends it back. TrueForge 0.185 drops it on both its native
// google-gemini provider and its OpenAI-compatible `custom` provider, so every
// tool-using turn fails on the second model request.
//
// This gateway sits between TrueForge and Google's OpenAI-compatible endpoint.
// TrueForge still makes every model call (the extension makes none); the
// gateway only remembers each tool call's signature from Google's responses and
// re-attaches it to that tool call when TrueForge replays the conversation. A
// tool call it has never seen (e.g. after a gateway restart) gets Google's
// documented placeholder signature instead.
//
// Usage: node scripts/gemini-gateway.mjs [--port 8792]
// Point a `custom` provider at http://127.0.0.1:8792/v1beta/openai.
import http from 'node:http';

const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1] || process.env.FORGE_GEMINI_GATEWAY_PORT || 8792);
const UPSTREAM = process.env.FORGE_GEMINI_UPSTREAM || 'https://generativelanguage.googleapis.com';
const PLACEHOLDER = 'skip_thought_signature_validator';
const MAX_ENTRIES = 20000;

/** tool call id -> thought signature, oldest evicted first. */
const signatures = new Map();
const remember = (id, signature) => {
  if (!id || !signature) return;
  signatures.delete(id);
  signatures.set(id, signature);
  if (signatures.size > MAX_ENTRIES) signatures.delete(signatures.keys().next().value);
};

const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);

/** Re-attach signatures to every assistant tool call in an outgoing chat request. */
function patchRequest(body) {
  let restored = 0;
  let placeholders = 0;
  for (const message of body.messages ?? []) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (call.extra_content?.google?.thought_signature) continue;
      const known = signatures.get(call.id);
      call.extra_content = { ...call.extra_content, google: { ...call.extra_content?.google, thought_signature: known ?? PLACEHOLDER } };
      known ? restored++ : placeholders++;
    }
  }
  return { restored, placeholders };
}

/** Collect signatures from a response's tool calls (full message or stream delta). */
function harvest(choice, ids) {
  const calls = choice?.message?.tool_calls ?? choice?.delta?.tool_calls ?? [];
  for (const call of calls) {
    const key = `${choice.index ?? 0}:${call.index ?? 0}`;
    if (call.id) ids.set(key, call.id);
    const signature = call.extra_content?.google?.thought_signature;
    if (signature) remember(call.id ?? ids.get(key), signature);
  }
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let payload = Buffer.concat(chunks);
  let stats;
  if (req.method === 'POST' && /\/chat\/completions$/.test(req.url) && payload.length) {
    try {
      const body = JSON.parse(payload.toString('utf8'));
      stats = patchRequest(body);
      payload = Buffer.from(JSON.stringify(body));
    } catch {
      // Not JSON: forward untouched and let the upstream answer.
    }
  }
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!['host', 'content-length', 'connection', 'accept-encoding'].includes(name)) headers[name] = value;
  }
  let upstream;
  try {
    upstream = await fetch(UPSTREAM + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : payload });
  } catch (error) {
    log('upstream unreachable:', error.message);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `gemini-gateway: upstream unreachable (${error.message})` } }));
    return;
  }
  if (stats) log(`${req.method} ${req.url} -> ${upstream.status} (signatures restored ${stats.restored}, placeholders ${stats.placeholders})`);
  const outHeaders = {};
  upstream.headers.forEach((value, name) => {
    if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(name)) outHeaders[name] = value;
  });
  res.writeHead(upstream.status, outHeaders);
  if (!upstream.body) return res.end();

  const isStream = (upstream.headers.get('content-type') || '').includes('text/event-stream');
  const ids = new Map();
  const decoder = new TextDecoder();
  let pending = '';
  let whole = '';
  for await (const chunk of upstream.body) {
    res.write(chunk);
    const text = decoder.decode(chunk, { stream: true });
    if (!isStream) {
      whole += text;
      continue;
    }
    pending += text;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        for (const choice of JSON.parse(data).choices ?? []) harvest(choice, ids);
      } catch {
        // Partial or non-JSON event: nothing to harvest.
      }
    }
  }
  if (!isStream && whole) {
    try {
      for (const choice of JSON.parse(whole).choices ?? []) harvest(choice, ids);
    } catch {
      // Error bodies and non-JSON responses carry no signatures.
    }
  }
  res.end();
});

server.listen(PORT, '127.0.0.1', () => log(`gemini-gateway listening on http://127.0.0.1:${PORT} -> ${UPSTREAM}`));
