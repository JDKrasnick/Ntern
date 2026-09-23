import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../App.tsx', import.meta.url).pathname, 'utf8');

describe('resume workspace navigation contract', () => {
  it('keeps Resume as the fifth authenticated navigation destination', () => {
    expect(app).toContain('type AppTab = "roles" | "queue" | "catalog" | "resume" | "profile";');
    expect(app).toContain('resumeEnabled ? [{ key: "resume" as const, label: "Resume"');
    expect(app).toContain('resumeEnabled={publicConfig.resumeTunerEnabled}');
    expect(app).toContain('feature="tailor and save résumés"');
    expect(app).toContain('Import a PDF or DOCX résumé');
    expect(app).toContain('"/me/resume-bank/import"');
    expect(app).toContain('label={item.verified ? "Mark for review" : "Verify item"}');
    expect(app).toContain('method: "PATCH", body: JSON.stringify({ revision: item.revision, verified })');
  });

  it('offers an adaptive review workspace with evidence and explicit decisions', () => {
    expect(app).toContain('reviewMode === "changes"');
    expect(app).toContain('resumeReviewWorkspaceWide');
    expect(app).toContain('Master Bank evidence');
    expect(app).toContain('label="Keep original"');
    expect(app).toContain('label="Use suggestion"');
    expect(app).toContain('accessibilityLabel="Previous change"');
    expect(app).toContain('/finalize`');
    expect(app).toContain('shareResumeArtifact(result.artifact.artifactId, token)');
    expect(app).toContain('pollResumeImport(() => api<ResumeImportCard>');
  });
});
