import { defineConfig } from 'vitest/config';

/**
 * Bound the local worker pool.
 *
 * The suite drives production-scale ingestion fixtures (see
 * `docs/197-ingestion-resource-bounds.md`), and `test/` has no config, so the
 * default forks pool sizes itself to the CPU count while every forked worker
 * inherits Node's multi-gigabyte V8 heap default. On a 10-core machine a full
 * `npm test` therefore holds ten ~4 GB processes at once, and a worker stranded
 * by a killed orchestrator climbs to that ceiling instead of failing.
 *
 * Four forks with a 1 GB heap each keeps a full run inside a few gigabytes
 * (measured peak 1.15 GB vs 2.35 GB unbounded) with the suite green and no
 * wall-clock cost, and strands exit at ~1.2 GB within seconds.
 */
export default defineConfig({
  test: {
    pool: 'forks',
    maxWorkers: 4,
    poolOptions: {
      forks: { execArgv: ['--max-old-space-size=1024'] },
    },
  },
});
