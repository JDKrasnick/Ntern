/** Cloudflare limits each text binding to 5 KiB. Keep literal source identity. */
export const SOURCE_ALLOWLIST_BINDING_LIMIT = 5 * 1024;
const COMPACT_PREFIX = 'prefixes-v1:';
const SOURCE_PREFIXES = ['greenhouse-', 'ashby-', 'lever-', ''] as const;
const sourceIdPattern = /^[a-z0-9][a-z0-9_.-]{0,199}$/iu;

export function decodeSourceAllowlist(value: string | undefined): string[] {
  if (!value?.startsWith(COMPACT_PREFIX)) return value?.split(',').map(id => id.trim()).filter(Boolean) ?? [];
  const groups: unknown = JSON.parse(value.slice(COMPACT_PREFIX.length));
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) throw new Error('Invalid compact source allowlist');
  const ids: string[] = [];
  for (const [prefix, suffixes] of Object.entries(groups)) {
    if (!SOURCE_PREFIXES.includes(prefix as typeof SOURCE_PREFIXES[number]) || !Array.isArray(suffixes) || !suffixes.length) {
      throw new Error('Invalid compact source allowlist group');
    }
    for (const suffix of suffixes) {
      const id = prefix + String(suffix);
      if (typeof suffix !== 'string' || !suffix.length || !sourceIdPattern.test(id)) throw new Error('Invalid compact source identity');
      ids.push(id);
      if (ids.length > 1000) throw new Error('Compact source allowlist exceeds identity budget');
    }
  }
  // Empty lists have special legacy semantics; malformed encoding never grants them.
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Empty or duplicate compact source allowlist');
  return ids;
}

export function encodeSourceAllowlist(sourceIds: Iterable<string>): string {
  const ids = [...new Set(sourceIds)].sort();
  if (ids.some(id => !sourceIdPattern.test(id))) throw new Error('Invalid source identity');
  const csv = ids.join(',');
  if (new TextEncoder().encode(csv).byteLength <= SOURCE_ALLOWLIST_BINDING_LIMIT) return csv;
  const groups: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const id of ids) {
    const prefix = SOURCE_PREFIXES.find(candidate => id.startsWith(candidate))!;
    const suffix = id.slice(prefix.length);
    if (!suffix) throw new Error('Invalid source suffix');
    (groups[prefix] ??= []).push(suffix);
  }
  const encoded = COMPACT_PREFIX + JSON.stringify(groups);
  if (new TextEncoder().encode(encoded).byteLength > SOURCE_ALLOWLIST_BINDING_LIMIT) throw new Error('Source allowlist exceeds text binding budget');
  return encoded;
}

export function sourceAllowlistBindingValid(value: string): boolean {
  if (new TextEncoder().encode(value).byteLength > SOURCE_ALLOWLIST_BINDING_LIMIT) return false;
  try {
    const ids = decodeSourceAllowlist(value);
    return ids.every(id => sourceIdPattern.test(id));
  } catch { return false; }
}
