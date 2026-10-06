import type { D1Database } from './types.js';

export async function billingStopped(db: D1Database): Promise<boolean> {
  const state = await db.prepare("SELECT value FROM system_state WHERE key = 'billing_shutdown'").first<{ value: string }>();
  return state?.value === 'stopped';
}

export function isolationEnabled(env: { INGESTION_V2_ISOLATED_WORKERS_ENABLED?: string }): boolean {
  return env.INGESTION_V2_ISOLATED_WORKERS_ENABLED === 'true';
}
