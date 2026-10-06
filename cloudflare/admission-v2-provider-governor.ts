import type { D1Database } from './types.js';
import { AdmissionInfrastructureError } from '../src/ingestion-v2/admission/taxonomy.js';

export type AdmissionProviderKey = 'workable' | `workday:${string}`;
export interface AdmissionProviderGovernor {
  acquire(provider: AdmissionProviderKey): Promise<number>;
  defer(provider: AdmissionProviderKey, delayMs: number): Promise<void>;
}

/** Atomic permits and cooldowns shared across queue deliveries and isolates. */
export class D1AdmissionProviderGovernor implements AdmissionProviderGovernor {
  constructor(private readonly db: D1Database, private readonly now: () => Date = () => new Date()) {}
  async acquire(provider: AdmissionProviderKey): Promise<number> {
    const now = this.now().getTime();
    const key = `ingestion-v2:provider-cooldown:${provider}`;
    try {
      const permit = await this.db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        WHERE json_extract(system_state.value, '$.untilMs') <= ? RETURNING value`)
        .bind(key, JSON.stringify({ untilMs: now + 2_000 }), new Date(now).toISOString(), now).first();
      if (permit) return 0;
      const row = await this.db.prepare('SELECT value FROM system_state WHERE key = ?').bind(key).first<{ value: string }>();
      const until = row ? (JSON.parse(row.value) as { untilMs?: number }).untilMs : undefined;
      if (typeof until !== 'number' || !Number.isFinite(until)) throw new Error('Provider cooldown state is invalid');
      return Math.max(1_000, until - now);
    } catch (error) {
      throw new AdmissionInfrastructureError('d1-unavailable', error instanceof Error ? error.message : String(error));
    }
  }
  async defer(provider: AdmissionProviderKey, delayMs: number): Promise<void> {
    const now = this.now().getTime();
    const untilMs = now + Math.max(15 * 60_000, delayMs);
    if (!Number.isFinite(untilMs) || untilMs > 8.64e15) throw new AdmissionInfrastructureError('internal', 'Invalid provider cooldown');
    try {
      await this.db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        WHERE json_extract(system_state.value, '$.untilMs') < json_extract(excluded.value, '$.untilMs')`)
        .bind(`ingestion-v2:provider-cooldown:${provider}`, JSON.stringify({ untilMs }), new Date(now).toISOString()).run();
    } catch (error) {
      throw new AdmissionInfrastructureError('d1-unavailable', error instanceof Error ? error.message : String(error));
    }
  }
}
