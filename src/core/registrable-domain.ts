/**
 * Registrable-domain (eTLD+1) resolution for identity comparison.
 *
 * Employer identity is decided by comparing domains, so two-label public
 * suffixes must not be mistaken for registrable domains: `not-example.com` must
 * never compare equal to `example.com`, and `good.co.uk` must never compare
 * equal to `evil.co.uk`. Suffix labels are therefore stripped from a curated
 * table rather than from a fixed label count.
 *
 * The table is not the full public-suffix list. It covers the suffixes the
 * catalog actually observes; an unlisted multi-label suffix degrades to the
 * conservative two-label form, which keeps hosts that merely share a suffix
 * apart instead of merging them.
 */

/** Multi-label public suffixes: `a.b.co.uk` and `c.co.uk` stay distinct. */
const TWO_LABEL_PUBLIC_SUFFIXES: Record<string, true> = {
  'ac.uk': true, 'co.uk': true, 'gov.uk': true, 'ltd.uk': true, 'me.uk': true, 'net.uk': true,
  'nhs.uk': true, 'org.uk': true, 'plc.uk': true, 'sch.uk': true,
  'com.au': true, 'edu.au': true, 'gov.au': true, 'net.au': true, 'org.au': true,
  'co.nz': true, 'govt.nz': true, 'net.nz': true, 'org.nz': true,
  'co.za': true, 'net.za': true, 'org.za': true,
  'ac.jp': true, 'co.jp': true, 'go.jp': true, 'ne.jp': true, 'or.jp': true,
  'co.kr': true, 'or.kr': true,
  'co.in': true, 'firm.in': true, 'gen.in': true, 'net.in': true, 'org.in': true,
  'com.br': true, 'net.br': true, 'org.br': true,
  'com.mx': true, 'com.sg': true, 'com.cn': true, 'com.tr': true, 'com.hk': true, 'com.tw': true,
  'co.il': true, 'org.il': true, 'ac.il': true,
  'co.id': true, 'or.id': true, 'ac.id': true, 'go.id': true,
  'co.th': true, 'or.th': true, 'ac.th': true, 'go.th': true,
  'com.my': true, 'com.ph': true, 'com.vn': true, 'com.pk': true, 'com.eg': true, 'com.sa': true,
  'com.ua': true, 'com.ar': true, 'com.co': true, 'com.pe': true, 'com.ec': true, 'com.uy': true,
  'com.ve': true, 'com.ng': true, 'com.gh': true,
  'co.ke': true, 'co.ug': true, 'co.zw': true,
};

/**
 * Returns the registrable domain for a hostname. The input must already be a
 * hostname, not a URL. IPv4/IPv6 literals and single-label hosts are returned
 * unchanged.
 */
export function registrableDomain(host: string): string {
  const normalized = host.trim().toLowerCase().replace(/\.$/u, '');
  if (!normalized || normalized.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(normalized)) return normalized;
  const labels = normalized.split('.');
  if (labels.length <= 2) return normalized;
  const suffixLabels = TWO_LABEL_PUBLIC_SUFFIXES[labels.slice(-2).join('.')] ? 3 : 2;
  return labels.slice(-suffixLabels).join('.');
}

/**
 * True only when both hosts resolve to a non-empty, identical registrable
 * domain. Two empty or single-label results never compare equal, which is what
 * keeps malformed evidence from being treated as agreement.
 */
export function sameRegistrableDomain(left: string, right: string): boolean {
  const domain = registrableDomain(left);
  return domain.includes('.') && domain === registrableDomain(right);
}
