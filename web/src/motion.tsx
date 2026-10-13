// Small motion pieces: the icon beat on save / read later / hide, the feed's glide when the view
// changes, loading skeletons and phone pull-to-refresh. Transform and opacity only, and all of
// it steps aside when the reader asks for reduced motion.

import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.tsx';

export const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Click-capture handler for a post's action row: gives the pressed action's icon a short beat. */
export function popAction(e: React.MouseEvent<HTMLElement>) {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.pa');
  if (!b || !e.currentTarget.contains(b) || reducedMotion()) return;
  const t = b.title;
  const kind = t.startsWith('Save') ? 'save' : t.startsWith('Read later') ? 'later' : t.startsWith('Hide') || t.startsWith('Bring back') ? 'hide' : null;
  // Only the "turning on" direction gets a beat; undoing something stays quiet.
  if (!kind || ((kind === 'save' || kind === 'later') && b.classList.contains('on'))) return;
  delete b.dataset.pop;
  void b.offsetWidth;
  b.dataset.pop = kind;
  b.addEventListener('animationend', () => delete b.dataset.pop, { once: true });
}

/** The feed settles in from a few pixels below when the view changes. Not on first paint. */
export function useViewGlide(container: React.RefObject<HTMLElement>, selector: string, key: unknown) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = container.current?.querySelector(selector);
    if (!el || reducedMotion() || !el.animate) return;
    el.animate([{ opacity: 0.35, transform: 'translate3d(0, 10px, 0)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function SkeletonCards({ count = 3, label }: { count?: number; label?: string }) {
  return (
    <div className="skel-list" role={label ? 'status' : undefined} aria-hidden={label ? undefined : true}>
      {label && <span className="skel-label">{label}</span>}
      {Array.from({ length: count }, (_, i) => (
        <div className="skel-card" key={i} aria-hidden>
          <div className="skel-who"><i className="skel-av" /><i className="skel-line" style={{ width: '32%' }} /></div>
          <i className="skel-line big" style={{ width: i % 2 ? '64%' : '82%' }} />
          <i className="skel-line" style={{ width: '94%' }} />
          <i className="skel-line" style={{ width: i % 2 ? '58%' : '71%' }} />
        </div>
      ))}
    </div>
  );
}

/** Stand-in for a sheet whose code is still loading. */
export function SheetSkeleton({ label, close }: { label: string; close?: () => void }) {
  return (
    <div className="sheet-backdrop" onClick={close}>
      <div className="sheet skel-sheet" role="status" aria-label={`Opening ${label}`}>
        <div className="sheet-head"><h2>{label}</h2></div>
        <div className="sheet-body"><SkeletonCards count={2} /></div>
      </div>
    </div>
  );
}

const PULL_READY = 64;

/** Pull down at the top of the feed on a phone to sync. Returns the indicator to render. */
export function PullToRefresh({ scroller, onRefresh, enabled }: { scroller: React.RefObject<HTMLElement>; onRefresh: () => Promise<unknown>; enabled: boolean }) {
  const ind = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'idle' | 'pull' | 'ready' | 'busy'>('idle');
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  useEffect(() => {
    const el = scroller.current;
    if (!el || !enabled) return;
    let y0 = -1;
    let dy = 0;
    let busy = false;
    let shown: 'idle' | 'pull' | 'ready' = 'idle';
    const paint = (d: number, settle = false) => {
      const n = ind.current;
      if (!n) return;
      n.classList.toggle('settle', settle);
      const still = reducedMotion();
      n.style.transform = `translate3d(-50%, ${Math.min(d, 92) - 52}px, 0)${still ? '' : ` rotate(${Math.round(d * 2.6)}deg)`}`;
      n.style.opacity = String(Math.min(1, d / PULL_READY));
    };
    const mark = (s: typeof shown) => {
      if (s !== shown) setState((shown = s));
    };
    const start = (e: TouchEvent) => {
      if (busy || el.scrollTop > 0 || e.touches.length !== 1) return;
      y0 = e.touches[0].clientY;
      dy = 0;
    };
    const move = (e: TouchEvent) => {
      if (y0 < 0) return;
      if (el.scrollTop > 0) {
        y0 = -1;
        paint(0, true);
        mark('idle');
        return;
      }
      dy = Math.max(0, (e.touches[0].clientY - y0) * 0.5);
      paint(dy);
      mark(dy >= PULL_READY ? 'ready' : dy > 4 ? 'pull' : 'idle');
    };
    const end = () => {
      if (y0 < 0) return;
      y0 = -1;
      if (dy >= PULL_READY) {
        busy = true;
        paint(PULL_READY, true);
        setState('busy');
        void refresh.current().finally(() => {
          busy = false;
          shown = 'idle';
          setState('idle');
          paint(0, true);
        });
      } else {
        paint(0, true);
        mark('idle');
      }
      dy = 0;
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: true });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
    };
  }, [scroller, enabled]);
  if (!enabled) return null;
  return (
    <>
      <div ref={ind} className={`ptr ${state}`} aria-hidden>
        <Icon name={state === 'ready' ? 'arrowUp' : 'sync'} size={18} />
      </div>
      <span className="skel-label" role="status">{state === 'busy' ? 'Syncing your feeds' : state === 'ready' ? 'Release to sync' : ''}</span>
    </>
  );
}
