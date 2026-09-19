/** Education levels an employer can state - browser-safe, shared by API and UI. */

/**
 * Every surface orders these the same way, and the API filter accepts exactly
 * these values, so the list is the single source of truth for both.
 */
export const educationLevels = ['undergraduate', 'masters', 'mba', 'doctoral'] as const;

export type EducationLevel = (typeof educationLevels)[number];

/** Compact labels for filter chips, where a full word does not fit. */
export const educationLevelLabels: Record<EducationLevel, string> = {
  undergraduate: 'Undergrad',
  masters: 'Masters',
  mba: 'MBA',
  doctoral: 'PhD',
};
