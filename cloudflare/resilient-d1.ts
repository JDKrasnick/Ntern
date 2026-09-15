import { isRetryableD1Failure } from './d1-errors.js';
import type { D1Database, D1PreparedStatement } from './types.js';

// D1 drops connections and resets instances out from under in-flight
// statements: "this D1 DB instance is no longer active. Reconnect or retry the
// request." when it rotates mid-request, and "D1 DB reset because its code was
// updated." when a deploy lands. The remaining patterns are the same family:
// closed connections, lost network, reset storage. Cloudflare's guidance for
// this class of error is to retry: a fresh prepare/bind runs against the
// reconnected instance. Ingestion polls that hit this during persistence
// otherwise exhaust their two queue retries and dead-letter valid work (see
// issues #203 and #205). Classification is shared with worker.ts so the retry
// set is defined once (see d1-errors.ts).

async function withRetry<T>(operation: () => Promise<T>, options: ResilientOptions): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableD1Failure(error) || attempt === options.attempts - 1) throw error;
      // Exponential backoff keeps repeated reconnect attempts from piling onto
      // a rotating instance; jitter prevents queue consumers retrying in lockstep.
      await options.sleep(options.baseDelayMs * (2 ** attempt) * (0.5 + options.random()));
    }
  }
  throw lastError;
}

const BUILD = Symbol('resilient-d1-build');

interface ResilientOptions {
  attempts: number;
  baseDelayMs: number;
  random: () => number;
  sleep: (ms: number) => Promise<void>;
}

function wrapStatement(build: () => D1PreparedStatement, options: ResilientOptions): D1PreparedStatement {
  const statement = {
    [BUILD]: build,
    bind: (...values: unknown[]) => wrapStatement(() => build().bind(...values), options),
    first: <T,>() => withRetry(() => build().first<T>(), options),
    all: <T,>() => withRetry(() => build().all<T>(), options),
    run: () => withRetry(() => build().run(), options),
  };
  return statement as unknown as D1PreparedStatement;
}

function rebuild(statement: D1PreparedStatement): () => D1PreparedStatement {
  const build = (statement as unknown as { [BUILD]?: () => D1PreparedStatement })[BUILD];
  return build ?? (() => statement);
}

/**
 * Wraps a D1 binding so reads, writes, and batches retry the transient D1
 * instance failures classified as retryable (see d1-errors.ts): an instance
 * rotation, a deploy-time reset, or a lost connection that rejects an in-flight
 * statement. Each retry
 * rebuilds the statement so it runs against the reconnected instance.
 * Non-retryable errors propagate immediately and unchanged.
 *
 * Retrying writes is safe: these errors mean the instance rotated or was reset
 * before the statement committed (single statements autocommit; `batch` is
 * atomic), so a retried write never double-applies. Independently, the only
 * caller is the at-least-once queue consumer, whose whole batch already
 * re-runs every write on redelivery, so this in-request retry introduces no
 * duplication the pipeline does not already tolerate (ingestion writes upsert).
 */
export function resilientD1(
  db: D1Database,
  { attempts = 5, baseDelayMs = 50, random = Math.random,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) }: Partial<ResilientOptions> = {},
): D1Database {
  const options: ResilientOptions = { attempts, baseDelayMs, random, sleep };
  // Returns only prepare/batch because cloudflare/types.ts declares D1Database
  // with exactly those two members. A future interface method (exec, withSession,
  // raw, dump) would be silently undefined here unless added to this wrapper.
  return {
    prepare: (query) => wrapStatement(() => db.prepare(query), options),
    batch: (statements) => withRetry(() => db.batch(statements.map((statement) => rebuild(statement)())), options),
  };
}
