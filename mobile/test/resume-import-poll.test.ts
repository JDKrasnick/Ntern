import { describe, expect, it, vi } from 'vitest';
import { pollResumeImport } from '../src/resume-import-poll';

describe('resume import polling', () => {
  it('refreshes a queued import until it becomes ready', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ status: 'pending' as const })
      .mockResolvedValueOnce({ status: 'ready' as const });
    const wait = vi.fn(async () => undefined);
    await expect(pollResumeImport(read, { wait })).resolves.toEqual({ status: 'ready' });
    expect(read).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1_500);
  });

  it('stops after a bounded number of pending reads', async () => {
    const read = vi.fn(async () => ({ status: 'pending' as const }));
    await expect(pollResumeImport(read, { attempts: 3, intervalMs: 0, wait: async () => undefined })).resolves.toEqual({ status: 'pending' });
    expect(read).toHaveBeenCalledTimes(3);
  });
});
