// Alerts: "tell me when…" watches and what they caught. Creating one goes through the AI when it
// is ready (it turns a sentence into people, sources, words and a description); without the AI
// the field makes a plain word alert. Notifications never leave this computer.

import { useCallback, useEffect, useState } from 'react';
import { api, type AlertDef, type AlertHitView, type AlertsSummary } from './api.ts';
import { agoText, plural } from './format.ts';
import { Icon } from './icons.tsx';
import { proxied } from './imgProxy.ts';
import { useDialog } from './useDialog.ts';
import type { Library } from '../../core/types.ts';

const EXAMPLES = ['MKBHD posts a phone review', 'anyone in Family posts photos', 'there is news about Rust 2.0', 'a friend shares a long read'];

export function notificationState(): 'granted' | 'denied' | 'default' | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export function AlertsSheet({
  close, lib, toast, ask, aiReady, openPostId, onSeen,
}: {
  close: () => void;
  lib: Library;
  toast: (t: string, o?: { tone?: 'info' | 'error' }) => void;
  ask: (text: string, send?: boolean) => void;
  aiReady: boolean;
  openPostId: (id: string) => void;
  onSeen: () => void;
}) {
  const dlg = useDialog<HTMLDivElement>();
  const [data, setData] = useState<AlertsSummary | null>(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<Record<string, { busy?: boolean; total?: number; checked?: number; matches?: AlertHitView[] }>>({});
  const [confirm, setConfirm] = useState<string | null>(null);
  const [perm, setPerm] = useState(notificationState);
  const desktop = !!window.auroraDesktop;

  const load = useCallback(async () => {
    try {
      setData(await api.alerts());
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  }, [toast]);
  useEffect(() => void load(), [load]);
  // Opening the sheet counts as looking at what fired.
  useEffect(() => {
    if (!data?.unseen) return;
    const t = setTimeout(() => void api.alertsSeen().then(onSeen, () => {}), 1600);
    return () => clearTimeout(t);
  }, [data?.unseen, onSeen]);

  const create = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t) return;
    if (aiReady) {
      ask(`Tell me when ${t.replace(/^(tell me|ping me|alert me|notify me)( when| if| about)?\s*/i, '')}`);
      setText('');
      close();
      return;
    }
    // No AI: a plain word alert from what was typed (comma-separated words or one phrase).
    const words = t.split(',').map((w) => w.trim()).filter(Boolean);
    try {
      await api.createAlert({ keywords: words, name: words.join(', ').slice(0, 60) });
      setText('');
      toast(`Watching for ${words.map((w) => `“${w}”`).join(', ')}`);
      void load();
    } catch (err) {
      toast((err as Error).message, { tone: 'error' });
    }
  };

  const patch = async (a: AlertDef, p: Partial<AlertDef>) => {
    setData((d) => (d ? { ...d, alerts: d.alerts.map((x) => (x.id === a.id ? { ...x, ...p } : x)) } : d));
    try {
      await api.updateAlert(a.id, p);
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
      void load();
    }
  };

  const remove = async (a: AlertDef) => {
    setConfirm(null);
    await api.deleteAlert(a.id).catch((e) => toast((e as Error).message, { tone: 'error' }));
    toast(`Deleted alert “${a.name}”`);
    void load();
  };

  const runPreview = async (a: AlertDef) => {
    setPreview((p) => ({ ...p, [a.id]: { busy: true } }));
    try {
      const r = await api.previewAlert(a.id);
      setPreview((p) => ({ ...p, [a.id]: { total: r.total, checked: r.checked, matches: r.matches } }));
    } catch (e) {
      setPreview((p) => ({ ...p, [a.id]: {} }));
      toast((e as Error).message, { tone: 'error' });
    }
  };

  const setQuiet = async (q: { from: string; to: string } | null) => {
    try {
      const r = await api.setQuietHours(q);
      setData((d) => (d ? { ...d, quiet: r.quiet, quietNow: r.quietNow } : d));
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  };

  const askPermission = async () => {
    if (typeof Notification === 'undefined') return;
    const r = await Notification.requestPermission();
    setPerm(r);
    if (r === 'granted') toast('Notifications are on for this browser');
  };

  const sourceLabel = (id: string) => lib.sources.find((s) => s.id === id)?.label ?? 'a removed source';
  const profileName = (id: string) => lib.profiles?.find((p) => p.id === id)?.name ?? id;
  const hitsFor = (id: string) => data?.hits.filter((h) => h.alertId === id) ?? [];

  return (
    <div className="sheet-backdrop" onClick={close}>
      <div ref={dlg} className="sheet alerts-sheet" role="dialog" aria-modal="true" aria-label="Alerts" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Alerts</h2>
          {data?.quietNow && <span className="alerts-quiet-now"><Icon name="moon" size={13} /> Quiet hours</span>}
          <button className="icon-btn" onClick={close} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="sheet-body">
          <form className="alerts-ask" onSubmit={create}>
            <div className="alerts-ask-row">
              <span className="alerts-bell" aria-hidden><Icon name="bell" size={18} /></span>
              <label className="alerts-ask-l">
                <span>Tell me when</span>
                <input value={text} onChange={(e) => setText(e.target.value)} placeholder={aiReady ? 'MKBHD posts a phone review' : 'Words to watch for, comma-separated'} maxLength={300} aria-label="Tell me when" />
              </label>
              <button className="btn primary small" disabled={!text.trim()}>{aiReady ? 'Ask' : 'Watch'}</button>
            </div>
            {aiReady && (
              <div className="alerts-examples">
                {EXAMPLES.map((x) => (
                  <button type="button" key={x} className="chip" onClick={() => setText(x)}>{x}</button>
                ))}
              </div>
            )}
            {!aiReady && <p className="alerts-hint">The AI is not set up, so alerts match words only. With the AI, you can describe what you want in a sentence.</p>}
          </form>

          {data && data.alerts.length > 0 && (
            <section className="alerts-sec">
              <h3>Watching</h3>
              <ul className="alerts-list">
                {data.alerts.map((a) => {
                  const pv = preview[a.id];
                  const caught = hitsFor(a.id);
                  return (
                    <li key={a.id} className={`alert-card ${a.paused ? 'paused' : ''}`}>
                      <div className="alert-top">
                        <div className="alert-title">
                          <b>{a.name}</b>
                          <small>{a.hits ? `${plural(a.hits, 'match', 'matches')}${a.lastHitAt ? ` · last ${agoText(a.lastHitAt)}` : ''}` : a.paused ? 'Paused' : 'Nothing yet'}</small>
                        </div>
                        <label className="switch alert-switch" title={a.paused ? 'Resume' : 'Pause'}>
                          <input type="checkbox" checked={!a.paused} onChange={() => void patch(a, { paused: !a.paused })} aria-label={a.paused ? `Resume ${a.name}` : `Pause ${a.name}`} />
                        </label>
                      </div>
                      <div className="alert-chips">
                        {a.authors.map((x) => <span key={`a${x}`} className="alert-chip"><Icon name="people" size={12} /> {x}</span>)}
                        {a.sources.map((x) => <span key={`s${x}`} className="alert-chip"><Icon name="layers" size={12} /> {sourceLabel(x)}</span>)}
                        {a.keywords.map((x) => <span key={`k${x}`} className="alert-chip"><Icon name="search" size={12} /> {x}</span>)}
                        {a.media && <span className="alert-chip"><Icon name={a.media === 'image' ? 'image' : 'video'} size={12} /> {a.media === 'image' ? 'Photos' : 'Videos'}</span>}
                        {a.profile && <span className="alert-chip"><Icon name="star" size={12} /> {profileName(a.profile)}</span>}
                        {a.prompt && <span className="alert-chip ai"><Icon name="sparkle" size={12} /> {a.prompt}</span>}
                      </div>
                      {caught.length > 0 && (
                        <ul className="alert-caught">
                          {caught.slice(0, 3).map((h) => <HitRow key={h.id} h={h} open={() => { openPostId(h.itemId); close(); }} compact />)}
                        </ul>
                      )}
                      {pv && !pv.busy && pv.total !== undefined && (
                        <div className="alert-preview">
                          <p>{pv.total ? `Over the last week this would have caught ${plural(pv.total, 'post')}.` : `Nothing in the last week (${plural(pv.checked ?? 0, 'post')} checked).`}</p>
                          {!!pv.matches?.length && (
                            <ul className="alert-caught">
                              {pv.matches.slice(0, 4).map((h) => <HitRow key={h.itemId} h={h} open={() => { openPostId(h.itemId); close(); }} compact />)}
                            </ul>
                          )}
                        </div>
                      )}
                      <div className="alert-actions">
                        <button className="btn ghost small" disabled={pv?.busy} onClick={() => void runPreview(a)}>
                          {pv?.busy ? <><span className="spin" aria-hidden /> Looking back…</> : <><Icon name="eye" size={14} /> What would it catch?</>}
                        </button>
                        {confirm === a.id ? (
                          <button className="btn danger small" onClick={() => void remove(a)}>Delete?</button>
                        ) : (
                          <button className="icon-btn small" aria-label={`Delete ${a.name}`} onClick={() => setConfirm(a.id)}><Icon name="trash" size={14} /></button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {data && data.alerts.length === 0 && (
            <div className="alerts-empty">
              <div className="alerts-empty-orb" aria-hidden><Icon name="bell" size={26} /></div>
              <p><b>Nothing is being watched yet.</b></p>
              <p>Say what you never want to miss. Aurora checks every new post after each sync and tells you here, in the status bar and on your paired phone.</p>
            </div>
          )}

          {data && data.hits.length > 0 && (
            <section className="alerts-sec">
              <h3>Caught recently</h3>
              <ul className="alert-caught big">
                {data.hits.slice(0, 30).map((h) => <HitRow key={h.id} h={h} open={() => { openPostId(h.itemId); close(); }} />)}
              </ul>
            </section>
          )}

          <section className="alerts-sec alerts-settings">
            <h3>Notifications</h3>
            <div className="alerts-setting">
              <div>
                <b>{desktop ? 'Desktop notifications' : 'Browser notifications'}</b>
                <small>
                  {desktop
                    ? 'The Aurora app notifies you when its window is not in front.'
                    : perm === 'granted'
                      ? 'On for this browser. You also get a toast while Aurora is open.'
                      : perm === 'denied'
                        ? 'Blocked in this browser’s site settings. Toasts still show while Aurora is open.'
                        : perm === 'unsupported'
                          ? 'This browser cannot show notifications. Toasts still show while Aurora is open.'
                          : 'Off. Toasts still show while Aurora is open.'}
                </small>
              </div>
              {!desktop && perm === 'default' && <button className="btn small" onClick={() => void askPermission()}><Icon name="bell" size={14} /> Turn on</button>}
            </div>
            <div className="alerts-setting">
              <div>
                <b>Quiet hours</b>
                <small>Alerts still collect here, without a sound or a pop-up.</small>
              </div>
              <label className="switch">
                <input type="checkbox" checked={!!data?.quiet} onChange={(e) => void setQuiet(e.target.checked ? { from: '22:00', to: '07:00' } : null)} aria-label="Quiet hours" />
              </label>
            </div>
            {data?.quiet && (
              <div className="alerts-quiet">
                <label>From <input type="time" value={data.quiet.from} onChange={(e) => e.target.value && void setQuiet({ from: e.target.value, to: data.quiet!.to })} /></label>
                <label>to <input type="time" value={data.quiet.to} onChange={(e) => e.target.value && void setQuiet({ from: data.quiet!.from, to: e.target.value })} /></label>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function HitRow({ h, open, compact }: { h: AlertHitView; open: () => void; compact?: boolean }) {
  const it = h.item;
  if (!it) return null;
  const pic = proxied(it.avatar);
  return (
    <li className={`hit ${h.seen ? '' : 'unseen'} ${compact ? 'compact' : ''}`}>
      <button onClick={open}>
        {pic ? <img className="hit-av" src={pic} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="hit-av none" aria-hidden>{it.author.slice(0, 1).toUpperCase()}</span>}
        <span className="hit-main">
          <span className="hit-line">
            <b>{it.author}</b>
            {!compact && <span className="hit-alert">{h.alertName}</span>}
            {h.at && <time>{agoText(h.at)}</time>}
          </span>
          <span className="hit-text">{it.text}</span>
          {h.reason && <span className="hit-why"><Icon name="sparkle" size={11} /> {h.reason}</span>}
        </span>
      </button>
    </li>
  );
}
