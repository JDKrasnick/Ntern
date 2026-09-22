export type AccountExportResponse = {
  schemaVersion: number;
  exportedAt: string;
  account: {
    profile: Record<string, unknown> | null;
    applications: Array<Record<string, unknown>>;
    documents: Array<{ documentId: string; fileName: string; contentType: string; createdAt: string }>;
    resume?: {
      bankItems: Array<Record<string, unknown>>;
      profiles: Array<Record<string, unknown>>;
      drafts: Array<Record<string, unknown>>;
      imports: Array<Record<string, unknown>>;
      artifacts: Array<Record<string, unknown>>;
    };
  };
};

export type CompleteDataExport = AccountExportResponse & {
  currentInstallation: { preferences: Record<string, unknown> };
};

export class DataExportFetchError extends Error {
  constructor(readonly completed: 'account' | 'installation' | 'neither') {
    super(completed === 'neither'
      ? 'Neither account data nor device settings could be fetched. Please try again.'
      : `${completed === 'account' ? 'Account data' : 'Device settings'} loaded, but the export is incomplete. Nothing was shared; please retry.`);
    this.name = 'DataExportFetchError';
  }
}

export class SharingUnavailableError extends Error {
  constructor() {
    super('Sharing is unavailable on this device. Your export was generated, but no file was shared.');
    this.name = 'SharingUnavailableError';
  }
}

export async function buildCompleteDataExport(input: {
  fetchAccount: () => Promise<AccountExportResponse>;
  fetchInstallationPreferences: () => Promise<Record<string, unknown>>;
}): Promise<CompleteDataExport> {
  const [accountResult, installationResult] = await Promise.allSettled([
    input.fetchAccount(),
    input.fetchInstallationPreferences(),
  ]);
  if (accountResult.status === 'rejected' || installationResult.status === 'rejected') {
    throw new DataExportFetchError(
      accountResult.status === 'fulfilled' ? 'account'
        : installationResult.status === 'fulfilled' ? 'installation'
          : 'neither',
    );
  }
  const { userId: _installationId, ...preferences } = installationResult.value;
  return { ...accountResult.value, currentInstallation: { preferences } };
}

export function serializeDataExport(value: CompleteDataExport) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function dataExportFileName(exportedAt: string) {
  const parsed = new Date(exportedAt);
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return `internnotifs-data-${date.toISOString().slice(0, 10)}.json`;
}
