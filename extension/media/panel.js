// ForgeCode agent panel (webview). Plain DOM, no framework; all text that
// comes from the model, tools or files is escaped before rendering.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  let state = { running: false, reviews: [], approvals: [], undo: {}, models: {}, budget: 6000, health: {} };
  const runs = new Map();
  let currentRunId = null;
  let explicit = { tokens: 0, items: [] };
  let manifest = null;
  let suggestRequest = 0;
  let suggestions = [];
  let suggestIndex = 0;

  // ---- helpers -------------------------------------------------------------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const el = (tag, cls, html) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html !== undefined) node.innerHTML = html;
    return node;
  };
  const post = (msg) => vscode.postMessage(msg);

  function markdown(text) {
    const parts = String(text ?? '').split(/```/);
    return parts
      .map((part, i) => {
        if (i % 2 === 1) {
          const nl = part.indexOf('\n');
          const body = nl >= 0 ? part.slice(nl + 1) : part;
          return `<pre class="code"><code>${esc(body.replace(/\n$/, ''))}</code></pre>`;
        }
        return esc(part)
          .replace(/`([^`\n]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
          .replace(/^#{1,4} (.+)$/gm, '<strong class="h">$1</strong>')
          .replace(/^[-*] (.+)$/gm, '• $1')
          .replace(/\n/g, '<br>');
      })
      .join('');
  }

  function summarizeArgs(name, raw) {
    let args = {};
    try {
      args = JSON.parse(raw || '{}');
    } catch {
      return raw ? String(raw).slice(0, 80) : '';
    }
    if (args.path) return args.path + (args.start_line ? `:${args.start_line}-${args.end_line ?? ''}` : '');
    if (args.query) return `“${String(args.query).slice(0, 90)}”`;
    if (args.command) return `$ ${args.command}`;
    if (args.name) return args.name;
    if (args.task || args.instructions) return String(args.task || args.instructions).slice(0, 90);
    if (args.mcp_server) return args.mcp_server;
    return Object.keys(args).slice(0, 3).join(', ');
  }

  // ---- layout ---------------------------------------------------------------
  app.innerHTML = `
    <header class="top">
      <div class="brand">ForgeCode <span class="muted">on TrueForge</span></div>
      <div class="health" id="health"></div>
    </header>
    <div class="bar">
      <select id="model" title="Model for the next run (primary). The fallback is used automatically on failure."></select>
      <button id="session" class="link" title="Open this session's turn trace in TrueForge"></button>
      <button id="newChat" class="ghost" title="Start a new TrueForge session">New chat</button>
    </div>
    <section class="budget" id="budget"></section>
    <section id="reviews"></section>
    <section id="approvals"></section>
    <main id="log"><div class="empty">Describe a task. ForgeCode retrieves context on its own; attach more with <code>@file:</code> or <code>@symbol:</code>.<br><br>Every edit comes back as per-hunk diffs in the editor for you to accept or reject.</div></main>
    <footer class="composer">
      <div class="suggest" id="suggest" hidden></div>
      <textarea id="input" rows="3" placeholder="Ask ForgeCode… (@file:, @symbol:)  Enter to send, Shift+Enter for a new line"></textarea>
      <div class="actions">
        <button id="undo" class="ghost" title="ForgeCode: Undo Last Agent Edit">↶ Undo edit</button>
        <button id="redo" class="ghost" title="Redo">↷ Redo</button>
        <span class="spacer"></span>
        <button id="send" class="primary">Send</button>
        <button id="stop" class="danger" hidden title="Stop Generation (Esc)">■ Stop Generation</button>
      </div>
    </footer>`;

  const $ = (id) => document.getElementById(id);
  const log = $('log');
  const input = $('input');

  $('send').onclick = () => submit();
  $('stop').onclick = () => post({ type: 'stop' });
  $('undo').onclick = () => post({ type: 'undo' });
  $('redo').onclick = () => post({ type: 'redo' });
  $('newChat').onclick = () => post({ type: 'newChat' });
  $('session').onclick = () => post({ type: 'openSession' });
  $('model').onchange = (e) => post({ type: 'setModel', model: e.target.value });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.running) {
      post({ type: 'stop' });
      e.preventDefault();
    }
  });

  function submit() {
    const text = input.value.trim();
    if (!text || state.running) return;
    input.value = '';
    hideSuggest();
    post({ type: 'submit', text });
  }

  // ---- @-mention autocomplete -------------------------------------------------
  function mentionAtCaret() {
    const before = input.value.slice(0, input.selectionStart);
    const m = /@(file|symbol):([^\s]*)$/.exec(before) || /@([a-z]*)$/.exec(before);
    if (!m) return null;
    if (m.length === 3) return { kind: m[1], query: m[2], start: before.length - m[0].length };
    return { kind: null, query: m[1], start: before.length - m[0].length };
  }

  input.addEventListener('input', () => {
    const m = mentionAtCaret();
    if (!m) return hideSuggest();
    if (!m.kind) {
      showSuggest(
        [
          { label: '@file:', detail: 'attach a file', insert: '@file:' },
          { label: '@symbol:', detail: 'attach a class/function', insert: '@symbol:' },
        ].filter((s) => s.label.slice(1).startsWith(m.query)),
        m,
      );
      return;
    }
    const requestId = ++suggestRequest;
    post({ type: 'suggest', kind: m.kind, query: m.query, requestId });
  });

  input.addEventListener('keydown', (e) => {
    const box = $('suggest');
    if (!box.hidden && suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        suggestIndex = (suggestIndex + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length;
        renderSuggest();
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        applySuggestion(suggestions[suggestIndex]);
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        hideSuggest();
        e.stopPropagation();
        e.preventDefault();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  function showSuggest(items, m) {
    suggestions = items.map((it) => ({ ...it, start: m.start }));
    suggestIndex = 0;
    renderSuggest();
  }
  function renderSuggest() {
    const box = $('suggest');
    if (!suggestions.length) return hideSuggest();
    box.hidden = false;
    box.innerHTML = suggestions
      .map((s, i) => `<div class="opt ${i === suggestIndex ? 'sel' : ''}" data-i="${i}"><span>${esc(s.label)}</span><span class="muted">${esc(s.detail)}</span></div>`)
      .join('');
    box.querySelectorAll('.opt').forEach((node) => (node.onmousedown = (e) => (e.preventDefault(), applySuggestion(suggestions[Number(node.dataset.i)]))));
  }
  function hideSuggest() {
    suggestions = [];
    $('suggest').hidden = true;
  }
  function applySuggestion(s) {
    if (!s) return;
    const caret = input.selectionStart;
    const before = input.value.slice(0, s.start);
    const after = input.value.slice(caret);
    const insert = s.insert.endsWith(':') ? s.insert : `${s.insert} `;
    input.value = before + insert + after;
    const pos = (before + insert).length;
    input.setSelectionRange(pos, pos);
    input.focus();
    if (insert.endsWith(':')) input.dispatchEvent(new Event('input'));
    else hideSuggest();
  }

  // ---- runs & events ------------------------------------------------------------
  function runView(runId) {
    let run = runs.get(runId);
    if (!run) {
      const root = el('div', 'run');
      log.querySelector('.empty')?.remove();
      log.appendChild(root);
      run = { root, messages: new Map(), tools: new Map(), threads: new Map() };
      runs.set(runId, run);
    }
    return run;
  }

  function scroll() {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 160;
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }

  function assistantBlock(run, ev) {
    let block = run.messages.get(ev.messageId);
    if (!block) {
      const sub = ev.threadId && ev.threadId !== 'main';
      const node = el('div', `msg assistant${sub ? ' sub' : ''}`);
      const reasoning = el('details', 'reasoning');
      reasoning.innerHTML = '<summary>reasoning</summary><div class="rt"></div>';
      reasoning.hidden = true;
      const body = el('div', 'body');
      node.append(reasoning, body);
      run.root.appendChild(node);
      block = { node, body, reasoning, text: '', reasoningText: '' };
      run.messages.set(ev.messageId, block);
    }
    return block;
  }

  function onEvent(ev) {
    const run = ev.runId ? runView(ev.runId) : null;
    switch (ev.type) {
      case 'run.started': {
        currentRunId = ev.runId;
        explicit = { tokens: 0, items: [] };
        run.root.appendChild(el('div', 'msg user', `<div class="who">${ev.mode === 'inline' ? 'Inline edit' : 'You'}</div>${markdown(ev.prompt)}`));
        run.root.appendChild(el('div', 'meta', `→ TrueForge · ${esc(ev.model)}`));
        break;
      }
      case 'run.session':
        if (!run.sessionShown) {
          run.sessionShown = true;
          const link = el('div', 'meta', `session <a href="#" class="sess">${esc(ev.sessionId)}</a>`);
          link.querySelector('a').onclick = (e) => (e.preventDefault(), post({ type: 'openSession' }));
          run.root.appendChild(link);
        }
        if (ev.turnId) run.turnId = ev.turnId;
        break;
      case 'message.delta': {
        const block = assistantBlock(run, ev);
        if (ev.reasoning) {
          block.reasoning.hidden = false;
          block.reasoningText += ev.text;
          block.reasoning.querySelector('.rt').textContent = block.reasoningText;
        } else {
          block.text += ev.text;
          block.body.innerHTML = markdown(block.text) + '<span class="caret"></span>';
        }
        break;
      }
      case 'message.done': {
        const block = assistantBlock(run, ev);
        if (!block.text) block.text = ev.text;
        block.body.innerHTML = markdown(block.text);
        break;
      }
      case 'tool.started': {
        if (run.tools.has(ev.callId)) break;
        const sub = ev.threadId && ev.threadId !== 'main';
        const isSubagent = ev.name === 'create_sub_agent';
        const node = el('details', `tool running${sub ? ' sub' : ''}${isSubagent ? ' subagent' : ''}`);
        node.innerHTML = `<summary><span class="st"></span><span class="tn">${esc(isSubagent ? 'sub-agent' : ev.name)}</span>${ev.deferred ? '<span class="badge" title="Loaded on demand through TrueForge deferred tool loading">deferred</span>' : ''}<span class="ta">${esc(summarizeArgs(ev.name, ev.args))}</span></summary><pre class="args">${esc(ev.args)}</pre><pre class="result"></pre>`;
        run.root.appendChild(node);
        run.tools.set(ev.callId, node);
        break;
      }
      case 'tool.approval': {
        const node = run.tools.get(ev.callId);
        if (!node) break;
        node.classList.remove('running', 'approval', 'allowed', 'denied');
        node.classList.add(ev.state === 'required' ? 'approval' : ev.state === 'allowed' ? 'allowed' : 'denied');
        if (ev.state === 'denied' && ev.reason) node.querySelector('.result').textContent = `denied: ${ev.reason}`;
        break;
      }
      case 'tool.finished': {
        const node = run.tools.get(ev.callId);
        if (!node) break;
        node.classList.remove('running', 'approval', 'allowed');
        node.classList.add(ev.isError ? 'error' : 'done');
        node.querySelector('.result').textContent = ev.result;
        break;
      }
      case 'subagent.started':
        run.root.appendChild(el('div', 'meta sub', `↳ sub-agent started: <strong>${esc(ev.title)}</strong>`));
        break;
      case 'subagent.finished':
        run.root.appendChild(el('div', 'meta sub', '↳ sub-agent returned its result'));
        break;
      case 'compaction':
        run.root.appendChild(el('div', 'meta', ev.phase === 'started' ? '⟲ TrueForge is compacting the context…' : '⟲ context compacted'));
        break;
      case 'context.explicit':
        explicit = { tokens: ev.tokens, items: ev.items };
        renderBudget();
        break;
      case 'context.manifest':
        manifest = ev.manifest;
        renderBudget();
        if (run) run.root.appendChild(manifestCard(ev.manifest));
        break;
      case 'failover':
        run.root.appendChild(el('div', 'banner warn', `<strong>Primary model failed (${esc(ev.reason)}).</strong> Automatically failing over to Backup Model <code>${esc(ev.to)}</code>…<div class="detail">${esc(ev.detail)}</div>`));
        break;
      case 'status': {
        const target = run ? run.root : log;
        const last = target.lastElementChild;
        if (last && last.classList.contains('status') && ev.level === 'info' && /^(Running|Waiting)/.test(ev.text)) {
          last.textContent = ev.text;
        } else {
          target.appendChild(el('div', `status ${ev.level}`, esc(ev.text)));
        }
        break;
      }
      case 'terminal.output': {
        const pre = run && [...run.tools.values()].reverse().find((n) => n.classList.contains('allowed') || n.classList.contains('running'));
        if (pre) {
          const r = pre.querySelector('.result');
          r.textContent = (r.textContent + ev.chunk).slice(-8000);
          pre.open = true;
        }
        break;
      }
      case 'run.finished': {
        run.root.querySelectorAll('.caret').forEach((c) => c.remove());
        run.root.querySelectorAll('.tool.running').forEach((t) => t.classList.replace('running', 'done'));
        const usage = ev.usage ? ` · ${fmt(ev.usage.inputTokens)} in / ${fmt(ev.usage.outputTokens)} out tokens${ev.usage.costUsd ? ` · $${ev.usage.costUsd.toFixed(4)}` : ''}` : '';
        const cls = ev.status === 'done' ? 'ok' : ev.status === 'cancelled' ? 'info' : 'error';
        run.root.appendChild(el('div', `status ${cls}`, `${ev.status === 'done' ? '✓ Done' : ev.status === 'cancelled' ? '■ Stopped' : '✗ Failed'}${esc(ev.status === 'error' ? `: ${ev.message ?? ''}` : '')}${usage}`));
        currentRunId = null;
        break;
      }
    }
    scroll();
  }

  // ---- context budget meter & manifest ----------------------------------------------
  function renderBudget() {
    const limit = manifest?.budget.limit ?? state.budget ?? 6000;
    const ex = manifest ? manifest.budget.explicit : explicit.tokens;
    const retrieved = manifest?.budget.retrieved ?? 0;
    const used = ex + retrieved;
    const pct = (n) => Math.min(100, (100 * n) / Math.max(limit, 1));
    $('budget').innerHTML = `
      <div class="meter-head"><span>Context budget</span><span class="${used > limit ? 'over' : ''}">${fmt(used)} / ${fmt(limit)} tokens</span></div>
      <div class="meter"><div class="seg explicit" style="width:${pct(ex)}%" title="explicit @file/@symbol: ${fmt(ex)}"></div><div class="seg retrieved" style="width:${pct(retrieved)}%" title="retrieved: ${fmt(retrieved)}"></div></div>
      <div class="legend"><span><i class="dot explicit"></i>explicit ${fmt(ex)}</span><span><i class="dot retrieved"></i>retrieved ${fmt(retrieved)}</span>${manifest ? `<span>${manifest.filesSelected}/${manifest.filesConsidered} files</span>` : ''}</div>
      ${explicit.items.length ? `<div class="explicit-list">${explicit.items.map((i) => `<span class="chip" title="${esc(i.path)} L${i.startLine}-${i.endLine}">${esc(i.mention)} · ${fmt(i.tokens)}</span>`).join('')}</div>` : ''}`;
  }

  function manifestCard(m) {
    const card = el('details', 'manifest');
    card.open = true;
    const bar = (v) => `<span class="sbar"><span style="width:${Math.round(v * 100)}%"></span></span>`;
    card.innerHTML = `
      <summary><strong>ContextManifest</strong> · ${fmt(m.budget.used)} / ${fmt(m.budget.limit)} tokens · selected ${m.filesSelected} of ${m.filesConsidered} files considered · ${m.elapsedMs}ms</summary>
      <div class="strategy">${esc(m.strategy)}</div>
      ${m.selected
        .map(
          (f) => `<div class="mf">
            <div class="mf-head"><a href="#" data-path="${esc(f.path)}" data-line="${f.chunks[0]?.startLine ?? 1}">${esc(f.path)}</a><span class="muted">${fmt(f.tokens)} tok · ${f.mode} · ${f.score.toFixed(2)}</span></div>
            <div class="reason">${esc(f.reason)}</div>
            <div class="scores" title="score components of the best chunk">sym ${bar(f.components.symbol)} bm25 ${bar(f.components.bm25)} path ${bar(f.components.path)}</div>
            <div class="chunks">${f.chunks.map((c) => `<span class="chunk ${c.mode}" title="${esc(c.kind)} · ${c.tokens} tokens · score ${c.score}">${esc(c.name)} <span class="muted">L${c.startLine}-${c.endLine}${c.mode === 'signature' ? ' sig' : ''}</span></span>`).join('')}</div>
          </div>`,
        )
        .join('')}
      ${m.candidates.filter((c) => !c.selected).length ? `<details class="sub"><summary>considered, not selected (${m.candidates.filter((c) => !c.selected).length})</summary>${m.candidates.filter((c) => !c.selected).map((c) => `<div class="cand">${esc(c.path)} <span class="muted">${c.score.toFixed(2)}</span></div>`).join('')}</details>` : ''}
      ${m.pruned.length ? `<details class="sub"><summary>pruned (${m.pruned.length})</summary>${m.pruned.map((p) => `<div class="cand">${esc(p.path)}${p.chunk ? ` :: ${esc(p.chunk)}` : ''} <span class="muted">${esc(p.reason)}</span></div>`).join('')}</details>` : ''}`;
    card.querySelectorAll('a[data-path]').forEach((a) => (a.onclick = (e) => (e.preventDefault(), post({ type: 'openFile', path: a.dataset.path, line: Number(a.dataset.line) }))));
    return card;
  }

  // ---- pending hunks & approvals ---------------------------------------------------
  function renderReviews() {
    const box = $('reviews');
    const reviews = state.reviews || [];
    if (!reviews.length) {
      box.innerHTML = '';
      return;
    }
    const pendingTotal = reviews.reduce((n, r) => n + r.hunks.filter((h) => h.status === 'pending').length, 0);
    box.innerHTML = `<div class="rv-head"><span class="rv-title"><strong>Pending review</strong> <span class="muted">· ${pendingTotal} hunk(s) in ${reviews.length} file(s)</span></span>
        <span class="spacer"></span><span class="rv-actions"><button class="mini ok" data-all="accept">✓ Accept all</button><button class="mini no" data-all="reject">✗ Reject all</button></span></div>
      ${reviews
        .map(
          (r) => `<div class="rv">
          <div class="rv-file"><a href="#" data-jump="${esc(r.editId)}">${esc(r.path)}</a>${r.isNewFile ? '<span class="badge">new file</span>' : ''}
            <span class="spacer"></span><button class="mini ok" data-file="accept" data-edit="${esc(r.editId)}">✓ File</button><button class="mini no" data-file="reject" data-edit="${esc(r.editId)}">✗ File</button></div>
          <div class="rv-desc">${esc(r.description)}</div>
          ${r.hunks
            .map(
              (h) => `<div class="hk ${h.status}">
              <a href="#" data-jump="${esc(r.editId)}" data-hunk="${esc(h.id)}">#${h.index + 1} · L${h.line}</a>
              <span class="add">+${h.added}</span><span class="del">−${h.removed}</span>
              <span class="pv">${esc(h.preview)}</span>
              ${h.status === 'pending' ? `<button class="mini ok" data-hunk-act="accept" data-edit="${esc(r.editId)}" data-hunk="${esc(h.id)}">✓</button><button class="mini no" data-hunk-act="reject" data-edit="${esc(r.editId)}" data-hunk="${esc(h.id)}">✗</button>` : `<span class="muted">${h.status}</span>`}
            </div>`,
            )
            .join('')}
        </div>`,
        )
        .join('')}`;
    box.querySelectorAll('[data-all]').forEach((b) => (b.onclick = () => post({ type: 'all', action: b.dataset.all })));
    box.querySelectorAll('[data-file]').forEach((b) => (b.onclick = () => post({ type: 'file', action: b.dataset.file, editId: b.dataset.edit })));
    box.querySelectorAll('[data-hunk-act]').forEach((b) => (b.onclick = () => post({ type: 'hunk', action: b.dataset.hunkAct, editId: b.dataset.edit, hunkId: b.dataset.hunk })));
    box.querySelectorAll('[data-jump]').forEach((a) => (a.onclick = (e) => (e.preventDefault(), post({ type: 'jump', editId: a.dataset.jump, hunkId: a.dataset.hunk }))));
  }

  function renderApprovals() {
    const box = $('approvals');
    const list = state.approvals || [];
    box.innerHTML = list
      .map((a) =>
        a.kind === 'question'
          ? `<div class="approval"><div><strong>The agent asks</strong> · ${esc(a.title)}</div>
        <div class="row">${(a.options || []).map((o, i) => `<button class="mini" data-q="${esc(a.id)}" data-opt="${i}">${esc(o)}</button>`).join('')}</div>
        <div class="row answer"><input type="text" data-qtext="${esc(a.id)}" placeholder="Type an answer…"><button class="mini ok" data-qsend="${esc(a.id)}">Send</button><button class="mini no" data-ap="${esc(a.id)}" data-allow="0">Skip</button></div></div>`
          : `<div class="approval"><div><strong>Approval required</strong> · ${esc(a.title)}</div><div class="muted">${esc(a.detail)}</div>
        <div class="row"><button class="mini ok" data-ap="${esc(a.id)}" data-allow="1">Allow</button><button class="mini no" data-ap="${esc(a.id)}" data-allow="0">Deny</button></div></div>`,
      )
      .join('');
    box.querySelectorAll('[data-ap]').forEach((b) => (b.onclick = () => post({ type: 'approval', id: b.dataset.ap, allow: b.dataset.allow === '1' })));
    box.querySelectorAll('[data-q]').forEach((b) => {
      const q = list.find((a) => a.id === b.dataset.q);
      b.onclick = () => post({ type: 'answer', id: b.dataset.q, text: q.options[Number(b.dataset.opt)] });
    });
    const sendText = (id) => {
      const input = box.querySelector(`[data-qtext="${id}"]`);
      if (input && input.value.trim()) post({ type: 'answer', id, text: input.value.trim() });
    };
    box.querySelectorAll('[data-qsend]').forEach((b) => (b.onclick = () => sendText(b.dataset.qsend)));
    box.querySelectorAll('[data-qtext]').forEach((i) => (i.onkeydown = (e) => e.key === 'Enter' && sendText(i.dataset.qtext)));
  }

  // ---- state -------------------------------------------------------------------------
  function renderState() {
    $('send').hidden = state.running;
    $('stop').hidden = !state.running;
    input.disabled = false;
    $('undo').disabled = !state.undo?.canUndo;
    $('undo').title = state.undo?.label ? `Undo: ${state.undo.label}` : 'ForgeCode: Undo Last Agent Edit';
    $('redo').disabled = !state.undo?.canRedo;
    const h = state.health || {};
    $('health').innerHTML = `<span class="hl ${h.trueforge === 'up' ? 'up' : h.trueforge === 'down' ? 'down' : ''}" title="${esc(h.trueforgeUrl)}">TrueForge</span><span class="hl ${h.mcpSessions > 0 ? 'up' : ''}" title="${esc(h.mcpUrl)} · ${h.mcpSessions ?? 0} MCP session(s)">MCP</span><span class="muted" title="indexed files">${fmt(h.indexFiles)} files</span>`;
    const models = state.models || {};
    const options = [`<option value="">${esc(models.primary ? `${models.primary} (primary)` : 'primary model')}</option>`]
      .concat((models.available || []).filter((m) => m !== models.primary).map((m) => `<option value="${esc(m)}" ${m === models.selected ? 'selected' : ''}>${esc(m)}${m === models.fallback ? ' (fallback)' : ''}</option>`))
      .join('');
    const select = $('model');
    if (select.innerHTML !== options) select.innerHTML = options;
    select.title = `Primary: ${models.primary ?? '—'} · Fallback: ${models.fallback ?? 'none'}${state.activeModel ? ` · Running on ${state.activeModel}` : ''}`;
    const sess = $('session');
    sess.textContent = state.session ? `session ${state.session.id.slice(0, 10)}… ↗` : 'no session';
    sess.disabled = !state.session;
    if (state.manifest && !manifest) manifest = state.manifest;
    if (!state.budget) state.budget = 6000;
    renderBudget();
    renderReviews();
    renderApprovals();
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'event') onEvent(msg.event);
    else if (msg.type === 'state') {
      state = msg.state;
      renderState();
    } else if (msg.type === 'suggestions') {
      if (msg.requestId !== suggestRequest) return;
      const m = mentionAtCaret();
      if (m) showSuggest(msg.items, m);
    } else if (msg.type === 'cleared') {
      runs.clear();
      manifest = null;
      explicit = { tokens: 0, items: [] };
      log.innerHTML = '<div class="empty">New chat. The next message starts a fresh TrueForge session.</div>';
      renderBudget();
    }
  });

  renderBudget();
  post({ type: 'ready' });
})();
