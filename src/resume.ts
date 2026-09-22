/**
 * Canonical, user-owned resume records. Generated PDFs, previews, embeddings,
 * and model output deliberately remain outside these contracts.
 */
export type ResumeBankKind = 'role' | 'project' | 'skill' | 'education' | 'bullet';
export type ResumeChangeType = 'rewrite' | 'add' | 'remove' | 'move';
export type ResumeTemplateId = 'jake-technical' | 'clean-standard' | 'research-academic' | 'project-compact';

export interface ResumeBankItem {
  userId: string;
  bankItemId: string;
  kind: ResumeBankKind;
  content: string;
  sourceDocumentId?: string;
  sourceLocation?: string;
  verified: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
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
  section: string;
  original?: string;
  suggestion?: string;
  evidenceIds: string[];
  reason: string;
  decision?: 'accepted' | 'rejected';
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
  return value.replace(/[\\{}#$%&_~^]/gu, (character) => ({
    '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '#': '\\#', '$': '\\$', '%': '\\%', '&': '\\&', '_': '\\_', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
  }[character] ?? character));
}

/** Model output cannot cite unknown or unverified facts, including numeric claims. */
export function validateResumeChanges(changes: ResumeChange[], bank: ResumeBankItem[]): void {
  const verified = new Map(bank.filter((item) => item.verified).map((item) => [item.bankItemId, item]));
  for (const change of changes) {
    if (!change.evidenceIds.length || change.evidenceIds.some((id) => !verified.has(id))) {
      throw new Error('Each resume change must cite verified bank evidence.');
    }
    const evidence = change.evidenceIds.map((id) => verified.get(id)!.content).join(' ');
    const numbers = (change.suggestion ?? '').match(/\b\d+(?:\.\d+)?%?\b/gu) ?? [];
    if (numbers.some((number) => !evidence.includes(number))) {
      throw new Error('Resume changes cannot add numeric claims absent from verified evidence.');
    }
  }
}
