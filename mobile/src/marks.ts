// Highlights and alert hits, for On this day and the source report cards. Both live on the
// computer; the phone asks once per screen and keeps the last answer for offline use.
import { useEffect, useState } from 'react';
import type { HighlightLite } from '../../core/onThisDay.ts';
import { api } from './api';
import { readCache, writeCache } from './cache';

export interface Marks {
  highlights: HighlightLite[];
  /** Item ids that triggered an alert. */
  hits: string[];
}

/** Null until the first answer (or the saved copy) arrives. Either half may be empty. */
export function useMarks(): Marks | null {
  const [marks, setMarks] = useState<Marks | null>(null);
  useEffect(() => {
    let live = true;
    void readCache<Marks>('marks').then((kept) => { if (live && kept) setMarks((m) => m ?? kept); });
    void Promise.all([
      api.allHighlights().then((hs) => hs.map((h) => ({ itemId: h.itemId, quote: h.quote, createdAt: h.createdAt })), () => null),
      api.alertHits().then((a) => a.hits.map((h) => h.itemId), () => null),
    ]).then(([highlights, hits]) => {
      if (!live) return;
      setMarks((m) => {
        // Offline with nothing saved: an empty answer still lets the screens draw.
        const next = { highlights: highlights ?? m?.highlights ?? [], hits: hits ?? m?.hits ?? [] };
        if (highlights !== null || hits !== null) writeCache('marks', next);
        return next;
      });
    });
    return () => { live = false; };
  }, []);
  return marks;
}
