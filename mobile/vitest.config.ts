import { defineConfig } from 'vitest/config';

/**
 * A mobile-local config keeps `vitest` run from `mobile/` from walking up to the
 * repository-root `vitest.config.ts`, which is tuned for the production-scale
 * ingestion suite and resolves `vitest` from root dependencies the mobile CI job
 * does not install. Mobile's suite is small and needs no pool tuning.
 */
export default defineConfig({});
