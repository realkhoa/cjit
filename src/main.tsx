import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/App';
import { registerDefaultEngines } from '@/engine/bootstrap';
import { setupMonacoEnvironment } from '@/editor/monacoSetup';
import '@/ui/theme/tokens.css';
import '@/ui/theme/app.css';

registerDefaultEngines();
setupMonacoEnvironment();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
