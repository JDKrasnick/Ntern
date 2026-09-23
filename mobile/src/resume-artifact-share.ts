import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { publicConfig } from './public-config';

const pdfFileName = (artifactId: string) => `ntern-resume-${artifactId}.pdf`;

export async function shareResumeArtifact(artifactId: string, token: string): Promise<void> {
  const response = await fetch(`${publicConfig.apiUrl}/me/resume-artifacts/${encodeURIComponent(artifactId)}/content`, {
    headers: { Accept: 'application/pdf', Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`We couldn't download that résumé (${response.status}).`);
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/pdf')) throw new Error('The résumé service did not return a PDF.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 4 || String.fromCharCode(...bytes.slice(0, 4)) !== '%PDF') throw new Error('The downloaded résumé is not a valid PDF.');
  const fileName = pdfFileName(artifactId);
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    return;
  }
  if (!await Sharing.isAvailableAsync()) throw new Error('Sharing is not available on this device.');
  const file = new File(Paths.cache, fileName);
  file.create({ overwrite: true, intermediates: true });
  try {
    file.write(bytes);
    await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: 'Save or share résumé' });
  } finally {
    file.delete();
  }
}
