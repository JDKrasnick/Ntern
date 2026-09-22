/** Treat fetched employer pages as untrusted text. This deliberately extracts no
 * instructions, scripts, or embedded markup for downstream generation. */
export function extractResumeJobText(markup: string, maxCharacters = 30_000): { title?: string; description: string } {
  const title = markup.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)?.[1]
    ?.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim();
  const description = markup
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<noscript\b[^>]*>[\s\S]*?<\/noscript>|<title\b[^>]*>[\s\S]*?<\/title>/giu, ' ')
    .replace(/<\/(?:p|div|li|h[1-6]|section|article|br)[^>]*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/giu, (_whole, entity: string) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity.toLowerCase()] ?? ' ')
    .replace(/[\t ]+/gu, ' ').replace(/\n\s*/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim()
    .slice(0, maxCharacters);
  return { ...(title ? { title: title.slice(0, 240) } : {}), description };
}
