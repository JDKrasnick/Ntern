import { describe, expect, it } from 'vitest';
import { escapeLatex, normalizeResumeJobUrl, validateResumeChanges } from '../src/resume.js';

describe('resume safety contracts', () => {
  it('normalizes public HTTPS job URLs without retaining fragments', () => {
    expect(normalizeResumeJobUrl(' https://careers.example.test/a#details ')).toBe('https://careers.example.test/a');
    expect(() => normalizeResumeJobUrl('http://careers.example.test/a')).toThrow('HTTPS');
    expect(() => normalizeResumeJobUrl('https://user:pass@careers.example.test/a')).toThrow('credentials');
    expect(() => normalizeResumeJobUrl('https://127.0.0.1/a')).toThrow('Private network');
  });

  it('escapes fixed-template LaTex fields', () => {
    expect(escapeLatex('C#_50%')).toBe('C\\#\\_50\\%');
  });

  it('rejects unverified cross-user evidence and unsupported numeric claims', () => {
    const verified = { userId: 'owner', bankItemId: 'bank-1', kind: 'bullet' as const, content: 'Improved 20% with Python', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' };
    expect(() => validateResumeChanges([{ changeId: 'c', type: 'rewrite', section: 'Experience', suggestion: 'Improved 30%', evidenceIds: ['bank-1'], reason: 'fit' }], [verified])).toThrow('numeric');
    expect(() => validateResumeChanges([{ changeId: 'c', type: 'rewrite', section: 'Experience', suggestion: 'Improved 20%', evidenceIds: ['other'], reason: 'fit' }], [verified])).toThrow('verified');
  });
});
