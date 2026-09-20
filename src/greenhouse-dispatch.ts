import { reviewedGreenhouseSources, type ReviewedGreenhouseSource } from './sources/greenhouse-config.js';
import { isProviderSourceDue, SOURCE_POLL_CADENCE } from './source-poll-cadence.js';
import type { SourceCheckpoint, SourceHealth } from './types.js';

export const GREENHOUSE_POLL_INTERVAL_MS = SOURCE_POLL_CADENCE.publishedIntervalMs;
export const GREENHOUSE_SHADOW_POLL_INTERVAL_MS = SOURCE_POLL_CADENCE.shadowIntervalMs;
export interface GreenhouseWorkMessage { version: 1; sourceId: string; scheduledAt: string; force?: boolean; }
export function greenhouseWorkMessages(sources: ReviewedGreenhouseSource[] = reviewedGreenhouseSources, scheduledAt = new Date(), recoveryProbeSourceIds = new Set<string>()): GreenhouseWorkMessage[] {
  return sources.map((source) => ({ version: 1, sourceId: source.id, scheduledAt: scheduledAt.toISOString(), ...(recoveryProbeSourceIds.has(source.id) ? { force: true } : {}) }));
}
export function isGreenhouseSourceDue(source: ReviewedGreenhouseSource, checkpoint: SourceCheckpoint | undefined, now: Date, health?: SourceHealth): boolean {
  return isProviderSourceDue(source.id, source.status, checkpoint, now, health);
}
