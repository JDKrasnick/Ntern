import { describe, expect, it } from 'vitest';
import { roleUpdateKey } from '../src/role-update';

describe('role update acknowledgement', () => {
  it('recognizes the same update after a retry, reordering, or duplicates', () => {
    expect(roleUpdateKey({ jobs: [{ jobId: 'b' }, { jobId: 'a' }, { jobId: 'b' }] }))
      .toBe(roleUpdateKey({ jobs: [{ jobId: 'a' }, { jobId: 'b' }] }));
  });
  it('distinguishes new roles and group-only updates', () => {
    expect(roleUpdateKey({ jobs: [{ jobId: 'a' }] })).not.toBe(roleUpdateKey({ jobs: [{ jobId: 'b' }] }));
    expect(roleUpdateKey({ jobs: [], groups: [{ group: { groupId: 'a' } }] }))
      .not.toBe(roleUpdateKey({ jobs: [], groups: [{ group: { groupId: 'b' } }] }));
  });
});
