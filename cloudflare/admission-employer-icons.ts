import { officialIconProvenance } from '../src/employer-icon-resolution.js';
import type { AdmissionCatalogCommit } from '../src/ingestion-v2/admission/evaluator.js';
import { validCompanyIconEmployerId } from './company-icon.js';
import { enqueueEmployerIconResolution } from './employer-icon-resolver.js';
import { D1EmployerIconStore } from './employer-icon-store.js';
import type { D1Database } from './types.js';

/** Register a reviewed official source's employer before its live catalog commit.
 * INSERT-only preserves every existing operator decision, ranking, and icon.
 * Called only by the catalog-owning sink, never by a shadow/canary evaluator.
 */
export async function registerAdmissionEmployer(db: D1Database, input: AdmissionCatalogCommit, now: Date): Promise<void> {
  const employer = input.admission.canonicalEmployer;
  if (!employer || !validCompanyIconEmployerId(employer.id)
    || input.listing.employerEvidence?.authority !== 'reviewed-registry'
    || !officialIconProvenance(input.listing.provenance)) return;
  const at = now.toISOString();
  await db.prepare(`INSERT INTO canonical_employers
    (id, display_name, reviewed_at, reviewed_by, created_at, updated_at)
    VALUES (?, ?, ?, 'reviewed-source-registry', ?, ?) ON CONFLICT(id) DO NOTHING`)
    .bind(employer.id, employer.displayName, at, at, at).run();
}

/** Best-effort enrichment after publication; backfill recovers a failed enqueue. */
export async function enqueueAdmissionEmployerIcon(db: D1Database, input: AdmissionCatalogCommit, now: Date): Promise<void> {
  const employer = input.admission.canonicalEmployer;
  if (!employer) return;
  const identity = input.listing.providerIdentity;
  try {
    await enqueueEmployerIconResolution(new D1EmployerIconStore(db), {
      canonicalEmployerId: employer.id, displayName: employer.displayName,
      roleTitle: input.listing.title, applicationUrl: input.listing.applyUrl,
      provider: identity?.provider ?? 'reviewed-registry',
      ...(identity?.tenant ? { tenant: identity.tenant } : {}),
      ...(input.listing.provenance ? { provenance: input.listing.provenance } : {}),
      sourceId: input.sourceId,
    }, now);
  } catch {
    console.warn(JSON.stringify({ event: 'company_icon_resolution_enqueue_failed', canonicalEmployerId: employer.id }));
  }
}
