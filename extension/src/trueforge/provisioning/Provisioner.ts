import type { Logger } from '../../util/log';
import { errorMessage } from '../../util/log';
import { TrueForgeHttpError, type TrueForgeRest } from '../rest';
import {
  type ForgeConfig,
  renderInstructions,
  type WireAgentDefinition,
  type WireAgentManifest,
  type WireMcpServerManifest,
} from './ForgeConfig';

interface CapabilitiesResponse {
  data: {
    skill?: { enabled: boolean; reason?: string };
    sandbox?: { enabled: boolean };
  };
}

interface AgentRecord {
  id: string;
  name: string;
  description: string;
  manifest: WireAgentManifest;
}

interface ListAgentsResponse {
  data: AgentRecord[];
}

interface ModelsResponse {
  data: Array<{ name: string }>;
}

export interface SkillsGitSource {
  url: string;
  ref: string;
  /** Path of the trueforge-config directory inside that repository. */
  configPathInRepo: string;
}

export interface ProvisionOptions {
  /** Overrides the MCP server URL/token from catalog.yaml (the extension passes its live values). */
  mcp?: { url: string; bearerToken: string };
  /** Overrides catalog models.primary for the agent's default model. */
  primaryModel?: string;
  /** When set and the server can run skills, SKILL.md packs are registered natively from git. */
  skillsGit?: SkillsGitSource;
  /** Register model providers from catalog.yaml (the CLI does; the extension leaves them alone). */
  registerProviders: boolean;
  /** Create or update the agent definition. */
  registerAgent: boolean;
}

export interface ProvisionReport {
  providers: Array<{ name: string; modelRef: string; role: string }>;
  skippedProviders: Array<{ role: string; reason: string }>;
  mcpServers: string[];
  nativeSkills: string[];
  skillsMode: 'native' | 'mcp';
  skillsNote?: string;
  agent?: { id: string; name: string; model: string; created: boolean };
  models: { primary?: string; fallback?: string };
  availableModels: string[];
}

export class Provisioner {
  constructor(
    private readonly rest: TrueForgeRest,
    private readonly log: Logger,
  ) {}

  async ping(): Promise<void> {
    await this.rest.request('GET', '/api/v1/capabilities');
  }

  async listModels(): Promise<string[]> {
    const response = await this.rest.request<ModelsResponse>('GET', '/api/v1/models');
    return response.data.map((m) => m.name);
  }

  async findAgent(name: string): Promise<AgentRecord | undefined> {
    const response = await this.rest.request<ListAgentsResponse>('GET', `/api/v1/agents?agent_name=${encodeURIComponent(name)}&limit=50`);
    return response.data.find((agent) => agent.name === name);
  }

  async registerMcpServer(manifest: WireMcpServerManifest, bearerToken: string | undefined): Promise<void> {
    const body: WireMcpServerManifest = { ...manifest };
    if (bearerToken) {
      body.auth = { type: 'header', headers: { Authorization: `Bearer ${bearerToken}` } };
    }
    try {
      await this.rest.request('PUT', '/api/v1/settings/mcp-servers', { manifest: body });
    } catch (error) {
      if (error instanceof TrueForgeHttpError && /Outbound URL blocked/i.test(error.message)) {
        throw new Error(
          `TrueForge refused ${manifest.url} (outbound URL guard). Restart TrueForge with ` +
            `OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' (scripts/setup-trueforge.sh --restart does this).`,
        );
      }
      throw error;
    }
    this.log.info(`registered MCP server ${manifest.name} -> ${manifest.url}`);
  }

  async provision(config: ForgeConfig, options: ProvisionOptions): Promise<ProvisionReport> {
    const report: ProvisionReport = {
      providers: [],
      skippedProviders: config.skippedProviders,
      mcpServers: [],
      nativeSkills: [],
      skillsMode: 'mcp',
      models: { ...config.models },
      availableModels: [],
    };

    if (options.registerProviders) {
      for (const provider of config.providers) {
        await this.rest.request('PUT', '/api/v1/settings/model-providers', { manifest: provider.manifest });
        report.providers.push({ name: provider.providerName, modelRef: provider.modelRef, role: provider.role });
        this.log.info(`registered model provider ${provider.providerName} (${provider.role}: ${provider.modelRef})`);
      }
      for (const skipped of config.skippedProviders) {
        this.log.warn(`skipped ${skipped.role} model provider: ${skipped.reason}`);
      }
    }

    for (const server of config.mcpServers) {
      const isWorkspace = options.mcp !== undefined && server.manifest.name === 'forgecode-workspace';
      const manifest = isWorkspace ? { ...server.manifest, url: options.mcp!.url } : server.manifest;
      const token = isWorkspace ? options.mcp!.bearerToken : server.bearerToken;
      await this.registerMcpServer(manifest, token);
      report.mcpServers.push(manifest.name);
    }

    if (options.skillsGit) {
      const capabilities = await this.rest.request<CapabilitiesResponse>('GET', '/api/v1/capabilities');
      if (capabilities.data.skill?.enabled) {
        for (const skill of config.skills) {
          await this.rest.request('PUT', '/api/v1/settings/skills', {
            manifest: {
              type: 'git',
              name: skill.name,
              url: options.skillsGit.url,
              ref: options.skillsGit.ref,
              path: `${options.skillsGit.configPathInRepo.replace(/\/+$/, '')}/${skill.relativeDir}`,
              description: skill.description,
            },
          });
          report.nativeSkills.push(skill.name);
        }
        report.skillsMode = 'native';
      } else {
        report.skillsNote = capabilities.data.skill?.reason ?? 'TrueForge reports skills as disabled';
        this.log.warn(`native TrueForge skills unavailable (${report.skillsNote}); serving SKILL.md packs through load_skill`);
      }
    }

    report.availableModels = await this.listModels().catch(() => []);

    if (options.registerAgent) {
      report.agent = await this.upsertAgent(config, options.primaryModel ?? config.models.primary, report.nativeSkills);
    }
    return report;
  }

  private async upsertAgent(config: ForgeConfig, primaryModel: string | undefined, nativeSkills: string[]): Promise<NonNullable<ProvisionReport['agent']>> {
    const existing = await this.findAgent(config.agent.name);
    const model = primaryModel || existing?.manifest.model.name;
    if (!model) {
      throw new Error(
        'No primary model is configured. Set FORGE_PRIMARY_* in .env and run scripts/setup-trueforge.sh, or set forgecode.models.primary.',
      );
    }
    const manifest: WireAgentManifest = structuredClone(config.agent.manifest);
    manifest.model = { ...manifest.model, name: model };
    manifest.instructions = renderInstructions(config.instructionsTemplate, config.skills, nativeSkills.length > 0);
    manifest.skills = nativeSkills.map((name) => ({ name, preload: false }));

    const definition: WireAgentDefinition = { name: config.agent.name, description: config.agent.description, manifest };
    try {
      if (existing) {
        await this.rest.request('PUT', `/api/v1/agents/${encodeURIComponent(existing.id)}`, {
          description: definition.description,
          manifest: definition.manifest,
        });
        this.log.info(`updated agent ${definition.name} (${existing.id}) on model ${model}`);
        return { id: existing.id, name: definition.name, model, created: false };
      }
      const created = await this.rest.request<{ data: AgentRecord }>('POST', '/api/v1/agents', definition);
      this.log.info(`created agent ${definition.name} (${created.data.id}) on model ${model}`);
      return { id: created.data.id, name: definition.name, model, created: true };
    } catch (error) {
      if (error instanceof TrueForgeHttpError && error.status === 400 && /model/i.test(error.message)) {
        throw new Error(`TrueForge rejected model "${model}": ${errorMessage(error)}. Registered models: ${(await this.listModels().catch(() => [])).join(', ') || 'none'}`);
      }
      throw error;
    }
  }
}
