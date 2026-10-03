import type { AdmissionCatalogCommit, AdmissionV2CatalogSink } from './evaluator.js';

/**
 * Verification/canary sink. It records the decision an admitted row would have
 * published without touching the live catalog, so a controlled non-publishing
 * canary can compare V2 decisions with legacy decisions.
 */
export class RecordingAdmissionV2CatalogSink implements AdmissionV2CatalogSink {
  private readonly recorded: AdmissionCatalogCommit[] = [];

  async commit(input: AdmissionCatalogCommit): Promise<void> {
    this.recorded.push(input);
  }

  records(): readonly AdmissionCatalogCommit[] {
    return this.recorded;
  }

  /** Only the commits that would have minted a new-role notification. */
  notifications(): readonly AdmissionCatalogCommit[] {
    return this.recorded.filter((commit) => commit.notify);
  }

  clear(): void {
    this.recorded.length = 0;
  }
}
