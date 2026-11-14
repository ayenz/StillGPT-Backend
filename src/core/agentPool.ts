import { eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { kv, qoderAgents } from '../db/schema.js';
import type { Logger } from '../log.js';
import type { QoderClient } from '../qoder/client.js';
import { PROFILES, type ProfileName } from './profiles.js';

const ENV_KEY = 'qoder.environment_id';
const ENV_NAME = 'stillgpt';
/** Model an agent is created with; sessions patch to the resolved model when it differs. */
export const AGENT_BASE_MODEL = 'efficient';

/**
 * Lazily creates (and caches in DB) the Qoder environment and one agent per profile.
 * If the stored agent's tool set no longer matches the profile definition, a fresh agent is created
 * — so changing PROFILES in code rolls out automatically to new sessions.
 */
export class AgentPool {
  private envId?: string;
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly db: DB,
    private readonly qoder: QoderClient,
    private readonly log: Logger,
    private readonly configuredEnvId?: string,
  ) {}

  async environmentId(): Promise<string> {
    if (this.envId) return this.envId;
    if (this.configuredEnvId) return (this.envId = this.configuredEnvId);
    return this.once('env', async () => {
      const [row] = await this.db.select().from(kv).where(eq(kv.key, ENV_KEY));
      if (row) return (this.envId = row.value as string);
      const existing = (await this.qoder.listEnvironments()).find((e) => e.name === ENV_NAME);
      const id = existing?.id ?? (await this.qoder.createEnvironment(ENV_NAME)).id;
      await this.db.insert(kv).values({ key: ENV_KEY, value: id }).onConflictDoUpdate({ target: kv.key, set: { value: id, updatedAt: new Date() } });
      this.log.info('qoder.environment.ready', { id, reused: !!existing });
      return (this.envId = id);
    });
  }

  async agentId(profile: ProfileName): Promise<string> {
    const def = PROFILES[profile];
    return this.once(`agent:${profile}`, async () => {
      const [row] = await this.db.select().from(qoderAgents).where(eq(qoderAgents.profile, profile));
      if (row && sameTools(row.tools, def.tools)) return row.agentId;
      const agent = await this.qoder.createAgent({
        name: `qr-${profile}`,
        model: AGENT_BASE_MODEL,
        system: def.system,
        tools: def.tools.length ? [{ type: 'agent_toolset_20260401', enabled_tools: def.tools }] : [],
        metadata: { app: 'stillgpt', profile },
      });
      await this.db
        .insert(qoderAgents)
        .values({ profile, agentId: agent.id, model: AGENT_BASE_MODEL, tools: def.tools })
        .onConflictDoUpdate({ target: qoderAgents.profile, set: { agentId: agent.id, model: AGENT_BASE_MODEL, tools: def.tools, createdAt: new Date() } });
      if (row) this.qoder.archiveAgent(row.agentId).catch((err) => this.log.warn('qoder.agent.archive_failed', { err }));
      this.log.info('qoder.agent.created', { profile, agentId: agent.id });
      return agent.id;
    });
  }

  /** Forget cached ids (e.g. after an upstream 404 on the agent). */
  async invalidate(profile: ProfileName) {
    await this.db.delete(qoderAgents).where(eq(qoderAgents.profile, profile));
  }

  private once(key: string, fn: () => Promise<string>): Promise<string> {
    let p = this.inflight.get(key);
    if (!p) {
      p = fn().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }
}

const sameTools = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
