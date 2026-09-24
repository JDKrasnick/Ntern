import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  isAvailable: vi.fn(),
  share: vi.fn(),
  create: vi.fn(),
  write: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('expo-sharing', () => ({ isAvailableAsync: mocks.isAvailable, shareAsync: mocks.share }));
vi.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache' },
  File: class {
    uri = 'file:///cache/ntern-resume-artifact.pdf';
    create = mocks.create;
    write = mocks.write;
    delete = mocks.delete;
  },
}));
vi.mock('../src/public-config', () => ({ publicConfig: { apiUrl: 'https://api.example.test' } }));

import { loadResumeArtifactPreview, loadResumeArtifactSource, releaseResumeArtifactPreview, shareResumeArtifact } from '../src/resume-artifact-share';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform.OS = 'ios';
  mocks.isAvailable.mockResolvedValue(true);
  mocks.share.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([37, 80, 68, 70, 45]), { headers: { 'content-type': 'application/pdf' } })));
});

describe('private resume PDF sharing', () => {
  it('loads authenticated LaTeX source for review', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('\\documentclass{article}', { headers: { 'content-type': 'text/plain; charset=utf-8' } }));
    await expect(loadResumeArtifactSource('artifact/id', 'secret-token')).resolves.toBe('\\documentclass{article}');
    expect(fetch).toHaveBeenCalledWith('https://api.example.test/me/resume-artifacts/artifact%2Fid/source', {
      headers: { Accept: 'text/plain', Authorization: 'Bearer secret-token' },
    });
  });

  it('loads and releases an authenticated rendered page on web', async () => {
    mocks.platform.OS = 'web';
    vi.mocked(fetch).mockResolvedValue(new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }));
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:rendered-page');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    await expect(loadResumeArtifactPreview('artifact/id', 1, 'secret-token')).resolves.toBe('blob:rendered-page');
    expect(fetch).toHaveBeenCalledWith('https://api.example.test/me/resume-artifacts/artifact%2Fid/preview/1', {
      headers: { Accept: 'image/png', Authorization: 'Bearer secret-token' },
    });
    expect(createObjectURL).toHaveBeenCalledOnce();
    releaseResumeArtifactPreview('blob:rendered-page');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:rendered-page');
  });

  it('downloads with authentication, shares as PDF, and cleans up', async () => {
    await shareResumeArtifact('artifact/id', 'secret-token');
    expect(fetch).toHaveBeenCalledWith('https://api.example.test/me/resume-artifacts/artifact%2Fid/content', {
      headers: { Accept: 'application/pdf', Authorization: 'Bearer secret-token' },
    });
    expect(mocks.write).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(mocks.share).toHaveBeenCalledWith(expect.stringMatching(/\.pdf$/u), expect.objectContaining({ mimeType: 'application/pdf' }));
    expect(mocks.delete).toHaveBeenCalledOnce();
  });

  it('rejects a non-PDF response before creating a file', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } }));
    await expect(shareResumeArtifact('artifact', 'token')).rejects.toThrow('did not return a PDF');
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
