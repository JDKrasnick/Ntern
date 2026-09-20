import { reviewedAshbySources, type ReviewedAshbySource } from './sources/ashby-config.js';
import { isProviderSourceDue, SOURCE_POLL_CADENCE } from './source-poll-cadence.js';
import type { SourceCheckpoint, SourceHealth } from './types.js';

export const ASHBY_POLL_INTERVAL_MS = SOURCE_POLL_CADENCE.publishedIntervalMs;
export const ASHBY_SHADOW_POLL_INTERVAL_MS = SOURCE_POLL_CADENCE.shadowIntervalMs;
export interface AshbyWorkMessage { version: 1; sourceId: string; scheduledAt: string; runId?: string; force?: boolean; }
export function ashbyWorkMessages(sources: ReviewedAshbySource[] = reviewedAshbySources, scheduledAt = new Date(), runId?: string, recoveryProbeSourceIds = new Set<string>()): AshbyWorkMessage[] {
  return sources.map((source) => ({ version: 1, sourceId: source.id, scheduledAt: scheduledAt.toISOString(), ...(runId ? { runId } : {}), ...(recoveryProbeSourceIds.has(source.id) ? { force: true } : {}) }));
}
export function isAshbySourceDue(source: ReviewedAshbySource, checkpoint: SourceCheckpoint | undefined, now: Date, health?: SourceHealth): boolean {
  return isProviderSourceDue(source.id, source.status, checkpoint, now, health);
}
