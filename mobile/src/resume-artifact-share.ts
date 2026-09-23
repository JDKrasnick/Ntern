import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { publicConfig } from './public-config';

const pdfFileName = (artifactId: string) => `ntern-resume-${artifactId}.pdf`;

const artifactUrl = (artifactId: string, path: string) => `${publicConfig.apiUrl}/me/resume-artifacts/${encodeURIComponent(artifactId)}/${path}`;

async function privateArtifactResponse(artifactId: string, path: string, token: string, accept: string) {
  const response = await fetch(artifactUrl(artifactId, path), { headers: { Accept: accept, Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`We couldn't load that résumé (${response.status}).`);
  return response;
}

export async function loadResumeArtifactSource(artifactId: string, token: string): Promise<string> {
  const response = await privateArtifactResponse(artifactId, 'source', token, 'text/plain');
  if (!response.headers.get('content-type')?.toLowerCase().includes('text/plain')) throw new Error('The résumé service did not return LaTeX source.');
  return response.text();
}

export async function loadResumeArtifactPreview(artifactId: string, page: number, token: string): Promise<string> {
  const response = await privateArtifactResponse(artifactId, `preview/${page}`, token, 'image/png');
  if (!response.headers.get('content-type')?.toLowerCase().includes('image/png')) throw new Error('The résumé service did not return a rendered preview.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (Platform.OS === 'web') return URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return `data:image/png;base64,${btoa(binary)}`;
}

export function releaseResumeArtifactPreview(uri: string | undefined): void {
  if (Platform.OS === 'web' && uri?.startsWith('blob:')) URL.revokeObjectURL(uri);
}

export async function shareResumeArtifact(artifactId: string, token: string): Promise<void> {
  const response = await privateArtifactResponse(artifactId, 'content', token, 'application/pdf');
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
