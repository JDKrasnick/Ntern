import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../App.tsx', import.meta.url).pathname, 'utf8');

describe('resume workspace navigation contract', () => {
  it('keeps Resume as the fifth authenticated navigation destination', () => {
    expect(app).toContain('type AppTab = "roles" | "queue" | "catalog" | "resume" | "profile";');
    expect(app).toContain('resumeEnabled ? [{ key: "resume" as const, label: "Resume"');
    expect(app).toContain('resumeEnabled={publicConfig.resumeTunerEnabled}');
    expect(app).toContain('feature="tailor and save résumés"');
    expect(app).toContain('accessibilityLabel="Import PDF or DOCX resume"');
    expect(app).toContain('"/me/resume-bank/import"');
    expect(app).toContain('technicalBase ? "Sync technical base" : "Create technical base"');
    expect(app).toContain('method: "PATCH", body: JSON.stringify({ revision: item.revision, verified: true })');
    expect(app).toContain('type ResumeBankRef =');
    expect(app).toContain('kind: "bullet"; bankItemId: string; parent:');
    expect(app).toContain('bankEntryKind === "bullet" && selectedBankParent');
    expect(app).toContain('Add a role, research entry, project, or education parent before adding its bullets.');
    expect(app).toContain('"role", "research", "project", "education", "skill", "bullet"');
    expect(app).toContain('api<{ templates: ResumeTemplateCard[] }>("/resume-templates", token)');
    expect(app).toContain('selectedProfile.template !== selectedTemplate');
    expect(app).toContain('revision: selectedProfile.revision, template: selectedTemplate');
  });

  it('offers an adaptive review workspace with evidence and explicit decisions', () => {
    expect(app).toContain('reviewMode === "changes"');
    expect(app).toContain('resumeReviewWorkspaceWide');
    expect(app).toContain('Technical-base evidence');
    expect(app).toContain('label="Keep original"');
    expect(app).toContain('label="Apply change"');
    expect(app).toContain('accessibilityLabel="Previous change"');
    expect(app).toContain('/finalize`');
    expect(app).toContain('loadResumeArtifactPreview(result.artifact.artifactId, 1, token)');
    expect(app).toContain('loadResumeArtifactSource(result.artifact.artifactId, token)');
    expect(app).toContain('shareResumeArtifact(artifact.artifactId, token)');
    expect(app).toContain('pollResumeImport(() => api<ResumeImportCard>');
  });

  it('keeps the technical base behind progressive disclosure', () => {
    expect(app).toContain('const [bankManagerOpen, setBankManagerOpen] = useState(false);');
    expect(app).toContain('bankManagerOpen ? "Done editing" : "Edit technical base"');
    expect(app).toContain('{bankManagerOpen ? (');
    expect(app.indexOf('Paste the job URL')).toBeLessThan(app.indexOf('{bankManagerOpen ? ('));
    expect(app).toContain('const wideWorkbench = width >= 1040;');
    expect(app).toContain('bankRoots.slice(0, 4)');
    expect(app).toContain('styles.resumeSetupWorkspaceWide');
    expect(app).toContain('styles.resumeLibraryRail');
    expect(app).toContain('style={bankExpanded ? styles.resumeBankScroller : undefined}');
    expect(app).toContain('<Text numberOfLines={2} style={styles.resumeBankItemText}>');
    expect(app).toContain('`Browse all ${bankRoots.length} entries`');
  });

  it('offers saved resume variants as a quick horizontal picker', () => {
    expect(app).toContain('const savedResumeProfiles = profiles.filter((profile) => profile.name !== "Technical base");');
    expect(app).toContain('<Text style={styles.sectionTitle}>Saved résumés</Text>');
    expect(app).toContain('savedResumeProfiles.map((profile) =>');
    expect(app).toContain('aria-pressed={selected}');
    expect(app).toContain('onPress={() => setSelectedProfileId(profile.profileId)}');
    expect(app.indexOf('<Text style={styles.sectionTitle}>Saved résumés</Text>')).toBeLessThan(app.indexOf('{bankManagerOpen ? ('));
  });

  it('keeps server-owned plans collapsed and disables new tailoring at the monthly limit', () => {
    expect(app).toContain('api<ResumeSubscriptionCard>("/me/subscription", token)');
    expect(app).toContain('planExpanded ? "Hide plan details" : "Plan details"');
    expect(app).toContain('subscription && planExpanded ? <View style={[styles.resumePlanGrid');
    expect(app).toContain('App Store purchase coming next');
    expect(app).toContain('subscription?.usage.remaining === 0 ? "Monthly limit reached"');
  });
});
