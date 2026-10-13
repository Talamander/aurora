import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';
import './agent.css';
import './workshop.css';
import './alerts.css';
import './search.css';
import { App } from './App.tsx';
import { LockGate } from './Lock.tsx';

// /?quick=1 is Quick look (the desktop app's small window, or a popup-sized page): its own small
// chunk, without booting the app or loading the library.
const QuickLook = lazy(() => import('./QuickLook.tsx').then((m) => ({ default: m.QuickLook })));
const quick = new URLSearchParams(window.location.search).get('quick') === '1';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LockGate>
      {quick ? (
        <Suspense fallback={null}>
          <QuickLook />
        </Suspense>
      ) : (
        <App />
      )}
    </LockGate>
  </StrictMode>,
);
