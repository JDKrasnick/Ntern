import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../App.tsx', import.meta.url).pathname, 'utf8');

describe('resume workspace navigation contract', () => {
  it('keeps Resume as the fifth authenticated navigation destination', () => {
    expect(app).toContain('type AppTab = "roles" | "queue" | "catalog" | "resume" | "profile";');
    expect(app).toContain('{ key: "resume", label: "Resume", icon: "document-text-outline", activeIcon: "document-text" }');
    expect(app).toContain('feature="tailor and save résumés"');
  });

  it('offers an adaptive review workspace with evidence and explicit decisions', () => {
    expect(app).toContain('reviewMode === "changes"');
    expect(app).toContain('resumeReviewWorkspaceWide');
    expect(app).toContain('Master Bank · Analytics project');
    expect(app).toContain('label="Keep original"');
    expect(app).toContain('label="Use suggestion"');
  });
});
