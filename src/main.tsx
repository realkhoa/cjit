import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/App';
import { registerDefaultEngines } from '@/engine/bootstrap';
import { setupMonacoEnvironment } from '@/editor/monacoSetup';
import { setUpdateOffer } from '@/pwa/installState';
import { registerServiceWorker } from '@/pwa/register';
import { startInitialAnalysis, useAppStore } from '@/state/store';
import '@/ui/theme/tokens.css';
import '@/ui/theme/app.css';

registerDefaultEngines();
setupMonacoEnvironment();

/*
 * A production build is wrapped in a service worker, so the app shell and its hashed
 * assets work offline and the app can be installed. In development this does nothing:
 * a worker in front of the dev server caches the module graph and hides every edit.
 */
registerServiceWorker({
  onUpdateReady: (update) => setUpdateOffer(update),
});

// A share link in the URL fragment replaces the stored workspace, so it wins over
// the first analysis pass; the panes are populated before the user types anything.
void (async () => {
  await useAppStore.getState().loadSharedWorkspace();
  await startInitialAnalysis();
})();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
