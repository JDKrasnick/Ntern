import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

it('counts decoded public images across every role and refuses a malformed HTTP 200 image', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'icon-coverage-'));
  const report = join(directory, 'report.json');
  const argv = process.argv;
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#123456' } }).png().toBuffer();
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify([{ results: [
    { role: JSON.stringify({ canonicalEmployerId: 'valid' }), roles: 2 },
    { role: JSON.stringify({ companyIconId: 'malformed' }), roles: 3 },
    { role: JSON.stringify({ company: 'Unaddressable', officialApplyUrl: 'invalid' }), roles: 4 },
  ] }]));
  vi.stubGlobal('fetch', async (url: string) => new Response(
    url.endsWith('/valid') ? new Uint8Array(png) : new TextEncoder().encode('not an image'),
    { headers: { 'content-type': 'image/png' } },
  ));
  process.argv = [argv[0]!, 'measure-icons', '--report', report];
  try {
    await import('../scripts/measure-served-company-icons.js');
    const result = JSON.parse(readFileSync(report, 'utf8'));
    expect(result).toMatchObject({ totalRoles: 9, coveredRoles: 2, servedKeys: 1, attemptedKeys: 2, errors: 0 });
    expect(result.results.find((row: { id: string }) => row.id === 'malformed'))
      .toMatchObject({ status: 200, decoded: false });
  } finally {
    process.argv = argv;
    output.mockRestore();
    vi.unstubAllGlobals();
    rmSync(directory, { recursive: true, force: true });
  }
});
