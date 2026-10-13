// The always-loaded side of Front page: a tiny global opener (the palette, What's new and ?front=1
// all open the same thing) and the host that mounts it. The page itself loads the first time.

import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { Item } from '../../core/types.ts';
import type { Reader } from './state.ts';

const FrontPageView = lazy(() => import('./FrontPage.tsx').then((m) => ({ default: m.FrontPageView })));

const EVT = 'aurora:front';

export function openFrontPage() {
  window.dispatchEvent(new CustomEvent(EVT));
}

export function frontFromUrl(search = window.location.search): boolean {
  const v = new URLSearchParams(search).get('front');
  return v !== null && v !== '0' && v !== 'false';
}

function clearFrontUrl() {
  const q = new URLSearchParams(window.location.search);
  if (!q.has('front')) return;
  q.delete('front');
  const rest = q.toString();
  window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
}

/** Mounted once by the app. `open` shows a story in the reader or the feed. */
export function FrontPageHost({ r, open }: { r: Reader; open: (it: Item) => void }) {
  const [shown, setShown] = useState(() => frontFromUrl());
  useEffect(() => {
    const h = () => setShown(true);
    window.addEventListener(EVT, h);
    return () => window.removeEventListener(EVT, h);
  }, []);
  const close = useCallback(() => {
    setShown(false);
    clearFrontUrl();
  }, []);
  if (!shown || !r.lib) return null;
  return (
    <Suspense fallback={<div className="lazy-veil" role="status" aria-label="Opening the front page" />}>
      <FrontPageView key={r.profileId} r={r} close={close} open={(it) => { close(); open(it); }} />
    </Suspense>
  );
}
