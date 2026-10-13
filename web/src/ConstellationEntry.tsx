// The always-loaded side of Constellation: a tiny global opener (the palette, the rail, What's new
// and ?constellation=1 all open the same thing) and the host that mounts it. The map itself
// (Constellation.tsx, its canvas and styles) loads the first time it opens.

import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { Reader } from './state.ts';

const ConstellationView = lazy(() => import('./Constellation.tsx').then((m) => ({ default: m.ConstellationView })));

const EVT = 'aurora:constellation';

export function openConstellation() {
  window.dispatchEvent(new CustomEvent(EVT));
}

export function constellationFromUrl(search = window.location.search): boolean {
  const v = new URLSearchParams(search).get('constellation');
  return v !== null && v !== '0' && v !== 'false';
}

function clearConstellationUrl() {
  const q = new URLSearchParams(window.location.search);
  if (!q.has('constellation')) return;
  q.delete('constellation');
  const rest = q.toString();
  window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
}

/** Mounted once by the app. */
export function ConstellationHost({ r }: { r: Reader }) {
  const [open, setOpen] = useState(() => constellationFromUrl());
  useEffect(() => {
    const h = () => setOpen(true);
    window.addEventListener(EVT, h);
    return () => window.removeEventListener(EVT, h);
  }, []);
  useEffect(
    () =>
      r.subscribe((e) => {
        if (e.type === 'ui' && e.action?.kind === 'constellation') setOpen(true);
      }),
    [r],
  );
  const close = useCallback(() => {
    setOpen(false);
    clearConstellationUrl();
  }, []);
  if (!open || !r.lib) return null;
  return (
    <Suspense fallback={<div className="lazy-veil lazy-veil-dark" role="status" aria-label="Opening Constellation" />}>
      <ConstellationView key={r.profileId} r={r} close={close} />
    </Suspense>
  );
}
