// On this day: a quiet card at the top of the feed with up to three posts you saved or highlighted
// on today's date in an earlier month or year, and a sheet (from the palette) with all of them.
// Local only: timestamps the library already has, plus your highlights. No AI.

import { useEffect, useMemo, useState } from 'react';
import { agoLabel, onThisDay, type HighlightLite, type Memory } from '../../core/onThisDay.ts';
import type { Item } from '../../core/types.ts';
import { api } from './api.ts';
import { Icon } from './icons.tsx';
import { lf } from './longform.ts';
import type { Reader } from './state.ts';
import { useDialog } from './useDialog.ts';
import './onThisDay.css';

const DISMISS_KEY = 'aurora.onThisDay.hidden';
const OFF_SETTING = 'ui.onThisDay';
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

let hlOnce: Promise<HighlightLite[]> | null = null;
const loadHighlights = () => (hlOnce ??= lf.highlights().then((l) => l.map((h) => ({ itemId: h.itemId, quote: h.quote, createdAt: h.createdAt })), () => []));

/** Today's memories for the current profile, recomputed when the library or the date changes. */
export function useMemories(r: Reader): Memory[] {
  const [hl, setHl] = useState<HighlightLite[]>([]);
  useEffect(() => {
    let live = true;
    void loadHighlights().then((l) => live && setHl(l));
    return () => {
      live = false;
    };
  }, []);
  const day = today();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => onThisDay(r.lib?.items ?? [], hl), [r.lib, hl, day]);
}

/** Whether the card is turned off (a ui.* setting, so desktop and web agree). */
function useOff(): [boolean, (off: boolean) => void] {
  const [off, setOff] = useState(false);
  useEffect(() => {
    api.getSetting<boolean>(OFF_SETTING).then((s) => setOff(s.value === false), () => {});
  }, []);
  return [off, (v: boolean) => {
    setOff(v);
    void api.putSetting(OFF_SETTING, v ? false : null).catch(() => {});
  }];
}

const lead = (m: Memory) => `${agoLabel(m.monthsAgo)} you ${m.kind === 'saved' ? 'saved' : 'highlighted'}`;
const line = (it: Item) => (it.title || it.text).replace(/\s+/g, ' ').trim().slice(0, 140) || 'A post';

function MemoryRow({ m, openPost }: { m: Memory; openPost: (it: Item) => void }) {
  return (
    <li>
      <button type="button" className="otd-row" onClick={() => openPost(m.item)}>
        <span className="otd-when">{lead(m)}</span>
        <span className="otd-text">{m.quote ? `“${m.quote.replace(/\s+/g, ' ').slice(0, 140)}”` : line(m.item)}</span>
        <span className="otd-who">{m.item.author.name}{m.quote && m.item.title ? ` · ${m.item.title.slice(0, 60)}` : ''}</span>
      </button>
    </li>
  );
}

export function OnThisDayCard({ r, openPost, openAll }: { r: Reader; openPost: (it: Item) => void; openAll: () => void }) {
  const memories = useMemories(r);
  const [off, setOff] = useOff();
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === today();
    } catch {
      return false;
    }
  });
  const [menu, setMenu] = useState(false);
  if (off || hidden || !memories.length) return null;
  const hideToday = () => {
    setHidden(true);
    try {
      localStorage.setItem(DISMISS_KEY, today());
    } catch {
      /* storage blocked: hidden until reload */
    }
  };
  return (
    <section className="otd card-block" aria-label="On this day">
      <div className="otd-head">
        <p className="otd-kick"><Icon name="clock" size={13} /> On this day</p>
        <div className="otd-menu-wrap">
          <button type="button" className="icon-btn small" aria-label="On this day options" aria-expanded={menu} onClick={() => setMenu((v) => !v)}><Icon name="more" size={15} /></button>
          {menu && (
            <div className="otd-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setMenu(false); hideToday(); }}>Hide for today</button>
              <button type="button" role="menuitem" onClick={() => { setMenu(false); setOff(true); r.toast('On this day is off. Turn it back on from the palette, "On this day".', { undo: () => setOff(false) }); }}>Turn off On this day</button>
            </div>
          )}
        </div>
      </div>
      <ul className="otd-list">
        {memories.slice(0, 3).map((m) => <MemoryRow key={m.item.id} m={m} openPost={openPost} />)}
      </ul>
      {memories.length > 3 && <button type="button" className="link-btn otd-more" onClick={openAll}>All {memories.length} from this day</button>}
    </section>
  );
}

export function OnThisDaySheet({ r, close, openPost }: { r: Reader; close: () => void; openPost: (it: Item) => void }) {
  const dlg = useDialog<HTMLDivElement>();
  const memories = useMemories(r);
  const [off, setOff] = useOff();
  const date = new Date().toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  return (
    <div className="sheet-backdrop" onClick={close}>
      <div ref={dlg} className="sheet otd-sheet" role="dialog" aria-modal="true" aria-label="On this day" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>On this day</h2>
          <button className="icon-btn" onClick={close} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="sheet-body">
          <p className="f-hint lead">Posts you saved or highlighted on {date} in earlier months and years{r.profile ? `, in ${r.profile.name}` : ''}.</p>
          {memories.length ? (
            <ul className="otd-list">
              {memories.map((m) => <MemoryRow key={m.item.id} m={m} openPost={(it) => { close(); openPost(it); }} />)}
            </ul>
          ) : (
            <p className="otd-empty">Nothing from this date yet. Save or highlight a few posts and they come back here in a month, and in a year.</p>
          )}
          <label className="switch otd-switch">
            <input type="checkbox" checked={!off} onChange={(e) => setOff(!e.target.checked)} />
            <span>Show on the feed<small>A small card at the top on days that have something.</small></span>
          </label>
        </div>
      </div>
    </div>
  );
}
