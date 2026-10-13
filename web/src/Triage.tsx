// Triage: a full-screen deck for clearing new posts one at a time. Keep, Read later, Hide or Skip
// with a key, a button or (on a phone) a swipe; z takes the last one back. Every choice is a local
// state change through the same undoable path as the feed. Post text is rendered as text only.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { swipeAction, swipeProgress, tallyLine, triageDeck, triagePatch, triageTally, TRIAGE_LABEL, type TriageAction } from '../../core/triage.ts';
import type { Item } from '../../core/types.ts';
import { agoText, paragraphs, platformLabel } from './format.ts';
import { Icon } from './icons.tsx';
import { reducedMotion } from './motion.tsx';
import type { Reader } from './state.ts';
import { useDialog } from './useDialog.ts';
import './triage.css';

interface Done { item: Item; action: TriageAction; undo: Promise<(() => void) | undefined> }

const KEY_ACTION: Record<string, TriageAction> = {
  ArrowRight: 'keep', l: 'keep',
  ArrowUp: 'later', r: 'later',
  ArrowLeft: 'hide', h: 'hide',
  ArrowDown: 'skip', j: 'skip', ' ': 'skip',
};

const ICON: Record<TriageAction, string> = { keep: 'bookmarkFill', later: 'clock', hide: 'archive', skip: 'check' };
const KEYS: Record<TriageAction, string> = { keep: '→', later: '↑', hide: '←', skip: '↓' };
// Button order follows the arrows: left hides, right keeps.
const BAR: TriageAction[] = ['hide', 'later', 'skip', 'keep'];
const OUT_MS = 180;

const cssUrl = (u: string) => `url("${u.replace(/["\\\n\r]/g, (c) => encodeURIComponent(c))}")`;

function picture(it: Item): string | undefined {
  const img = it.media.find((m) => m.type === 'image');
  return img?.url ?? it.media.find((m) => m.type === 'video')?.thumb ?? it.media.find((m) => m.type === 'link')?.thumb;
}

function TriageCard({ it, sourceLabel, style, className = '', onPointerDown }: {
  it: Item; sourceLabel: string; style?: React.CSSProperties; className?: string; onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
}) {
  const pic = picture(it);
  const [broken, setBroken] = useState(false);
  const paras = paragraphs(it.text).slice(0, 8);
  const hasPic = !!pic && !broken;
  return (
    <article data-id={it.id} className={`tri-card ${hasPic ? 'has-pic' : 'no-pic'} ${className}`} style={style} onPointerDown={onPointerDown} aria-label={`${it.author.name}${it.title ? `: ${it.title}` : ''}`}>
      {hasPic && <img className="tri-pic" src={pic} alt={it.media.find((m) => m.url === pic)?.alt ?? ''} referrerPolicy="no-referrer" draggable={false} onError={() => setBroken(true)} />}
      <div className="tri-body">
        <header className="tri-by">
          {it.author.avatar ? <img className="tri-av" src={it.author.avatar} alt="" referrerPolicy="no-referrer" draggable={false} /> : <span className="tri-av initials" aria-hidden>{it.author.name.slice(0, 1).toUpperCase()}</span>}
          <span className="tri-who">
            <strong>{it.author.name}</strong>
            <span>{sourceLabel} · {agoText(it.publishedAt)}</span>
          </span>
        </header>
        {it.title && <h3 className="tri-title">{it.title}</h3>}
        <div className="tri-text">
          {paras.map((p, i) => <p key={i}>{p}</p>)}
        </div>
      </div>
    </article>
  );
}

export function Triage({ r, items, close }: { r: Reader; items: Item[]; close: () => void }) {
  const dlg = useDialog<HTMLDivElement>();
  // The deck is fixed when Triage opens, so choices never reshuffle what is coming.
  const [deck] = useState(() => triageDeck(items));
  const [idx, setIdx] = useState(0);
  const [done, setDone] = useState<Done[]>([]);
  const [leaving, setLeaving] = useState<{ item: Item; action: TriageAction; key: number } | null>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [said, setSaid] = useState('');
  const cardBox = useRef<HTMLDivElement>(null);
  const still = useMemo(() => reducedMotion(), []);
  const sourceLabel = useCallback((it: Item) => (it.isDemo ? `Demo ${platformLabel(it.platform)}` : r.sourceLabels[it.sourceId] ?? platformLabel(it.platform)), [r.sourceLabels]);

  const current = deck[idx] ?? null;
  const left = deck.length - idx;

  const decide = useCallback((action: TriageAction) => {
    const it = deck[idx];
    if (!it) return;
    const undo = r.changeState([it], triagePatch(action, it), TRIAGE_LABEL[action].past, { quiet: true });
    setDone((d) => [...d, { item: it, action, undo }]);
    setLeaving({ item: it, action, key: Date.now() });
    setIdx((i) => i + 1);
    setDrag(null);
    const rest = deck.length - idx - 1;
    setSaid(`${TRIAGE_LABEL[action].verb === 'Later' ? 'Read later' : TRIAGE_LABEL[action].past[0].toUpperCase() + TRIAGE_LABEL[action].past.slice(1)}. ${rest ? `${rest} left.` : 'The deck is clear.'}`);
  }, [deck, idx, r]);

  const undoLast = useCallback(() => {
    const last = done[done.length - 1];
    if (!last) return;
    setDone((d) => d.slice(0, -1));
    setIdx((i) => Math.max(0, i - 1));
    setLeaving(null);
    void last.undo.then((u) => u?.());
    setSaid(`Took back ${last.item.author.name}'s post.`);
  }, [done]);

  // The card that just left animates out on its own layer, then goes.
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => setLeaving(null), still ? 140 : OUT_MS + 20);
    return () => window.clearTimeout(t);
  }, [leaving, still]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
      // Enter and Space on a focused button belong to that button.
      if ((e.key === ' ' || e.key === 'Enter') && t.closest('button, a')) return;
      const action = KEY_ACTION[e.key];
      if (action && current) { e.preventDefault(); decide(action); return; }
      if (e.key === 'z') { e.preventDefault(); undoLast(); return; }
      if (e.key === 'o' && current) { e.preventDefault(); window.open(current.url, '_blank', 'noopener,noreferrer'); return; }
      if (e.key === 'Enter' && !current) { e.preventDefault(); close(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, decide, undoLast, close]);

  // Swipe: drag the card; let go far enough and the choice is made, otherwise it springs back.
  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('a, button')) return;
    const el = e.currentTarget;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const width = cardBox.current?.clientWidth ?? 400;
    let moved = false;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!moved && Math.hypot(dx, dy) < 6) return;
      moved = true;
      setDrag({ dx, dy });
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      const action = ev.type === 'pointerup' && moved ? swipeAction(ev.clientX - x0, ev.clientY - y0, width) : null;
      if (action) decide(action);
      else setDrag(null);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const width = cardBox.current?.clientWidth ?? 400;
  const hint = drag ? swipeProgress(drag.dx, drag.dy, width) : { action: null, amount: 0 };
  const dragStyle: React.CSSProperties | undefined = drag
    ? { transform: `translate(${drag.dx}px, ${drag.dy}px) rotate(${Math.max(-14, Math.min(14, drag.dx / 18))}deg)`, transition: 'none' }
    : undefined;
  const pic = current ? picture(current) : undefined;
  const tally = triageTally(done);

  return (
    <div ref={dlg} className={`tri ${still ? 'still' : ''}`} role="dialog" aria-modal="true" aria-labelledby="tri-title">
      <div className="tri-sky" aria-hidden>
        {pic ? <div key={pic} className="tri-aura" style={{ backgroundImage: cssUrl(pic) }} /> : <div className="tri-aura plain" />}
      </div>
      <div className={`tri-edge ${hint.action ?? ''}`} aria-hidden style={{ opacity: hint.amount }} />
      <div className="tri-progress" aria-hidden><span style={{ transform: `scaleX(${deck.length ? idx / deck.length : 1})` }} /></div>
      <header className="tri-head">
        <div>
          <h2 id="tri-title">Triage</h2>
          <p className="tri-count">{current ? `${idx + 1} of ${deck.length}` : deck.length ? 'Done' : 'Nothing new'}</p>
        </div>
        <div className="tri-head-tools">
          <button className="icon-btn" onClick={undoLast} disabled={!done.length} aria-label="Undo the last choice (z)" title="Undo (z)"><Icon name="undo" /></button>
          {current && <a className="icon-btn" href={current.url} target="_blank" rel="noopener noreferrer" aria-label="Open the original (o)" title="Open the original (o)"><Icon name="external" /></a>}
          <button className="icon-btn" onClick={close} aria-label="Close Triage" title="Close (Esc)"><Icon name="x" /></button>
        </div>
      </header>

      <div className="tri-stage" ref={cardBox}>
        {current ? (
          <>
            {/* The cards still to come peek out under this one, sized to it. */}
            <div className="tri-deck" data-behind={Math.min(2, left - 1)}>
              <TriageCard key={current.id} it={current} sourceLabel={sourceLabel(current)} className={`top ${drag ? 'dragging' : 'arrive'}`} style={dragStyle} onPointerDown={onPointerDown} />
            </div>
          </>
        ) : (
          <div className="tri-end">
            <div className="tri-orb" aria-hidden />
            <h3>{deck.length ? 'The deck is clear.' : 'Nothing new to clear.'}</h3>
            <p>{deck.length ? tallyLine(tally) : 'Every post in this feed has been seen. New ones land here when they arrive.'}</p>
            <div className="tri-end-actions">
              <button className="btn primary" onClick={close}>Back to the feed</button>
              {done.length > 0 && <button className="btn ghost" onClick={undoLast}>Undo the last one</button>}
            </div>
          </div>
        )}
        {leaving && <TriageCard key={`out-${leaving.key}`} it={leaving.item} sourceLabel={sourceLabel(leaving.item)} className={`leaving out-${leaving.action}`} />}
      </div>

      {current && (
        <nav className="tri-bar" aria-label="Choose">
          {BAR.map((a) => (
            <button key={a} className={`tri-act ${a} ${hint.action === a ? 'hot' : ''}`} onClick={() => decide(a)} aria-keyshortcuts={a === 'skip' ? 'ArrowDown j Space' : a === 'keep' ? 'ArrowRight l' : a === 'later' ? 'ArrowUp r' : 'ArrowLeft h'}>
              <span className="tri-act-ic" aria-hidden><Icon name={ICON[a]} size={20} /></span>
              <span className="tri-act-label">{TRIAGE_LABEL[a].verb}</span>
              <kbd aria-hidden>{KEYS[a]}</kbd>
            </button>
          ))}
        </nav>
      )}
      <p className="sr-only" aria-live="polite">{said}{left === 0 && deck.length ? ` ${tallyLine(tally)}.` : ''}</p>
    </div>
  );
}
