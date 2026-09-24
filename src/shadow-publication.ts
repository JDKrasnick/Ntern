import { createHash } from 'node:crypto';
import { boundedText, normalizeLocations } from './catalog-quality.js';
import type { CompensationPeriod, CompensationRange, RoleMetadataEvidence, WorkMode } from './types.js';
import type { ShadowExtraction, ShadowField } from './shadow-extraction.js';
import { prospectivePublicationFields } from './shadow-verification.js';

export const shadowPublicationFields = ['compensation', 'locations', 'workMode'] as const;
export type ShadowPublicationField = typeof shadowPublicationFields[number];

export interface ShadowPublicationCohortEntry {
  sourceId: string;
  externalId: string;
  contentHash: string;
}

export interface ShadowPublicationPolicy {
  version: string;
  enabled: boolean;
  allowedFields: ShadowPublicationField[];
  cohort: ShadowPublicationCohortEntry[];
  mode?: 'prospective-provider-poll';
  startsAt?: string;
  maxReceipts?: number;
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Parse the deployment variable defensively. Invalid and absent policies are
 * indistinguishable from disabled: no caller can accidentally enable a canary. */
export function parseShadowPublicationPolicy(raw: string | undefined): ShadowPublicationPolicy {
  if (!raw?.trim()) return { version: 'disabled', enabled: false, allowedFields: [], cohort: [] };
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.enabled !== true || typeof value.version !== 'string' || !value.version.trim()
      || !Array.isArray(value.allowedFields) || !Array.isArray(value.cohort)) throw new Error('invalid policy');
    const allowedFields = value.allowedFields.filter((field): field is ShadowPublicationField => typeof field === 'string' && (shadowPublicationFields as readonly string[]).includes(field));
    const cohort = value.cohort.filter((entry): entry is ShadowPublicationCohortEntry => isRecord(entry)
      && typeof entry.sourceId === 'string' && entry.sourceId.length > 0 && entry.sourceId.length <= 512
      && typeof entry.externalId === 'string' && entry.externalId.length > 0 && entry.externalId.length <= 512
      && isHash(entry.contentHash));
    if (value.mode === 'prospective-provider-poll') {
      const startsAt = typeof value.startsAt === 'string' ? value.startsAt : '';
      const date = new Date(startsAt);
      if (cohort.length || value.cohort.length || !allowedFields.length
        || allowedFields.some((field) => !prospectivePublicationFields.includes(field as typeof prospectivePublicationFields[number]))
        || allowedFields.length !== value.allowedFields.length || new Set(allowedFields).size !== allowedFields.length
        || !Number.isSafeInteger(value.maxReceipts) || Number(value.maxReceipts) < 1 || Number(value.maxReceipts) > 25
        || !Number.isFinite(date.getTime()) || date.toISOString() !== startsAt || raw.length > 100_000) throw new Error('invalid prospective policy');
      return { version: value.version.trim(), enabled: true, allowedFields, cohort: [], mode: 'prospective-provider-poll',
        startsAt, maxReceipts: Number(value.maxReceipts) };
    }
    if (value.mode !== undefined || value.startsAt !== undefined || value.maxReceipts !== undefined) throw new Error('invalid exact policy');
    if (!allowedFields.length || allowedFields.length !== value.allowedFields.length || cohort.length !== value.cohort.length
      || new Set(allowedFields).size !== allowedFields.length || new Set(cohort.map(entry => `${entry.sourceId}\0${entry.externalId}\0${entry.contentHash}`)).size !== cohort.length
      || raw.length > 100_000) throw new Error('invalid policy');
    return { version: value.version.trim(), enabled: true, allowedFields, cohort };
  } catch { return { version: 'disabled', enabled: false, allowedFields: [], cohort: [] }; }
}

export function policyAllows(policy: ShadowPublicationPolicy, identity: ShadowPublicationCohortEntry): boolean {
  return policy.enabled && policy.cohort.some(entry => entry.sourceId === identity.sourceId
    && entry.externalId === identity.externalId && entry.contentHash === identity.contentHash);
}

export function shadowPublicationFingerprint(value: { jobId: string; sourceId: string; externalId: string; contentHash: string; runKey: string; policyVersion: string; allowedFields: readonly ShadowPublicationField[] }): string {
  return hash({ ...value, allowedFields: [...value.allowedFields].sort() });
}

function period(value: unknown): CompensationPeriod | undefined {
  const map: Record<string, CompensationPeriod> = { hour: 'hourly', day: 'daily', week: 'weekly', month: 'monthly', year: 'annual', unknown: 'unknown' };
  return typeof value === 'string' ? map[value] : undefined;
}

function normalizedWorkMode(value: unknown): Exclude<WorkMode, 'unspecified'> | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/gu, '');
  if (normalized === 'remote') return 'remote';
  if (normalized === 'hybrid') return 'hybrid';
  if (normalized === 'onsite' || normalized === 'inoffice') return 'onsite';
  return undefined;
}

/** Conversion is deliberately narrower than shadow validation. Unsupported
 * shapes are omitted instead of being transformed into public metadata. */
export function shadowExtractionEvidence(input: {
  extraction: ShadowExtraction; sourceId: string; sourceUrl: string; contentHash: string; observedAt: string;
  extractionVersion: number; allowedFields: readonly ShadowPublicationField[];
}): RoleMetadataEvidence | undefined {
  const allowed = new Set(input.allowedFields);
  const field = (name: ShadowPublicationField): ShadowField => input.extraction.fields[name];
  const compensationField = field('compensation');
  const locationsField = field('locations');
  const workModeField = field('workMode');
  const provenance = (name: ShadowPublicationField, quote: string) => [{ source: 'reviewed-shadow' as const, sourceId: input.sourceId,
    sourceUrl: input.sourceUrl, contentHash: input.contentHash, observedAt: input.observedAt, evidenceCode: `shadow-${name}:${hash(quote).slice(0, 16)}` }];
  const compensation: CompensationRange[] = allowed.has('compensation') && compensationField.status === 'present' && Array.isArray(compensationField.value)
    ? compensationField.value.flatMap((value): CompensationRange[] => isRecord(value) && typeof value.min === 'number' && typeof value.max === 'number'
      && typeof value.currency === 'string' && period(value.period) && compensationField.evidence[0]
      ? [{ minAmount: value.min, maxAmount: value.max, currency: value.currency, period: period(value.period)!,
        sourceText: boundedText(compensationField.evidence[0], 240), provenance: provenance('compensation', compensationField.evidence[0]) }] : []) : [];
  const locations = allowed.has('locations') && locationsField.status === 'present' && Array.isArray(locationsField.value)
    ? normalizeLocations(locationsField.value.filter((item): item is string => typeof item === 'string')).map(name => ({ name,
      workMode: 'unspecified' as const,
      provenance: provenance('locations', locationsField.evidence[0] ?? name) })) : [];
  const workMode = normalizedWorkMode(workModeField.value);
  const mode = allowed.has('workMode') && workModeField.status === 'present' && workMode && workModeField.evidence[0]
    ? { value: workMode, provenance: provenance('workMode', workModeField.evidence[0]) } : undefined;
  if (!compensation.length && !locations.length && !mode) return undefined;
  return { schemaVersion: 1, extractionVersion: input.extractionVersion, artifactHash: input.contentHash, sourceClass: 'reviewed-shadow', sourceId: input.sourceId,
    sourceUrl: input.sourceUrl, observedAt: input.observedAt, exactPosting: true,
    ...(compensation.length ? { compensationRanges: compensation } : {}), ...(locations.length ? { locations } : {}), ...(mode ? { workMode: mode } : {}) };
}

export function shadowPublishableFields(extraction: ShadowExtraction, allowedFields: readonly ShadowPublicationField[]): ShadowPublicationField[] {
  return allowedFields.filter((field) => {
    const evidence = shadowExtractionEvidence({ extraction, sourceId: 'evaluation', sourceUrl: 'https://example.invalid', contentHash: '0'.repeat(64),
      observedAt: '1970-01-01T00:00:00.000Z', extractionVersion: 1, allowedFields: [field] });
    return field === 'compensation' ? Boolean(evidence?.compensationRanges?.length)
      : field === 'locations' ? Boolean(evidence?.locations?.length) : Boolean(evidence?.workMode);
  });
}

/** Fields the deterministic metadata extractor records a baseline for. The LLM
 * runs shadow-only on top; conformance to this baseline is a review signal. */
export const deterministicBaselineFields = ['compensation', 'locations', 'workMode', 'housing', 'timing', 'education'] as const;
export type DeterministicBaselineField = (typeof deterministicBaselineFields)[number];

export type BaselineState = 'present' | 'not-stated' | 'conflicting' | 'incomplete' | 'unavailable';

export interface FieldBaselineConformance {
  field: string;
  baseline: BaselineState;
  /** deterministic-confirm: deterministic evidence also says present.
   * deterministic-conflict: the LLM claims a field the deterministic extractor
   * stayed silent on (or vice versa) — flag for review before any receipt.
   * deterministic-consistent: both agree the field is absent.
   * llm-only: no deterministic baseline exists (eligibility). */
  advisory: 'deterministic-confirm' | 'deterministic-conflict' | 'deterministic-consistent' | 'baseline-inconclusive' | 'baseline-unavailable' | 'llm-only';
}

const presentOutcomes = ['correct-present', 'false-positive', 'wrong-value'];

export function fieldBaselineConformance(field: string, outcome: string, baseline: BaselineState): FieldBaselineConformance {
  if (baseline === 'unavailable') return { field, baseline, advisory: field === 'eligibility' ? 'llm-only' : 'baseline-unavailable' };
  if (baseline === 'incomplete' || baseline === 'conflicting') return { field, baseline, advisory: 'baseline-inconclusive' };
  const claimsPresent = presentOutcomes.includes(outcome);
  if (claimsPresent && baseline === 'present') return { field, baseline, advisory: 'deterministic-confirm' };
  if (!claimsPresent && baseline !== 'present') return { field, baseline, advisory: 'deterministic-consistent' };
  return { field, baseline, advisory: 'deterministic-conflict' };
}
