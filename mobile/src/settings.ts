export const settingsDestinations = [
  {
    id: "user-info",
    title: "User info",
    description: "Contact details and résumé for application help.",
    accessibilityHint: "Edit your contact details and résumé",
    icon: "person-outline",
  },
  {
    id: "job-preferences",
    title: "Job preferences",
    description: "Alerts and filters for the roles you want to follow.",
    accessibilityHint: "Choose which roles and alerts you want",
    icon: "briefcase-outline",
  },
  {
    id: "app-account",
    title: "App & account",
    description: "Hidden roles, notification wording, privacy, and account controls.",
    accessibilityHint: "Manage hidden roles, notifications, privacy, and your account",
    icon: "options-outline",
  },
] as const;

export type SettingsDestination = "home" | (typeof settingsDestinations)[number]["id"];

export type SettingsDraftRevisions = {
  jobPreferences: number;
  appSettings: number;
};

export function settingsDraftSyncPlan(
  current: SettingsDraftRevisions,
  synced: SettingsDraftRevisions,
) {
  return {
    jobPreferences: current.jobPreferences === synced.jobPreferences,
    appSettings: current.appSettings === synced.appSettings,
  };
}

type QuietHours = { start: string; end: string; timezone: string };

export function jobPreferencesPayload<TFilter>(draft: {
  filter: TFilter;
  alertsEnabled: boolean;
  delivery: "immediate" | "daily-digest";
  quietHours: QuietHours;
}) {
  return {
    filter: draft.filter,
    alertsEnabled: draft.alertsEnabled,
    alertSettings: {
      delivery: draft.delivery,
      timezone: draft.quietHours.timezone,
      quietHours: draft.quietHours,
    },
  };
}

export function appSettingsPayload<TPush>(draft: {
  applicationReminders: boolean;
  followUpDays: number;
  applicationHandoff: 'window' | 'tab';
  push: TPush;
}) {
  return {
    applicationHandoff: draft.applicationHandoff,
    alertSettings: {
      applicationReminders: draft.applicationReminders,
      followUpDays: draft.followUpDays,
    },
    push: draft.push,
  };
}
