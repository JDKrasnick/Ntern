/**
 * Canonical, user-owned resume records. Generated PDFs, previews, embeddings,
 * and model output deliberately remain outside these contracts.
 */
export type ResumeBankParentKind = 'role' | 'research' | 'project' | 'education';
export type ResumeBankRootKind = ResumeBankParentKind | 'skill';
export type ResumeBankKind = ResumeBankRootKind | 'bullet';
export type ResumeChangeType = 'rewrite' | 'add' | 'remove' | 'move';
export type ResumeTemplateId = 'jake-technical' | 'clean-standard' | 'research-academic' | 'project-compact';

interface ResumeBankItemBase {
  userId: string;
  bankItemId: string;
  content: string;
  sourceDocumentId?: string;
  sourceLocation?: string;
  verified: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ResumeRoleDetails {
  organization: string;
  title?: string;
  location?: string;
  dateRange?: string;
}

export interface ResumeResearchDetails {
  organization: string;
  title?: string;
  advisor?: string;
  location?: string;
  dateRange?: string;
}

export interface ResumeProjectDetails {
  name: string;
  tagline?: string;
  technologies: string[];
  url?: string;
}

export interface ResumeEducationDetails {
  institution: string;
  credential?: string;
  location?: string;
  dateRange?: string;
  gpa?: string;
  testScores?: string[];
  coursework?: string[];
  awards?: string[];
  details?: string;
}

export interface ResumeSkillDetails {
  category: string;
  skills: string[];
}

export interface ResumeBankDetailsByKind {
  role: ResumeRoleDetails;
  research: ResumeResearchDetails;
  project: ResumeProjectDetails;
  education: ResumeEducationDetails;
  skill: ResumeSkillDetails;
}

/** A tagged pointer is carried across every API and model boundary. The tag
 * prevents a bullet from being represented as the child of another bullet or
 * an untyped row identifier. */
export type ResumeBankParentRef = {
  [Kind in ResumeBankParentKind]: { kind: Kind; bankItemId: string }
}[ResumeBankParentKind];

export type ResumeBankItemRef =
  | { [Kind in ResumeBankRootKind]: { kind: Kind; bankItemId: string } }[ResumeBankRootKind]
  | { kind: 'bullet'; bankItemId: string; parent: ResumeBankParentRef };

export type ResumeBankItem =
  | ({ [Kind in ResumeBankRootKind]: ResumeBankItemBase & { kind: Kind; parent?: never; details?: ResumeBankDetailsByKind[Kind] } }[ResumeBankRootKind])
  | (ResumeBankItemBase & { kind: 'bullet'; parent: ResumeBankParentRef });

const resumeParentKinds = new Set<ResumeBankParentKind>(['role', 'research', 'project', 'education']);
const resumeRootKinds = new Set<ResumeBankRootKind>(['role', 'research', 'project', 'education', 'skill']);

const optionalDetail = (value: unknown, field: string, max = 240) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${field} must be text up to ${max} characters`);
  return value.trim();
};

const requiredDetail = (value: unknown, fallback: string, field: string) => optionalDetail(value, field) ?? fallback.trim();
const detailList = (value: unknown, field: string, limit = 40) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > limit || value.some((item) => typeof item !== 'string' || !item.trim() || item.trim().length > 160)) throw new Error(`${field} must be a list of short text values`);
  return value.map((item) => String(item).trim());
};

/** Validates the discriminated metadata used by renderers. `content` remains a
 * searchable summary and supplies a safe compatibility value for old rows. */
export function parseResumeBankDetails<Kind extends ResumeBankRootKind>(kind: Kind, value: unknown, content: string): ResumeBankDetailsByKind[Kind] {
  const details = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  switch (kind) {
    case 'role': return {
      organization: requiredDetail(details.organization, content, 'organization'),
      title: optionalDetail(details.title, 'title'), location: optionalDetail(details.location, 'location'), dateRange: optionalDetail(details.dateRange, 'dateRange'),
    } as ResumeBankDetailsByKind[Kind];
    case 'research': return {
      organization: requiredDetail(details.organization, content, 'organization'),
      title: optionalDetail(details.title, 'title'), advisor: optionalDetail(details.advisor, 'advisor'),
      location: optionalDetail(details.location, 'location'), dateRange: optionalDetail(details.dateRange, 'dateRange'),
    } as ResumeBankDetailsByKind[Kind];
    case 'project': {
      const technologies = details.technologies === undefined ? [] : details.technologies;
      if (!Array.isArray(technologies) || technologies.length > 30 || technologies.some((item) => typeof item !== 'string' || !item.trim() || item.trim().length > 80)) {
        throw new Error('technologies must be a list of short names');
      }
      return { name: requiredDetail(details.name, content, 'name'), tagline: optionalDetail(details.tagline, 'tagline'), technologies: technologies.map((item) => String(item).trim()), url: optionalDetail(details.url, 'url', 500) } as ResumeBankDetailsByKind[Kind];
    }
    case 'education': return {
      institution: requiredDetail(details.institution, content, 'institution'), credential: optionalDetail(details.credential, 'credential'),
      location: optionalDetail(details.location, 'location'), dateRange: optionalDetail(details.dateRange, 'dateRange'),
      gpa: optionalDetail(details.gpa, 'gpa'), testScores: detailList(details.testScores, 'testScores'), coursework: detailList(details.coursework, 'coursework'), awards: detailList(details.awards, 'awards'),
      details: optionalDetail(details.details, 'details', 1_000),
    } as ResumeBankDetailsByKind[Kind];
    case 'skill': {
      const skills = details.skills === undefined ? content.split(',') : details.skills;
      if (!Array.isArray(skills) || skills.length > 80 || skills.some((item) => typeof item !== 'string' || !item.trim() || item.trim().length > 80)) {
        throw new Error('skills must be a list of short names');
      }
      return { category: requiredDetail(details.category, 'Technical', 'category'), skills: skills.map((item) => String(item).trim()) } as ResumeBankDetailsByKind[Kind];
    }
  }
}

export function parseResumeBankParentRef(value: unknown): ResumeBankParentRef {
  if (!value || typeof value !== 'object') throw new Error('parent must be a typed role, project, or education pointer');
  const ref = value as Record<string, unknown>;
  if (!resumeParentKinds.has(ref.kind as ResumeBankParentKind) || typeof ref.bankItemId !== 'string' || !ref.bankItemId.trim()) {
    throw new Error('parent must be a typed role, project, or education pointer');
  }
  return { kind: ref.kind as ResumeBankParentKind, bankItemId: ref.bankItemId.trim() } as ResumeBankParentRef;
}

export function parseResumeBankItemRef(value: unknown): ResumeBankItemRef {
  if (!value || typeof value !== 'object') throw new Error('target must be a typed resume bank pointer');
  const ref = value as Record<string, unknown>;
  if (typeof ref.bankItemId !== 'string' || !ref.bankItemId.trim()) throw new Error('target must be a typed resume bank pointer');
  if (ref.kind === 'bullet') return { kind: 'bullet', bankItemId: ref.bankItemId.trim(), parent: parseResumeBankParentRef(ref.parent) };
  if (!resumeRootKinds.has(ref.kind as ResumeBankRootKind)) throw new Error('target must be a typed resume bank pointer');
  return { kind: ref.kind as ResumeBankRootKind, bankItemId: ref.bankItemId.trim() } as ResumeBankItemRef;
}

export interface ResumeProfile {
  userId: string;
  profileId: string;
  name: string;
  tags: string[];
  bankItemIds: string[];
  sectionOrder: string[];
  template: ResumeTemplateId;
  approvedWording: Record<string, string>;
  bankRevision: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ResumeTemplate {
  template: ResumeTemplateId;
  version: string;
  displayName: string;
}

export interface ImportedJob {
  importId: string;
  canonicalUrl: string;
  title?: string;
  company?: string;
  description: string;
  source: 'catalog' | 'cache' | 'manual';
  contentHash: string;
  status: 'ready' | 'pending' | 'manual-description-required';
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ResumeChange {
  changeId: string;
  type: ResumeChangeType;
  /** The exact bank object being changed (or parent receiving an added bullet). */
  target: ResumeBankItemRef;
  section: string;
  original?: string;
  suggestion?: string;
  evidenceIds: string[];
  reason: string;
  decision?: 'accepted' | 'rejected';
}

export function resumeBankItemRef(item: ResumeBankItem): ResumeBankItemRef {
  return item.kind === 'bullet'
    ? { kind: item.kind, bankItemId: item.bankItemId, parent: item.parent }
    : { kind: item.kind, bankItemId: item.bankItemId };
}

const sameResumeRef = (left: ResumeBankParentRef, right: ResumeBankParentRef) => left.kind === right.kind && left.bankItemId === right.bankItemId;

/** A caller-safe graph rejection. Storage layers throw this for invalid resume
 * graph shape so routes can answer 400 without misreporting I/O failures. */
export class ResumeBankGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResumeBankGraphError';
  }
}

/** Validates the in-memory object graph, independently of its storage shape. */
export function validateResumeBankGraph(bank: readonly ResumeBankItem[]): void {
  const byId = new Map<string, ResumeBankItem>();
  const userId = bank[0]?.userId;
  for (const item of bank) {
    if (byId.has(item.bankItemId)) throw new ResumeBankGraphError('Resume bank item identifiers must be unique.');
    if (item.userId !== userId) throw new ResumeBankGraphError('A resume bank graph may only contain one user\'s objects.');
    if (item.kind !== 'bullet' && 'parent' in item && item.parent !== undefined) throw new ResumeBankGraphError('Only resume bullets may carry parent pointers.');
    byId.set(item.bankItemId, item);
  }
  for (const item of bank) {
    if (item.kind !== 'bullet') continue;
    if (!item.parent || !resumeParentKinds.has(item.parent.kind) || !item.parent.bankItemId) {
      throw new ResumeBankGraphError('Each resume bullet must carry a typed parent pointer.');
    }
    const parent = byId.get(item.parent.bankItemId);
    if (!parent || parent.userId !== item.userId || parent.kind !== item.parent.kind) {
      throw new ResumeBankGraphError('Each resume bullet must point to an owned role, project, or education parent of the declared kind.');
    }
  }
}

export function validateResumeBankItemPlacement(item: ResumeBankItem, bank: readonly ResumeBankItem[]): void {
  validateResumeBankGraph([...bank.filter((existing) => existing.bankItemId !== item.bankItemId), item]);
}

/** Deterministic serializer for typed detail objects used inside de-duplication
 * keys. Keys are sorted and `undefined` fields dropped so logically identical
 * details always produce the same string. */
function stableDetails(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return `[${value.map(stableDetails).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableDetails(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? '';
}

/** Stable content key for de-duplicating bank items across imports. Root items
 * key on kind, normalized content, and their normalized typed details so two
 * different objects that share a summary line never collapse into one; bullets
 * also key on their resolved parent so the same bullet text under different
 * objects stays distinct.
 *
 * Reuse is intentionally conservative: a matched item keeps its stored
 * `verified` flag, details, and revision, so a re-import neither restores an
 * unverified item nor overwrites an edit. Because the key is content-addressed,
 * an edited item no longer matches the freshly extracted line and a re-import
 * creates a sibling rather than merging into the previously edited copy. */
export function resumeBankContentKey(kind: ResumeBankItem['kind'], content: string, options: { parentKey?: string; details?: unknown } = {}): string {
  return [kind, options.parentKey ?? '', content.trim().replace(/\s+/gu, ' '), stableDetails(options.details)].join('\u0000');
}

function bankItemForRef(ref: ResumeBankItemRef, byId: ReadonlyMap<string, ResumeBankItem>): ResumeBankItem | undefined {
  const item = byId.get(ref.bankItemId);
  if (!item || item.kind !== ref.kind) return undefined;
  if (item.kind === 'bullet') {
    if (ref.kind !== 'bullet' || !sameResumeRef(item.parent, ref.parent)) return undefined;
  }
  return item;
}

function owningResumeParent(item: ResumeBankItem): ResumeBankParentRef | undefined {
  if (item.kind === 'bullet') return item.parent;
  if (item.kind === 'role' || item.kind === 'research' || item.kind === 'project' || item.kind === 'education') return { kind: item.kind, bankItemId: item.bankItemId };
  return undefined;
}

export interface ResumeEntryBase {
  id: string;
  bullets: string[];
}

export interface ResumeExperienceEntry extends ResumeEntryBase, ResumeRoleDetails {}
export interface ResumeResearchEntry extends ResumeEntryBase, ResumeResearchDetails {}
export interface ResumeProjectEntry extends ResumeEntryBase, ResumeProjectDetails {}
export interface ResumeEducationEntry extends ResumeEntryBase, ResumeEducationDetails {}
export interface ResumeSkillEntry extends ResumeSkillDetails { id: string }

/** Canonical, fully typed input shared by every renderer. Templates may change
 * layout and density, but they cannot reinterpret the content graph. */
export interface ResumeDocument {
  name: string;
  contact: Array<{ label: string; value: string }>;
  education: ResumeEducationEntry[];
  experience: ResumeExperienceEntry[];
  research: ResumeResearchEntry[];
  projects: ResumeProjectEntry[];
  skills: ResumeSkillEntry[];
}

export interface ResumeDraft {
  userId: string;
  draftId: string;
  profileId: string;
  importId: string;
  changes: ResumeChange[];
  revision: number;
  status: 'reviewing' | 'finalized';
  createdAt: string;
  updatedAt: string;
}

export interface ResumeArtifact {
  userId: string;
  artifactId: string;
  draftId: string;
  objectKey: string;
  texObjectKey?: string;
  templateVersion: string;
  compilerVersion: string;
  resumeSpecHash: string;
  pageCount?: number;
  /** Private R2 object keys for rasterized PDF pages, in page order. */
  previewObjectKeys?: string[];
  createdAt: string;
}

/** Derived output from the isolated compiler. None of these fields are user input. */
export interface ResumeCompilation {
  pdf: ArrayBuffer;
  pageCount: number;
  previewPngs: ArrayBuffer[];
}

export interface ResumeProfileRecommendation {
  profileId: string;
  score: number;
  explanation: string;
}

const resumeWords = (value: string) => new Set(value.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/gu) ?? []);
const groundingStopWords = new Set(['and', 'are', 'but', 'for', 'from', 'into', 'not', 'the', 'their', 'then', 'this', 'that', 'was', 'were', 'with']);

const substantiveResumeWords = (value: string) => [...resumeWords(value)].filter((word) => !groundingStopWords.has(word));

/** Turns an intentionally comprehensive base into a reviewable one-page target.
 * Nothing is deleted silently: every lower-relevance bullet becomes an explicit
 * removal diff, and at least one bullet per represented parent is retained when
 * the budget permits it. */
export function proposeResumeReadabilityChanges(job: ImportedJob, bankItems: ResumeBankItem[], bulletLimit = 10): ResumeChange[] {
  const bullets = bankItems.filter((item): item is Extract<ResumeBankItem, { kind: 'bullet' }> => item.kind === 'bullet' && item.verified);
  if (bullets.length <= bulletLimit) return [];
  const jobWords = resumeWords(`${job.title ?? ''} ${job.company ?? ''} ${job.description}`);
  const scored = bullets.map((item, index) => ({ item, index, score: substantiveResumeWords(item.content).filter((word) => jobWords.has(word)).length }));
  const bestByParent = new Map<string, (typeof scored)[number]>();
  for (const candidate of scored) {
    const current = bestByParent.get(candidate.item.parent.bankItemId);
    if (!current || candidate.score > current.score) bestByParent.set(candidate.item.parent.bankItemId, candidate);
  }
  const ranked = [...scored].sort((left, right) => right.score - left.score || left.index - right.index);
  const keep = new Set([...bestByParent.values()].sort((left, right) => right.score - left.score || left.index - right.index).slice(0, bulletLimit).map(({ item }) => item.bankItemId));
  for (const { item } of ranked) {
    if (keep.size >= bulletLimit) break;
    keep.add(item.bankItemId);
  }
  return scored.filter(({ item }) => !keep.has(item.bankItemId)).map(({ item }, index) => ({
    changeId: `readability-${index}-${item.bankItemId}`,
    type: 'remove',
    target: resumeBankItemRef(item),
    section: item.parent.kind === 'project' ? 'Projects' : item.parent.kind === 'research' ? 'Research' : item.parent.kind === 'education' ? 'Education' : 'Experience',
    original: item.content,
    evidenceIds: [item.bankItemId],
    reason: `Keeps the final resume near ${bulletLimit} bullets for readable one-page spacing; this bullet has lower direct overlap with the job than retained material.`,
  }));
}

/** Deterministic first-pass base selection. Canonical records stay in D1; a later
 * Vectorize lookup may refine this score but must not replace its explanation. */
export function recommendResumeProfiles(jobDescription: string, profiles: ResumeProfile[], bankItems: ResumeBankItem[], semanticScores = new Map<string, number>()): ResumeProfileRecommendation[] {
  const words = resumeWords(jobDescription);
  const byId = new Map(bankItems.filter((item) => item.verified).map((item) => [item.bankItemId, item]));
  return profiles.map((profile) => {
    const tagHits = profile.tags.filter((tag) => words.has(tag.toLowerCase())).length;
    const evidence = profile.bankItemIds.map((id) => byId.get(id)).filter((item): item is ResumeBankItem => Boolean(item));
    const evidenceHits = evidence.filter((item) => [...resumeWords(item.content)].some((word) => words.has(word))).length;
    const semanticScore = evidence.reduce((best, item) => Math.max(best, semanticScores.get(item.bankItemId) ?? 0), 0);
    const score = tagHits * 100 + evidenceHits * 10 + Math.round(semanticScore * 25);
    const explanation = tagHits
      ? `Matches ${tagHits} job-family tag${tagHits === 1 ? '' : 's'} and ${evidenceHits} verified bank item${evidenceHits === 1 ? '' : 's'}.`
      : `Matches ${evidenceHits} verified bank item${evidenceHits === 1 ? '' : 's'} from this base.`;
    return { profileId: profile.profileId, score, explanation: semanticScore > 0 ? `${explanation} Semantic similarity: ${Math.round(semanticScore * 100)}%.` : explanation };
  }).sort((left, right) => right.score - left.score || left.profileId.localeCompare(right.profileId));
}

const privateIpv4 = /^(?:127\.|10\.|0\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/u;
const localhostNames = new Set(['localhost', 'localhost.localdomain']);

/** Rejects credentials, private hosts and non-HTTPS schemes before any fetch. */
export function normalizeResumeJobUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a valid HTTPS job URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
    throw new Error('Enter a public HTTPS job URL without credentials.');
  }
  const host = url.hostname.toLowerCase();
  if (localhostNames.has(host) || privateIpv4.test(host) || host === '::1' || host.startsWith('fc') || host.startsWith('fd')) {
    throw new Error('Private network job URLs are not allowed.');
  }
  url.hash = '';
  return url.toString();
}

/** Fixed templates escape every user-controlled value before compilation. */
export function escapeLatex(value: string): string {
  const normalized = value
    .replace(/“/gu, '``').replace(/”/gu, "''").replace(/[‘’]/gu, "'")
    .replace(/[‐‑‒–—−]/gu, '--').replace(/∼/gu, 'about ')
    .replace(/…/gu, '...').replace(/ﬁ/gu, 'fi').replace(/ﬂ/gu, 'fl')
    .replace(/[\u00a0\u2007\u202f]/gu, ' ');
  return normalized.replace(/[\\{}#$%&_~^]/gu, (character) => ({
    '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '#': '\\#', '$': '\\$', '%': '\\%', '&': '\\&', '_': '\\_', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
  }[character] ?? character));
}

/** Model output cannot cite unknown or unverified facts, including numeric claims. */
export function validateResumeChanges(changes: ResumeChange[], bank: ResumeBankItem[]): void {
  validateResumeBankGraph(bank);
  const verified = new Map(bank.filter((item) => item.verified).map((item) => [item.bankItemId, item]));
  for (const change of changes) {
    if (!change.evidenceIds.length || change.evidenceIds.some((id) => !verified.has(id))) {
      throw new Error('Each resume change must cite verified bank evidence.');
    }
    const target = bankItemForRef(change.target, verified);
    if (!target) throw new Error('Each resume change must target an exact verified bank item and parent pointer.');
    const evidenceItems = change.evidenceIds.map((id) => verified.get(id)!);
    const targetParent = owningResumeParent(target);
    if (evidenceItems.some((item) => {
      const evidenceParent = owningResumeParent(item);
      return targetParent || evidenceParent ? !targetParent || !evidenceParent || !sameResumeRef(targetParent, evidenceParent) : item.bankItemId !== target.bankItemId;
    })) throw new Error('Resume changes cannot combine bullets or evidence from different parent objects.');
    const evidence = evidenceItems.map((item) => item.content).join(' ');
    if ((change.type === 'add' && (!change.suggestion || change.original))
      || (change.type === 'remove' && (!change.original || change.suggestion))
      || (change.type === 'move' && (!change.original || change.suggestion))
      || (change.type === 'rewrite' && (!change.original || !change.suggestion))) {
      const expected = change.type === 'add' ? 'suggestion only' : change.type === 'rewrite' ? 'original and suggestion' : 'original only';
      throw new Error(`Resume change ${change.changeId} of type ${change.type} must include ${expected}.`);
    }
    const evidenceWords = resumeWords(evidence);
    const unsupportedWords = substantiveResumeWords(change.suggestion ?? '').filter((word) => !evidenceWords.has(word));
    if (unsupportedWords.length) {
      throw new Error(`Resume changes cannot add claims absent from verified evidence: ${unsupportedWords.join(', ')}.`);
    }
    const numbers = (change.suggestion ?? '').match(/\b\d+(?:\.\d+)?%?\b/gu) ?? [];
    if (numbers.some((number) => !evidence.includes(number))) {
      throw new Error('Resume changes cannot add numeric claims absent from verified evidence.');
    }
  }
}
