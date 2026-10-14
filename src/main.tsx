import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/App';
import { registerDefaultEngines } from '@/engine/bootstrap';
import { setupMonacoEnvironment } from '@/editor/monacoSetup';
import { startInitialAnalysis } from '@/state/store';
import '@/ui/theme/tokens.css';
import '@/ui/theme/app.css';

registerDefaultEngines();
setupMonacoEnvironment();

// Populate the panes before the user types anything.
void startInitialAnalysis();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
