import { JSONParser, TokenType } from '@streamparser/json';
import { snapshotHashForRows, snapshotHashForRowsAndAdmissionVersion, validateSnapshotHeader, validateSnapshotRow } from './normalize.js';
import type { NormalizedSnapshotRow } from './types.js';

export const SNAPSHOT_STREAM_MAX_BYTES = 64 * 1024 * 1024;
export const SNAPSHOT_STREAM_MAX_ROW_BYTES = 512 * 1024;
const maxRows = 50_000;
const maxHeaderBytes = 16 * 1024;
const headers = ['admissionVersion', 'documentCount', 'observedAt', 'rowCount', 'schemaVersion', 'snapshotHash', 'sourceId'];

/** Validate the complete immutable object before returning selected rows. No
 * posting can escape validation merely because its ID is absent from a batch. */
export async function readSnapshotRows(
  stream: ReadableStream<Uint8Array>, expected: { sourceId: string; snapshotHash: string }, selectedIds: readonly string[],
): Promise<{ rows: Map<string, NormalizedSnapshotRow>; bytes: number }> {
  if (selectedIds.length > 25) throw new Error('Ingestion snapshot selection exceeds admission batch limit');
  const selected = new Set(selectedIds);
  const rows = new Map<string, NormalizedSnapshotRow>();
  const metadata: Record<string, unknown> = {};
  const identities: Array<{ externalId: string; materialHash: string }> = [];
  const documents = new Set<string>();
  const keys = new Set<string>();
  const parser = new JSONParser({ paths: [...headers.map((key) => `$.${key}`), '$.rows.*'], keepStack: false,
    stringBufferSize: 16 * 1024, numberBufferSize: 64 });
  let depth = 0;
  let expectingKey = true;
  let awaitingValue = false;
  let topKey = '';
  let rowsSeen = false;
  let valueStart = 0;
  let rowStart: number | undefined;
  let bytes = 0;
  let previousId: string | undefined;
  parser.onToken = ({ token, value, offset }) => {
    if (depth === 0 && token !== TokenType.LEFT_BRACE && token !== TokenType.RIGHT_BRACE) throw new Error('Ingestion snapshot envelope is malformed');
    if (depth === 1 && token === TokenType.COMMA) expectingKey = true;
    if (depth === 1 && token === TokenType.STRING && expectingKey) {
      topKey = String(value);
      if (keys.has(topKey) || (topKey !== 'rows' && !headers.includes(topKey))) throw new Error('Ingestion snapshot header is duplicated or unsupported');
      keys.add(topKey); expectingKey = false;
    } else if (depth === 1 && token === TokenType.COLON) awaitingValue = true;
    else if (depth === 1 && awaitingValue) {
      awaitingValue = false; valueStart = offset;
      if (topKey === 'rows') {
        if (token !== TokenType.LEFT_BRACKET) throw new Error('Ingestion snapshot rows are missing');
        rowsSeen = true;
      } else if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) throw new Error('Ingestion snapshot header must be scalar');
    }
    if (topKey === 'rows' && depth === 2 && token !== TokenType.LEFT_BRACE && token !== TokenType.RIGHT_BRACKET && token !== TokenType.COMMA) throw new Error('Ingestion snapshot row must be an object');
    if (topKey === 'rows' && depth === 2 && token === TokenType.LEFT_BRACE) rowStart = offset;
    if (rowStart !== undefined && offset - rowStart > SNAPSHOT_STREAM_MAX_ROW_BYTES) throw new Error('Ingestion snapshot row exceeds byte limit');
    if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) depth += 1;
    if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) depth -= 1;
  };
  parser.onValue = ({ key, value, stack }) => {
    if (stack.length === 1 && typeof key === 'string') { metadata[key] = value; return; }
    if (stack.length !== 2 || stack[1]?.key !== 'rows') throw new Error('Ingestion snapshot row is malformed');
    if (identities.length >= maxRows) throw new Error('Ingestion snapshot exceeds row limit');
    validateSnapshotRow(value, expected.sourceId);
    if (previousId !== undefined && previousId.localeCompare(value.externalId) >= 0) throw new Error('Ingestion snapshot rows are not canonically ordered');
    previousId = value.externalId;
    identities.push({ externalId: value.externalId, materialHash: value.materialHash });
    documents.add(value.document);
    if (selected.has(value.externalId)) rows.set(value.externalId, value);
    rowStart = undefined;
  };
  const reader = stream.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (bytes + chunk.value.byteLength > SNAPSHOT_STREAM_MAX_BYTES) throw new Error('Ingestion snapshot exceeds byte limit');
      // Small feeds bound a partial string before its closing token arrives.
      for (let offset = 0; offset < chunk.value.length; offset += 8192) {
        const piece = chunk.value.subarray(offset, offset + 8192);
        parser.write(piece); bytes += piece.length;
        if (rowStart !== undefined && bytes - rowStart > SNAPSHOT_STREAM_MAX_ROW_BYTES) throw new Error('Ingestion snapshot row exceeds byte limit');
        if (depth > 0 && topKey !== 'rows' && bytes - valueStart > maxHeaderBytes) throw new Error('Ingestion snapshot header exceeds byte limit');
      }
    }
    if (!parser.isEnded) parser.end();
    if (!rowsSeen || !parser.isEnded) throw new Error('Ingestion snapshot is incomplete');
    validateSnapshotHeader(metadata, expected);
    if (metadata.rowCount !== identities.length) throw new Error('Ingestion snapshot row count mismatch');
    if (metadata.documentCount !== documents.size) throw new Error('Ingestion snapshot document count mismatch');
    const hash = metadata.schemaVersion === 1 ? snapshotHashForRows(identities)
      : snapshotHashForRowsAndAdmissionVersion(identities, metadata.admissionVersion);
    if (hash !== expected.snapshotHash) throw new Error('Ingestion snapshot hash mismatch');
    return { rows, bytes };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}
