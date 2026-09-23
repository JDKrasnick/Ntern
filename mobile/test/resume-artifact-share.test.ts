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

import { shareResumeArtifact } from '../src/resume-artifact-share';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform.OS = 'ios';
  mocks.isAvailable.mockResolvedValue(true);
  mocks.share.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([37, 80, 68, 70, 45]), { headers: { 'content-type': 'application/pdf' } })));
});

describe('private resume PDF sharing', () => {
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
