import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../App.tsx', import.meta.url).pathname, 'utf8');

describe('resume workspace navigation contract', () => {
  it('keeps Resume as the fifth authenticated navigation destination', () => {
    expect(app).toContain('type AppTab = "roles" | "queue" | "catalog" | "resume" | "profile";');
    expect(app).toContain('resumeEnabled ? [{ key: "resume" as const, label: "Resume"');
    expect(app).toContain('resumeEnabled={publicConfig.resumeTunerEnabled}');
    expect(app).toContain('<ResumeWorkspace onSignIn={openAccount} />');
    expect(app).not.toContain('feature="tailor and save résumés"');
    expect(app).toContain('accessibilityLabel="Import one or more PDF or DOCX resumes"');
    expect(app).toContain('"/me/resume-bank/import"');
    expect(app).toContain('multiple: true');
    expect(app).toContain('bankItemIds: imported.items.map((item) => item.bankItemId)');
    expect(app).toContain('setProfiles((items) => [...items, profile])');
    expect(app).toContain('method: "PATCH", body: JSON.stringify({ revision: item.revision, verified: true })');
    expect(app).toContain('type ResumeBankCard =');
    expect(app).toContain('kind: "bullet"; parent: { kind: ResumeBankParentKind; bankItemId: string }; details?: never');
    expect(app).toContain('type ResumeBankRef =');
    expect(app).toContain('kind: "bullet"; bankItemId: string; parent:');
    expect(app).toContain('bankEntryKind === "bullet" && selectedBankParent');
    expect(app).toContain('Create a role, research entry, project, or education item first. Bullets cannot exist without one.');
    expect(app).toContain('"role", "research", "project", "education", "skill", "bullet"');
    expect(app).toContain('api<{ templates: ResumeTemplateCard[] }>("/resume-templates", token)');
    expect(app).toContain('sourceProfile.template !== selectedTemplate');
    expect(app).toContain('revision: sourceProfile.revision, template: selectedTemplate');
  });

  it('offers guests a temporary resume workspace without persistent writes', () => {
    expect(app).toContain('function ResumeWorkspace({ token = "", onSignIn }');
    expect(app).toContain('Guest session');
    expect(app).toContain('name="cloud-offline-outline"');
    expect(app).toContain('<Text style={styles.resumeGuestStatusDetail}>Not saved</Text>');
    expect(app).toContain('const localId = `guest-${Date.now()}-${bankItems.length + 1}`;');
    expect(app).toContain('Sign in to run review');
    expect(app).toContain('Sign in to import PDF or DOCX');
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

  it('keeps the master bank compact and makes resume import the primary editor task', () => {
    expect(app).toContain('const [bankManagerOpen, setBankManagerOpen] = useState(false);');
    expect(app).toContain('bankManagerOpen ? "Done editing" : "Edit master bank"');
    expect(app).toContain('{bankManagerOpen ? (');
    expect(app).toContain('{!bankManagerOpen && signedIn ? <View style={styles.resumeSavedSection}>');
    expect(app.indexOf('Paste the job URL')).toBeLessThan(app.indexOf('{bankManagerOpen ? ('));
    expect(app).toContain('<Text style={styles.resumeImportStageTitle}>{bankSaving ? "Adding your résumés…" : "Add your résumés"}</Text>');
    expect(app).toContain('No clean source file? Use an LLM prompt');
    expect(app).toContain('<Text style={styles.resumePromptFreeBadge}>Free</Text>');
    expect(app).toContain('"Build from scratch" : "Convert existing material"');
    expect(app).toContain('Clipboard.setStringAsync(resumeBankPrompt(promptKind))');
    expect(app).toContain('<Text style={styles.resumeMasterBankTitle}>Master bank</Text>');
    expect(app).toContain('styles.resumeSourceWorkspaceWide');
    expect(app).toContain('const [manualEntryOpen, setManualEntryOpen] = useState(false);');
    expect(app).toContain('manualEntryOpen ? <View style={styles.resumeManualEntry}>');
    expect(app).toContain('setBankEntryKind("bullet");');
    expect(app).toContain('setBankParentId(item.bankItemId);');
    expect(app).toContain('<Text numberOfLines={2} style={styles.resumeBankItemText}>');
    expect(app).toContain('bankExpanded ? "Hide bank" : `Review ${bankRoots.length} items`');
  });

  it('offers saved resume variants as a quick horizontal picker', () => {
    expect(app).toContain('const savedResumeProfiles = profiles.filter((profile) => profile.name !== "Technical base");');
    expect(app).toContain('<Text style={styles.sectionTitle}>Saved résumés</Text>');
    expect(app).toContain('bankLoading ? <ResumeSavedProfilesGhost />');
    expect(app).toContain('const motionAllowed = useContext(MotionAllowedContext);');
    expect(app).toContain('useNativeDriver: true');
    expect(app).toContain('savedResumeProfiles.map((profile) =>');
    expect(app).toContain('aria-pressed={selected}');
    expect(app).toContain('setSelectedProfileId(profile.profileId); setResumeSourceMode("existing");');
    expect(app).toContain('{!bankManagerOpen && signedIn ? <View style={styles.resumeSavedSection}>');
  });

  it('offers the best saved resume and an ideal master-bank build', () => {
    expect(app).toContain('type ResumeSourceMode = "existing" | "ideal";');
    expect(app).toContain('bestSavedResumeRecommendation(result.recommendations, savedProfiles)');
    expect(app).toContain('<Text style={styles.resumeSourceChoiceBadge}>Best existing</Text>');
    expect(app).toContain('<Text style={styles.resumeSourceChoiceBadge}>Ideal from your bank</Text>');
    expect(app).toContain('resumeSourceMode === "ideal" ? await syncTechnicalBase()');
    expect(app).toContain('profileId: sourceProfile.profileId');
  });

  it('keeps server-owned plans collapsed and disables new tailoring at the monthly limit', () => {
    expect(app).toContain('api<ResumeSubscriptionCard>("/me/subscription", token)');
    expect(app).toContain('planExpanded ? "Hide plan details" : "Plan details"');
    expect(app).toContain('subscription && planExpanded ? <View style={[styles.resumePlanGrid');
    expect(app).toContain('App Store purchase coming next');
    expect(app).toContain('subscription?.usage.remaining === 0 ? "Monthly limit reached"');
  });
});
