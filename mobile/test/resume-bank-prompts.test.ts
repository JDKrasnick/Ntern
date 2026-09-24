import { describe, expect, it } from 'vitest';
import { buildResumeBankPrompt, convertResumeBankPrompt, resumeBankPrompt } from '../src/resume-bank-prompts';

describe('resume bank prompts', () => {
  it('keeps both prompts compatible with the deterministic importer', () => {
    for (const prompt of [buildResumeBankPrompt, convertResumeBankPrompt]) {
      expect(prompt).toContain('EXPERIENCE');
      expect(prompt).toContain('PROJECTS');
      expect(prompt).toContain('EDUCATION');
      expect(prompt).toContain('SKILLS');
      expect(prompt).toContain('Never put a bullet before its parent.');
      expect(prompt).toContain('Never invent a claim');
      expect(prompt).toContain('plain text only');
    }
  });

  it('keeps creation and conversion behavior distinct', () => {
    expect(resumeBankPrompt('build')).toContain('interview me one parent at a time');
    expect(resumeBankPrompt('convert')).toContain('ask me which parent owns it');
    expect(resumeBankPrompt('convert')).toContain('REVIEW NEEDED');
    expect(resumeBankPrompt('convert')).toContain('plain, non-bulleted line');
  });
});
