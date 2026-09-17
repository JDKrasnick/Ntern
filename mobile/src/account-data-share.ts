import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { dataExportFileName, serializeDataExport, SharingUnavailableError, type CompleteDataExport } from './account-data-export';

export async function shareDataExport(value: CompleteDataExport): Promise<void> {
  const fileName = dataExportFileName(value.exportedAt);
  const contents = serializeDataExport(value);
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    return;
  }
  if (!await Sharing.isAvailableAsync()) throw new SharingUnavailableError();
  const file = new File(Paths.cache, fileName);
  file.create({ overwrite: true, intermediates: true });
  try {
    file.write(contents);
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/json',
      UTI: 'public.json',
      dialogTitle: 'Export Ntern data',
    });
  } finally {
    file.delete();
  }
}
