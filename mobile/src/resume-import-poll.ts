export type ResumeImportStatus = 'ready' | 'pending' | 'manual-description-required';

export async function pollResumeImport<T extends { status: ResumeImportStatus }>(
  read: () => Promise<T>,
  options: { attempts?: number; intervalMs?: number; wait?: (milliseconds: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = options.attempts ?? 10;
  const intervalMs = options.intervalMs ?? 1_500;
  const wait = options.wait ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let value = await read();
  for (let attempt = 1; value.status === 'pending' && attempt < attempts; attempt += 1) {
    await wait(intervalMs);
    value = await read();
  }
  return value;
}
