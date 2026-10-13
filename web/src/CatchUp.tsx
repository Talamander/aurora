// "Since you were away": when the reader comes back after a few hours, a card above the feed
// sums up what arrived (by source, by person, by AI rule) and can ask the AI for a short brief.
// The last-seen time lives in this browser only, one per profile.

import { useEffect, useMemo, useState } from 'react';
import type { Evaluation } from '../../core/filter.ts';
import type { Item } from '../../core/types.ts';
import { api } from './api.ts';
import { Icon } from './icons.tsx';
import { RichText } from './rich.tsx';
import type { Reader } from './state.ts';

const LS_BASE = 'sr.lastSeen';
const SS_BASE = 'sr.catchupFrom'; // survives a reload in the same tab, so the card does not vanish
const MIN_GAP = 3 * 3_600_000;
const AWAY = 2 * 3_600_000;

function read(key: string, s: Storage | undefined): string | null {
  try {
    return s?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function write(key: string, v: string | null, s: Storage | undefined) {
  try {
    if (v === null) s?.removeItem(key);
    else s?.setItem(key, v);
  } catch {
    /* storage blocked */
  }
}
const local = () => (typeof localStorage === 'undefined' ? undefined : localStorage);
const session = () => (typeof sessionStorage === 'undefined' ? undefined : sessionStorage);

/** The time the reader last looked at this profile before this visit, or null on a first visit. */
export function useLastSeen(profileId = 'all') {
  const LS = profileId === 'all' ? LS_BASE : `${LS_BASE}.${profileId}`;
  const SS = profileId === 'all' ? SS_BASE : `${SS_BASE}.${profileId}`;
  const [since, setSince] = useState<string | null>(() => read(SS, session()) ?? read(LS, local()));
  useEffect(() => {
    const since = read(SS, session()) ?? read(LS, local());
    setSince(since);
    if (since && Date.now() - Date.parse(since) >= MIN_GAP) write(SS, since, session());
    let hiddenAt = 0;
    const now = () => write(LS, new Date().toISOString(), local());
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') now();
    }, 60_000);
    const vis = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        now();
      } else if (hiddenAt && Date.now() - hiddenAt > AWAY) {
        const prev = read(LS, local());
        setSince(prev);
        if (prev) write(SS, prev, session());
      }
    };
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('pagehide', now);
    return () => {
      // Leaving a profile counts as having looked at it.
      now();
      write(SS, null, session());
      clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('pagehide', now);
    };
  }, [profileId]); // eslint-disable-line react-hooks/exhaustive-deps
  const markSeen = () => {
    const n = new Date().toISOString();
    write(LS, n, local());
    write(SS, null, session());
    setSince(n);
  };
  return { since, markSeen };
}

function sinceLabel(iso: string): string {
  const d = new Date(iso);
  const hours = (Date.now() - d.getTime()) / 3_600_000;
  const when = d.toLocaleString(undefined, { weekday: hours > 20 ? 'short' : undefined, hour: 'numeric', minute: '2-digit' });
  const away = hours < 36 ? `${Math.round(hours)} hours away` : `${Math.round(hours / 24)} days away`;
  return `Since ${when} · ${away}`;
}

export function freshSince(visible: Evaluation[], since: string | null): Evaluation[] {
  if (!since) return [];
  const t = Date.parse(since);
  return visible.filter((ev) => Date.parse(ev.item.ingestedAt ?? ev.item.publishedAt) > t);
}

interface Props {
  r: Reader;
  visible: Evaluation[];
  since: string | null;
  markSeen: () => void;
  newOnly: boolean;
  setNewOnly: (on: boolean) => void;
  openPost: (it: Item) => void;
  triage?: () => void;
}

export function CatchUpCard({ r, visible, since, markSeen, newOnly, setNewOnly, openPost, triage }: Props) {
  const lib = r.lib!;
  const fresh = useMemo(() => freshSince(visible, since), [visible, since]);
  const [brief, setBrief] = useState<{ text: string; postIds: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const freshKey = fresh.map((e) => e.item.id).join(',');
  useEffect(() => {
    setBrief(null);
    setErr('');
  }, [since, freshKey]);

  const summary = useMemo(() => {
    const bySource = new Map<string, number>();
    const byAuthor = new Map<string, { it: Item; n: number }>();
    for (const { item } of fresh) {
      bySource.set(item.sourceId, (bySource.get(item.sourceId) ?? 0) + 1);
      const k = `${item.platform}:${item.author.handle ?? item.author.name}`;
      const a = byAuthor.get(k);
      if (a) a.n++;
      else byAuthor.set(k, { it: item, n: 1 });
    }
    const sources = [...bySource].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id, n]) => ({ label: lib.sources.find((s) => s.id === id)?.label ?? 'Unknown', n }));
    const people = [...byAuthor.values()].sort((a, b) => b.n - a.n).slice(0, 3);
    const ids = new Set(fresh.map((e) => e.item.id));
    const rules = (lib.aiRules ?? [])
      .filter((rule) => rule.enabled)
      .map((rule) => ({ name: rule.name, n: Object.entries(lib.labels?.[rule.id] ?? {}).filter(([id, l]) => l.match && ids.has(id)).length }))
      .filter((x) => x.n > 0)
      .slice(0, 3);
    return { sources, people, rules };
  }, [fresh, lib]);

  if (!since || Date.now() - Date.parse(since) < MIN_GAP) return null;
  if (newOnly) {
    return (
      <div className="chip-row catchup-chip" role="list">
        <span className="chip on" role="listitem">
          New since you were away
          <button aria-label="Show every post again" onClick={() => setNewOnly(false)}><Icon name="x" size={13} /></button>
        </span>
        <button className="chip ghost" onClick={() => { setNewOnly(false); markSeen(); }}>Mark seen</button>
      </div>
    );
  }
  if (fresh.length < 3) return null;

  const ask = async () => {
    setBusy(true);
    setErr('');
    try {
      const b = await api.catchUp(since, fresh.slice(0, 300).map((e) => e.item.id), r.profileId);
      setBrief({ text: b.text, postIds: b.postIds });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const byId = new Map(lib.items.map((i) => [i.id, i]));

  return (
    <section className="catchup card-block" aria-label="Since you were away">
      <p className="catchup-kick">{sinceLabel(since)}</p>
      <h3 className="catchup-title"><span className="catchup-n">{fresh.length.toLocaleString()}</span> new worth reading</h3>
      <div className="catchup-facts">
        <p className="catchup-sources">
          {summary.sources.map((s, i) => (
            <span key={s.label}>{i > 0 && <span className="dot" aria-hidden> · </span>}{s.label} <b>{s.n}</b></span>
          ))}
        </p>
        {summary.people.length > 0 && (
          <div className="catchup-people">
            <span className="catchup-avs" aria-hidden>
              {summary.people.map(({ it }) =>
                it.author.avatar ? <img key={it.id} src={it.author.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span key={it.id} className="catchup-av blank">{it.author.name.slice(0, 1)}</span>,
              )}
            </span>
            <span className="catchup-who">Most from {summary.people.map((p) => `${p.it.author.name} (${p.n})`).join(', ')}</span>
          </div>
        )}
        {summary.rules.length > 0 && (
          <p className="catchup-rules">
            <Icon name="sparkle" size={13} />
            {summary.rules.map((x) => `${x.n} match “${x.name}”`).join(' · ')}
          </p>
        )}
      </div>
      {brief && (
        <div className="rich catchup-brief">
          <RichText text={brief.text} cite={(id, n) => <button className="cite" onClick={() => { const it = byId.get(id); if (it) openPost(it); }}>{n}</button>} />
        </div>
      )}
      {busy && <p className="catchup-busy"><span className="catchup-spin" aria-hidden /> Reading {fresh.length.toLocaleString()} posts…</p>}
      {err && <p className="catchup-err">{err}</p>}
      <div className="catchup-actions">
        <button className="btn small primary" onClick={() => setNewOnly(true)}>Show only new</button>
        {!brief && <button className="btn small" onClick={() => void ask()} disabled={busy}><Icon name="sparkle" size={14} /> Catch me up</button>}
        {triage && <button className="btn small" onClick={triage} aria-keyshortcuts="t"><Icon name="inbox" size={14} /> Triage</button>}
        <button className="btn small ghost" onClick={markSeen}>Mark seen</button>
      </div>
    </section>
  );
}
