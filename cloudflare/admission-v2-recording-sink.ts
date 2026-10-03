import type { AdmissionCatalogCommit, AdmissionV2CatalogSink } from '../src/ingestion-v2/admission/evaluator.js';
import type { D1Database } from './types.js';

/** Durable, non-publishing Stage 2 canary receipt. */
export class D1RecordingAdmissionV2CatalogSink implements AdmissionV2CatalogSink {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async commit(input: AdmissionCatalogCommit): Promise<void> {
    const recordedAt = this.now().toISOString();
    await this.db.prepare(`
      INSERT INTO ingestion_v2_admission_decisions
        (source_id, external_id, admission_version, job_id, notify, catalog_eligible,
         alert_eligible, reason_codes, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, external_id, admission_version) DO UPDATE SET
        job_id = excluded.job_id,
        notify = ingestion_v2_admission_decisions.notify OR excluded.notify,
        catalog_eligible = excluded.catalog_eligible,
        alert_eligible = excluded.alert_eligible,
        reason_codes = excluded.reason_codes,
        recorded_at = excluded.recorded_at
    `).bind(
      input.sourceId,
      input.externalId,
      input.admissionVersion,
      input.jobId,
      input.notify ? 1 : 0,
      input.admission.catalogEligible ? 1 : 0,
      input.admission.alertEligible ? 1 : 0,
      JSON.stringify(input.admission.reasonCodes),
      recordedAt,
    ).run();
  }
}
