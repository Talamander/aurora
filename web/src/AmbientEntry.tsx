// The always-loaded side of Ambient: the listener that opens it. The display itself (Ambient.tsx,
// its slides, fonts and styles) loads the first time it opens.

import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { Item } from '../../core/types.ts';
import { ambientFromUrl, clearAmbientUrl, onOpenAmbient, type AmbientOpen } from './ambient.ts';
import type { Reader } from './state.ts';

const Ambient = lazy(() => import('./Ambient.tsx').then((m) => ({ default: m.Ambient })));

/** Mounted once by the app. Opens Ambient from the palette, the rail, the agent, the desktop shell or ?ambient=1. */
export function AmbientHost({ r, openPost }: { r: Reader; openPost: (it: Item) => void }) {
  const [open, setOpen] = useState<AmbientOpen | null>(() => ambientFromUrl());
  useEffect(() => onOpenAmbient((o) => setOpen({ ...o })), []);
  useEffect(
    () =>
      r.subscribe((e) => {
        if (e.type !== 'ui' || e.action?.kind !== 'ambient') return;
        const a = e.action;
        setOpen({
          view: typeof a.view === 'string' ? a.view : null,
          person: typeof a.person === 'string' ? a.person : null,
          photosOnly: a.photosOnly === true,
          pace: typeof a.pace === 'number' ? a.pace : undefined,
        });
      }),
    [r],
  );
  const close = useCallback(() => {
    setOpen(null);
    clearAmbientUrl();
  }, []);
  if (!open || !r.lib) return null;
  return (
    <Suspense fallback={<div className="lazy-veil lazy-veil-dark" role="status" aria-label="Opening Ambient" />}>
      <Ambient r={r} req={open} close={close} openPost={openPost} />
    </Suspense>
  );
}
