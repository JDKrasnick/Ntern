import { reviewedLeverSources, type ReviewedLeverSource } from './sources/lever-config.js';
import { isProviderSourceDue, SOURCE_POLL_CADENCE } from './source-poll-cadence.js';
import type { SourceCheckpoint, SourceHealth } from './types.js';

export const LEVER_POLL_INTERVAL_MS = SOURCE_POLL_CADENCE.publishedIntervalMs;
export const LEVER_SHADOW_POLL_INTERVAL_MS = SOURCE_POLL_CADENCE.shadowIntervalMs;
export interface LeverWorkMessage { version: 1; sourceId: string; scheduledAt: string; runId?: string; force?: boolean; }
export function leverWorkMessages(sources: ReviewedLeverSource[] = reviewedLeverSources, scheduledAt = new Date(), runId?: string, recoveryProbeSourceIds = new Set<string>()): LeverWorkMessage[] {
  return sources.map((source) => ({ version: 1, sourceId: source.id, scheduledAt: scheduledAt.toISOString(), ...(runId ? { runId } : {}), ...(recoveryProbeSourceIds.has(source.id) ? { force: true } : {}) }));
}
export function isLeverSourceDue(source: ReviewedLeverSource, checkpoint: SourceCheckpoint | undefined, now: Date, health?: SourceHealth): boolean {
  return isProviderSourceDue(source.id, source.status, checkpoint, now, health);
}
