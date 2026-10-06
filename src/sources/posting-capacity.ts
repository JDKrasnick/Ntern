import type { SourcedPosting } from '../types.js';
import { SNAPSHOT_STREAM_MAX_ROW_BYTES } from '../ingestion-v2/stream-snapshot.js';
import { snapshotPostingByteLength } from '../ingestion-v2/normalize.js';
import { SourceFetchError } from './source-error.js';

/** Bound the mapped posting before a provider reports a complete snapshot. */
export function assertPostingCapacity(posting: SourcedPosting): void {
  if (snapshotPostingByteLength(posting) > SNAPSHOT_STREAM_MAX_ROW_BYTES) {
    throw new SourceFetchError(`${posting.sourceId}: posting ${posting.externalId} exceeds snapshot row capacity`, 'capacity');
  }
}
