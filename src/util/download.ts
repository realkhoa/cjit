/**
 * Saving bytes to the user's machine.
 *
 * Kept behind one function so the rest of the app never touches the DOM for this,
 * and so a non-browser environment (tests) reports "could not save" instead of
 * throwing.
 */
export function saveBytes(name: string, bytes: Uint8Array): boolean {
  if (typeof document === 'undefined') return false;

  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);

  let url: string;
  try {
    url = URL.createObjectURL(new Blob([buffer], { type: 'application/octet-stream' }));
  } catch {
    return false;
  }

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // The download starts asynchronously, so the URL cannot be revoked immediately.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

/** `1.2 MB` / `480 KB` / `12 B`, for telling the user what they just got. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
