// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InstallPromptEvent } from '@/pwa/installState';
import { resetInstallState, setOnline, setUpdateOffer } from '@/pwa/installState';
import { useAppStore } from '@/state/store';
import { StatusBar } from '@/ui/StatusBar';

/**
 * The two offers the app makes: install it, or take a new version.
 *
 * Driven through the real component and the real events the browser fires, because
 * the failure mode is a button that never appears - which no amount of unit testing
 * a state object would catch.
 */

function installEvent(outcome: 'accepted' | 'dismissed' = 'accepted'): InstallPromptEvent {
  const event = new Event('beforeinstallprompt') as InstallPromptEvent;
  Object.defineProperty(event, 'prompt', { value: vi.fn(async () => undefined) });
  Object.defineProperty(event, 'userChoice', { value: Promise.resolve({ outcome }) });
  return event;
}

beforeEach(() => {
  resetInstallState();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('installing the app', () => {
  it('offers nothing until the browser says it can be installed', () => {
    render(<StatusBar />);
    expect(screen.queryByRole('button', { name: /Cài đặt app/ })).toBeNull();
  });

  it('offers the install once the browser allows it, and honours the choice', async () => {
    render(<StatusBar />);
    const event = installEvent('accepted');
    window.dispatchEvent(event);

    const button = await screen.findByRole('button', { name: /Cài đặt app/ });
    fireEvent.click(button);

    await waitFor(() => expect(event.prompt).toHaveBeenCalled());
    // Accepted: the offer is gone, because there is nothing left to install.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Cài đặt app/ })).toBeNull());
  });

  it('keeps the offer when the user dismisses it', async () => {
    render(<StatusBar />);
    window.dispatchEvent(installEvent('dismissed'));

    fireEvent.click(await screen.findByRole('button', { name: /Cài đặt app/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Cài đặt app/ })).toBeTruthy());
  });

  it('withdraws the offer once the app is installed', async () => {
    render(<StatusBar />);
    window.dispatchEvent(installEvent());
    await screen.findByRole('button', { name: /Cài đặt app/ });

    window.dispatchEvent(new Event('appinstalled'));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Cài đặt app/ })).toBeNull());
  });
});

describe('taking a new version', () => {
  it('offers the reload only when a new worker is waiting', () => {
    render(<StatusBar />);
    expect(screen.queryByRole('button', { name: /bản mới/ })).toBeNull();
  });

  it('applies the update when the button is pressed', async () => {
    const apply = vi.fn();
    setUpdateOffer({ apply });
    render(<StatusBar />);

    fireEvent.click(await screen.findByRole('button', { name: /bản mới/ }));
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe('noticing there is no network', () => {
  it('says so, so a failed Run is not a mystery', async () => {
    render(<StatusBar />);
    window.dispatchEvent(new Event('offline'));

    expect(await screen.findByText('offline')).toBeTruthy();
    setOnline(true);
  });

  it('stops saying it when the network comes back', async () => {
    render(<StatusBar />);
    window.dispatchEvent(new Event('offline'));
    await screen.findByText('offline');

    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(screen.queryByText('offline')).toBeNull());
  });
});

describe('the status bar still does its own job', () => {
  it('shows the cursor position and the engine behind the watch pane', () => {
    useAppStore.setState({ cursor: { line: 12, column: 5, selected: 0 } });
    render(<StatusBar />);

    expect(screen.getByText(/Ln 12, Col 5/)).toBeTruthy();
    expect(screen.getByText(/watch: /)).toBeTruthy();
  });
});
