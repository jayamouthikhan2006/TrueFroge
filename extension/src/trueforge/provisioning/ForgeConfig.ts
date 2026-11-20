import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { type Env, expandDeep, MissingVariableError } from './env';

// ---- TrueForge wire types (snake_case, as accepted by /api/v1) -------------

export type ToolSelector = '@all' | '@read-only' | string;
export type ApprovalSelector = '@all' | '@write' | '@destructive' | string;

export interface WireMcpServerRef {
  name: string;
  preload?: boolean;
  enable_tools?: ToolSelector[];
  disable_tools?: ToolSelector[];
  preload_tools?: ToolSelector[];
  require_approval_for_tools?: ApprovalSelector[];
}

export interface WireAgentManifest {
  model: { name: string; params?: Record<string, unknown> };
  instructions?: string;
  mcp_servers?: WireMcpServerRef[];
  skills?: Array<{ name: string; preload?: boolean }>;
  config?: Record<string, unknown>;
}

export interface WireAgentDefinition {
  name: string;
  description: string;
  manifest: WireAgentManifest;
}

export interface WireModelEntry {
  model_id: string;
  name: string;
  properties: {
    context_length?: number;
    max_output_tokens?: number;
    reasoning_efforts?: string[];
  };
}

export interface WireModelProviderManifest {
  type: string;
  name?: string;
  base_url?: string;
  auth?: { api_key: string };
  models: WireModelEntry[];
}

export interface WireMcpServerManifest {
  type: 'remote';
  name: string;
  url: string;
  description: string;
  auth?: { type: 'header'; headers: Record<string, string> };
}

// ---- Loaded configuration ----------------------------------------------------

export type ModelRole = 'primary' | 'fallback';

export interface ResolvedProvider {
  role: ModelRole;
  providerName: string;
  manifest: WireModelProviderManifest;
  /** `<provider>/<model>` reference for the first model in the entry. */
  modelRef: string;
}

export interface SkippedProvider {
  role: string;
  reason: string;
}

export interface SkillPack {
  name: string;
  description: string;
  /** Markdown body without the front matter. */
  body: string;
  /** Path relative to the config dir, e.g. `skills/flask-contributor`. */
  relativeDir: string;
}

export interface ForgeConfig {
  configDir: string;
  agent: WireAgentDefinition;
  instructionsTemplate: string;
  providers: ResolvedProvider[];
  skippedProviders: SkippedProvider[];
  models: Partial<Record<ModelRole, string>>;
  mcpServers: Array<{ manifest: WireMcpServerManifest; bearerToken?: string }>;
  skills: SkillPack[];
}

interface RawAgentDefinition extends WireAgentDefinition {
  'x-forgecode'?: { instructions_file?: string; skills_dir?: string };
}

interface RawProvider {
  role?: string;
  type?: string;
  name?: string;
  base_url?: string;
  api_key?: string;
  models?: Array<Record<string, unknown>>;
}

interface RawMcpServer {
  name?: string;
  type?: string;
  url?: string;
  description?: string;
  bearer_token?: string;
}

interface RawCatalog {
  model_providers?: RawProvider[];
  mcp_servers?: RawMcpServer[];
}

const KEYLESS_PROVIDER_TYPES = new Set(['truefoundry']);
const NAMED_PROVIDER_TYPES = new Set(['custom']);

export function loadForgeConfig(configDir: string, env: Env): ForgeConfig {
  const dir = resolve(configDir);
  const agentPath = join(dir, 'agent-definition.json');
  const catalogPath = join(dir, 'catalog.yaml');
  if (!existsSync(agentPath)) {
    throw new Error(`agent definition not found: ${agentPath}`);
  }
  if (!existsSync(catalogPath)) {
    throw new Error(`catalog not found: ${catalogPath}`);
  }

  const rawAgent = JSON.parse(readFileSync(agentPath, 'utf8')) as RawAgentDefinition;
  const meta = rawAgent['x-forgecode'] ?? {};
  const instructionsTemplate = meta.instructions_file
    ? readFileSync(join(dir, meta.instructions_file), 'utf8')
    : rawAgent.manifest.instructions ?? '';
  const agent: WireAgentDefinition = {
    name: rawAgent.name,
    description: rawAgent.description,
    manifest: rawAgent.manifest,
  };

  const catalog = (parseYaml(readFileSync(catalogPath, 'utf8')) ?? {}) as RawCatalog;
  const providers: ResolvedProvider[] = [];
  const skippedProviders: SkippedProvider[] = [];
  for (const raw of catalog.model_providers ?? []) {
    const role = raw.role ?? '(unnamed)';
    try {
      const resolved = resolveProvider(expandDeep(raw, env));
      providers.push(resolved);
    } catch (error) {
      const reason = error instanceof MissingVariableError ? `${error.variable} is not set` : (error as Error).message;
      skippedProviders.push({ role, reason });
    }
  }
  assertNoProviderCollisions(providers);

  const models: Partial<Record<ModelRole, string>> = {};
  for (const provider of providers) {
    models[provider.role] ??= provider.modelRef;
  }

  const mcpServers: ForgeConfig['mcpServers'] = [];
  for (const raw of catalog.mcp_servers ?? []) {
    const expanded = expandDeep({ ...raw, bearer_token: undefined }, env);
    let bearerToken: string | undefined;
    if (raw.bearer_token) {
      try {
        bearerToken = expandDeep(raw.bearer_token, env);
      } catch (error) {
        if (!(error instanceof MissingVariableError)) {
          throw error;
        }
      }
    }
    if (!expanded.name || !expanded.url) {
      throw new Error('catalog.yaml: every mcp_servers entry needs name and url');
    }
    mcpServers.push({
      manifest: {
        type: 'remote',
        name: expanded.name,
        url: expanded.url,
        description: (expanded.description ?? expanded.name).trim(),
      },
      bearerToken,
    });
  }

  const skills = loadSkills(join(dir, meta.skills_dir ?? 'skills'), meta.skills_dir ?? 'skills');

  return { configDir: dir, agent, instructionsTemplate, providers, skippedProviders, models, mcpServers, skills };
}

function resolveProvider(raw: RawProvider): ResolvedProvider {
  if (raw.role !== 'primary' && raw.role !== 'fallback') {
    throw new Error(`role must be "primary" or "fallback" (got ${raw.role ?? 'nothing'})`);
  }
  const type = raw.type?.trim();
  if (!type) {
    throw new Error('provider type is empty');
  }
  const named = NAMED_PROVIDER_TYPES.has(type);
  const providerName = named ? raw.name?.trim() : type;
  if (!providerName) {
    throw new Error(`provider of type ${type} needs a name`);
  }
  const models = (raw.models ?? []).map(toModelEntry);
  if (models.length === 0) {
    throw new Error('provider has no models');
  }
  const manifest: WireModelProviderManifest = { type, models };
  if (named) {
    manifest.name = providerName;
  }
  const baseUrl = raw.base_url?.trim();
  if (baseUrl) {
    manifest.base_url = baseUrl;
  } else if (named || type === 'truefoundry') {
    throw new Error(`provider of type ${type} needs base_url`);
  }
  const apiKey = raw.api_key?.trim();
  if (apiKey) {
    manifest.auth = { api_key: apiKey };
  } else if (!KEYLESS_PROVIDER_TYPES.has(type)) {
    throw new Error('api_key is empty');
  }
  return { role: raw.role, providerName, manifest, modelRef: `${providerName}/${models[0]!.name}` };
}

function toModelEntry(raw: Record<string, unknown>): WireModelEntry {
  const name = String(raw.name ?? '').trim();
  const modelId = String(raw.model_id ?? '').trim();
  if (!/^[a-z][a-z0-9-]{0,62}[a-z0-9]$/.test(name)) {
    throw new Error(`model name "${name}" must match ^[a-z][a-z0-9-]{0,62}[a-z0-9]$`);
  }
  if (!modelId) {
    throw new Error(`model ${name} has an empty model_id`);
  }
  const properties: WireModelEntry['properties'] = {};
  const contextLength = toPositiveInt(raw.context_length);
  if (contextLength !== undefined) {
    properties.context_length = contextLength;
  }
  const maxOutput = toPositiveInt(raw.max_output_tokens);
  if (maxOutput !== undefined) {
    properties.max_output_tokens = maxOutput;
  }
  const efforts = toList(raw.reasoning_efforts);
  if (efforts.length > 0) {
    properties.reasoning_efforts = efforts;
  }
  return { model_id: modelId, name, properties };
}

function toPositiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`expected a positive integer, got ${String(value)}`);
  }
  return n;
}

function toList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

function assertNoProviderCollisions(providers: ResolvedProvider[]): void {
  const byName = new Map<string, ResolvedProvider>();
  for (const provider of providers) {
    const existing = byName.get(provider.providerName);
    if (!existing) {
      byName.set(provider.providerName, provider);
      continue;
    }
    const sameEndpoint =
      existing.manifest.base_url === provider.manifest.base_url && existing.manifest.auth?.api_key === provider.manifest.auth?.api_key;
    if (!sameEndpoint) {
      throw new Error(
        `primary and fallback both map to provider "${provider.providerName}" with different endpoints or keys; ` +
          'TrueForge names built-in providers after their type, so use type "custom" with distinct names for one of them',
      );
    }
    // Same endpoint: merge model lists into the first entry so both refs resolve.
    for (const model of provider.manifest.models) {
      if (!existing.manifest.models.some((m) => m.name === model.name)) {
        existing.manifest.models.push(model);
      }
    }
  }
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseSkill(text: string, relativeDir: string): SkillPack {
  const match = FRONT_MATTER.exec(text);
  if (!match) {
    throw new Error(`${relativeDir}/SKILL.md has no YAML front matter`);
  }
  const meta = (parseYaml(match[1]!) ?? {}) as { name?: unknown; description?: unknown };
  const name = typeof meta.name === 'string' ? meta.name.trim() : '';
  const description = typeof meta.description === 'string' ? meta.description.trim() : '';
  if (!name || !description) {
    throw new Error(`${relativeDir}/SKILL.md front matter needs name and description`);
  }
  return { name, description, body: text.slice(match[0].length).trim(), relativeDir };
}

function loadSkills(skillsDir: string, relativeRoot: string): SkillPack[] {
  if (!existsSync(skillsDir)) {
    return [];
  }
  const skills: SkillPack[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = join(skillsDir, entry.name, 'SKILL.md');
    if (existsSync(file)) {
      skills.push(parseSkill(readFileSync(file, 'utf8'), `${relativeRoot}/${entry.name}`));
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function renderInstructions(template: string, skills: SkillPack[], nativeSkills: boolean): string {
  const index =
    skills.length === 0
      ? '(no skill packs are installed)'
      : skills
          .map((skill) => `- \`${skill.name}\`: ${skill.description}`)
          .join('\n') +
        (nativeSkills
          ? '\n\nThese packs are also registered as TrueForge skills; `load_skill` returns the same content.'
          : '');
  return template.replace('{{SKILL_INDEX}}', index);
}
