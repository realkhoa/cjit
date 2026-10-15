import { useEffect, useSyncExternalStore } from 'react';
import type { InstallPromptEvent } from '@/pwa/installState';
import {
  installSnapshot,
  setInstallPrompt,
  setOnline,
  subscribeInstall,
} from '@/pwa/installState';

/**
 * What the app can offer: install it, take a new version, or notice it is offline.
 *
 * The listener for `beforeinstallprompt` is registered with `preventDefault`, which
 * is what stops Chrome showing its own mini-infobar and lets the app put the offer
 * somewhere it will not be missed.
 */
export interface InstallActions {
  readonly canInstall: boolean;
  /** True when a new version is installed and waiting for the user's word. */
  readonly updateReady: boolean;
  readonly offline: boolean;
  install: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
  applyUpdate: () => void;
}

export function useInstall(): InstallActions {
  const state = useSyncExternalStore(subscribeInstall, installSnapshot, installSnapshot);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onPrompt = (event: Event): void => {
      // Without this, Chrome decides where and when to offer the install.
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };

    const onInstalled = (): void => setInstallPrompt(null);
    const onOnline = (): void => setOnline(true);
    const onOffline = (): void => setOnline(false);

    setOnline(navigator.onLine !== false);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const prompt = state.prompt;

  return {
    canInstall: prompt !== null,
    updateReady: state.update !== null,
    offline: !state.online,
    install: async () => {
      if (!prompt) return 'unavailable';
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === 'accepted') setInstallPrompt(null);
      return choice.outcome;
    },
    applyUpdate: () => state.update?.apply(),
  };
}
