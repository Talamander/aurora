// The mini-player for the listen queue: a small glass bar that floats just above the lens dock
// (or the phone tab bar), with the queue folding out above it. Keys: p plays or pauses anywhere
// outside a text field and an open dialog; space does the same while the player has focus.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './icons.tsx';
import { canListen } from './Listen.tsx';
import { listen, RATES, useListenQueue } from './listenQueue.ts';
import './listen.css';

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

/** Where the bar sits: just above whatever docks at the bottom of the screen. */
function useDockOffset(active: boolean) {
  const [pos, setPos] = useState<{ bottom: number; center: number | null }>({ bottom: 16, center: null });
  useLayoutEffect(() => {
    if (!active) return;
    const measure = () => {
      let top = Infinity;
      let center: number | null = null;
      for (const el of document.querySelectorAll<HTMLElement>('.lens-dock, .tabbar, .page-dock')) {
        const r = el.getBoundingClientRect();
        if (!r.height || !r.width || r.top >= window.innerHeight) continue;
        if (r.top < top) {
          top = r.top;
          center = r.left + r.width / 2;
        }
      }
      const bottom = Number.isFinite(top) ? Math.max(16, window.innerHeight - top + 10) : 16;
      setPos((p) => (p.bottom === bottom && p.center === center ? p : { bottom, center }));
    };
    measure();
    const t = window.setInterval(measure, 1000);
    window.addEventListener('resize', measure);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('resize', measure);
    };
  }, [active]);
  return pos;
}

function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => (canListen ? speechSynthesis.getVoices() : []));
  useEffect(() => {
    if (!canListen) return;
    const upd = () => setVoices(speechSynthesis.getVoices());
    speechSynthesis.addEventListener?.('voiceschanged', upd);
    upd();
    return () => speechSynthesis.removeEventListener?.('voiceschanged', upd);
  }, []);
  return voices;
}

export function ListenPlayer({ toast, postText }: { toast: (text: string, opts?: { tone?: 'info' | 'error' }) => void; postText: (id: string) => string | undefined }) {
  const q = useListenQueue();
  const voices = useVoices();
  const box = useRef<HTMLDivElement>(null);
  const visible = q.entries.length > 0;
  const pos = useDockOffset(visible);
  const playing = q.status === 'playing' || q.status === 'loading';
  const cur = q.entries[q.index];

  useEffect(() => listen.setPostText(postText), [postText]);

  // The queue reports through window events, so it needs no reference to the app's toasts.
  useEffect(() => {
    const on = (e: Event) => toast(String((e as CustomEvent).detail));
    window.addEventListener('aurora:toast', on);
    return () => window.removeEventListener('aurora:toast', on);
  }, [toast]);
  const lastErr = useRef<string | null>(null);
  useEffect(() => {
    if (q.error && q.error !== lastErr.current) toast(q.error, { tone: 'error' });
    lastErr.current = q.error;
  }, [q.error, toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      // p belongs to whatever full-screen view is open (Week, Ambient and the reader use it).
      if (e.key === 'p' && !document.querySelector('[aria-modal="true"]')) {
        e.preventDefault();
        listen.toggle();
      } else if (e.key === ' ' && box.current?.contains(e.target as Node) && (e.target as HTMLElement).tagName !== 'BUTTON') {
        e.preventDefault();
        listen.toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!visible || !cur) return null;
  const pct = q.paras ? Math.round(((q.para + 1) / q.paras) * 100) : 0;
  const left = pos.center == null ? '50%' : `clamp(min(50%, 296px), ${pos.center}px, calc(100% - min(50%, 296px)))`;
  const ahead = q.entries.length - q.index - 1;

  return (
    <div
      ref={box}
      className={`lq ${q.open ? 'open' : ''}`}
      role="region"
      aria-label="Listening"
      style={{ bottom: pos.bottom, left }}
      tabIndex={-1}
    >
      {q.open && (
        <div className="lq-panel">
          <div className="lq-panel-head">
            <h2>Up next</h2>
            <label className="lq-voice">
              <span>Voice</span>
              <select value={q.voice ?? ''} onChange={(e) => listen.setVoice(e.target.value || null)}>
                <option value="">Browser default</option>
                {voices.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>{v.name}{v.lang ? ` (${v.lang})` : ''}</option>
                ))}
              </select>
            </label>
          </div>
          <ol className="lq-list">
            {q.entries.map((e, i) => (
              <li key={e.key} className={i === q.index ? 'now' : i < q.index ? 'done' : ''}>
                <button className="lq-item" onClick={() => listen.jump(i)} aria-current={i === q.index ? 'true' : undefined}>
                  <span className="lq-n" aria-hidden>{i === q.index ? <Icon name={playing ? 'play' : 'pause'} size={12} /> : i + 1}</span>
                  <span className="lq-item-text">
                    <span className="lq-item-title">{e.title}</span>
                    <span className="lq-item-by">{e.kind === 'page' ? 'Page' : e.by}</span>
                  </span>
                </button>
                <span className="lq-item-tools">
                  <button className="icon-btn small" onClick={() => listen.move(i, -1)} disabled={i === 0} aria-label={`Move ${e.title} up`}><Icon name="arrowUp" size={14} /></button>
                  <button className="icon-btn small lq-down" onClick={() => listen.move(i, 1)} disabled={i === q.entries.length - 1} aria-label={`Move ${e.title} down`}><Icon name="arrowUp" size={14} /></button>
                  <button className="icon-btn small" onClick={() => listen.remove(i)} aria-label={`Remove ${e.title} from the queue`}><Icon name="x" size={14} /></button>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="lq-bar">
        <button className="lq-play" onClick={() => listen.toggle()} aria-label={playing ? 'Pause (p)' : 'Play (p)'} title={playing ? 'Pause (p)' : 'Play (p)'}>
          <Icon name={playing ? 'pause' : 'play'} size={18} />
        </button>
        <div className="lq-now">
          <div className="lq-title" title={cur.title}>{q.status === 'loading' ? 'Fetching the article…' : cur.title}</div>
          <div className="lq-meta">
            <span className="lq-by">{cur.kind === 'page' ? 'Page' : cur.by}</span>
            {q.paras > 0 && <span className="lq-count">{q.para + 1} of {q.paras}</span>}
          </div>
          <div className="lq-progress" role="progressbar" aria-label="Progress through this article" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="lq-tools">
          <button className="icon-btn small lq-hide-narrow" onClick={() => listen.prevPara()} aria-label="Previous paragraph" title="Previous paragraph"><Icon name="paraPrev" size={16} /></button>
          <button className="icon-btn small" onClick={() => listen.nextPara()} aria-label="Next paragraph" title="Next paragraph"><Icon name="paraNext" size={16} /></button>
          <button className="icon-btn small" onClick={() => listen.nextEntry()} aria-label={ahead ? 'Next article' : 'Finish'} title={ahead ? 'Next article' : 'Finish'} disabled={!ahead && q.status === 'idle'}><Icon name="skipNext" size={15} /></button>
          <button className="lq-rate" onClick={() => listen.setRate(RATES[(RATES.indexOf(q.rate) + 1) % RATES.length] ?? 1)} aria-label={`Speed ${q.rate} times, change`} title="Speed">
            {q.rate}×
          </button>
          <button className={`lq-queue ${q.open ? 'on' : ''}`} onClick={() => listen.setOpen(!q.open)} aria-expanded={q.open} aria-label={`Queue, ${ahead} up next`} title="Queue and voice">
            <Icon name="layers" size={15} />
            {ahead > 0 && <span>{ahead}</span>}
          </button>
          <button className="icon-btn small" onClick={() => listen.stop()} aria-label="Stop and clear the queue" title="Stop"><Icon name="x" size={15} /></button>
        </div>
      </div>
    </div>
  );
}
