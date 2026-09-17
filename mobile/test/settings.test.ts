import { describe, expect, it } from "vitest";
import {
  appSettingsPayload,
  jobPreferencesPayload,
  settingsDraftSyncPlan,
  settingsDestinations,
} from "../src/settings.js";

describe("profile settings navigation", () => {
  it("keeps profile settings in three focused destinations", () => {
    expect(settingsDestinations.map(({ id }) => id)).toEqual([
      "user-info",
      "job-preferences",
      "app-account",
    ]);
  });

  it("gives every destination reviewable navigation copy", () => {
    for (const destination of settingsDestinations) {
      expect(destination.title).not.toBe("");
      expect(destination.description).not.toBe("");
      expect(destination.accessibilityHint).not.toBe("");
    }
  });

  it("keeps job and app settings saves isolated", () => {
    const jobUpdate = jobPreferencesPayload({
      filter: { includeKeywords: ["backend"] },
      alertsEnabled: true,
      delivery: "daily-digest",
      quietHours: {
        start: "22:00",
        end: "08:00",
        timezone: "America/New_York",
      },
    });
    const appUpdate = appSettingsPayload({
      applicationReminders: false,
      followUpDays: 10,
      applicationHandoff: "window",
      push: { titleTemplate: "{company}: {title}" },
    });

    expect(jobUpdate).not.toHaveProperty("push");
    expect(jobUpdate.alertSettings).not.toHaveProperty("applicationReminders");
    expect(jobUpdate.alertSettings).not.toHaveProperty("followUpDays");
    expect(jobUpdate.alertSettings).toMatchObject({ timezone: "America/New_York" });
    expect(appUpdate).not.toHaveProperty("filter");
    expect(appUpdate).not.toHaveProperty("alertsEnabled");
    expect(appUpdate.applicationHandoff).toBe("window");
    expect(appUpdate.alertSettings).not.toHaveProperty("delivery");
    expect(appUpdate.alertSettings).not.toHaveProperty("quietHours");
  });

  it("does not resynchronize a dirty draft when the other destination saves", () => {
    expect(settingsDraftSyncPlan(
      { jobPreferences: 1, appSettings: 0 },
      { jobPreferences: 0, appSettings: 0 },
    )).toEqual({
      jobPreferences: false,
      appSettings: true,
    });

    expect(settingsDraftSyncPlan(
      { jobPreferences: 1, appSettings: 2 },
      { jobPreferences: 1, appSettings: 1 },
    )).toEqual({
      jobPreferences: true,
      appSettings: false,
    });
  });
});
