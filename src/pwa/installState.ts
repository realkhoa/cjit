/**
 * Whether there is an app to install, and whether a new version is waiting.
 *
 * A tiny module-level store rather than context: the install prompt arrives from a
 * browser event on `window` and the update from the service worker's registration, so
 * the state does not belong to any one component. Keeping it here also keeps the
 * hook a pure subscription, which is what the tests drive.
 */

export interface InstallPromptEvent extends Event {
  readonly platforms?: readonly string[];
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed' }>;
}

export interface UpdateOffer {
  readonly apply: () => void;
}

interface InstallState {
  readonly prompt: InstallPromptEvent | null;
  readonly update: UpdateOffer | null;
  readonly online: boolean;
}

const listeners = new Set<() => void>();

let state: InstallState = { prompt: null, update: null, online: true };

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function installSnapshot(): InstallState {
  return state;
}

export function setInstallPrompt(prompt: InstallPromptEvent | null): void {
  state = { ...state, prompt };
  emit();
}

export function setUpdateOffer(update: UpdateOffer | null): void {
  state = { ...state, update };
  emit();
}

export function setOnline(online: boolean): void {
  state = { ...state, online };
  emit();
}

/** For tests, which run one case after another in the same module instance. */
export function resetInstallState(): void {
  state = { prompt: null, update: null, online: true };
  listeners.clear();
}
