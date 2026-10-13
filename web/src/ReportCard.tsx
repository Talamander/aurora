import { useEffect, useMemo, useState } from 'react';
import { ALL_PROFILE } from '../../core/profiles.ts';
import { sourceReports, type SourceReport, type Verdict } from '../../core/sourceReport.ts';
import type { Source } from '../../core/types.ts';
import { api } from './api.ts';
import { Icon } from './icons.tsx';
import { lf } from './longform.ts';
import { plural } from './format.ts';
import type { Reader } from './state.ts';
import './reportCard.css';

const VERDICT: Record<Verdict, string> = { keep: 'Keep', quieter: 'Quieter', 'let-go': 'Let go', new: 'New' };

/** Daily volume as a soft area, what you read as a line over it. */
function Spark({ rep }: { rep: SourceReport }) {
  const { posts, read } = rep.daily;
  const w = 132;
  const h = 30;
  const max = Math.max(1, ...posts);
  const x = (i: number) => (posts.length < 2 ? 0 : (i / (posts.length - 1)) * w);
  const y = (v: number) => h - 2 - (v / max) * (h - 4);
  const line = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const peak = Math.max(...posts);
  return (
    <svg className="rc-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={`Last 30 days: up to ${plural(peak, 'post')} a day, ${rep.read} read in all`}>
      <path className="rc-vol" d={`${line(posts)}L${w},${h}L0,${h}Z`} />
      <path className="rc-read" d={line(read)} />
    </svg>
  );
}

export function ReportCards({ r, openInColumns }: { r: Reader; openInColumns?: (sourceId: string) => void }) {
  const lib = r.lib!;
  const [highlighted, setHighlighted] = useState<Set<string> | null>(null);
  const [hits, setHits] = useState<Set<string> | null>(null);
  const [reports, setReports] = useState<SourceReport[] | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [show, setShow] = useState<'all' | 'act'>('all');

  // Highlights and alert hits come from their own endpoints; either may be missing.
  useEffect(() => {
    lf.highlights().then((hs) => setHighlighted(new Set(hs.map((h) => h.itemId))), () => setHighlighted(new Set()));
    api.alerts().then((a) => setHits(new Set(a.hits.map((h) => h.itemId))), () => setHits(new Set()));
  }, []);

  // Worked out once the sheet is on screen, after the extras arrive, and again only when the
  // library changes. A frame's delay keeps the sheet's opening animation smooth.
  useEffect(() => {
    if (!highlighted || !hits) return;
    const t = setTimeout(() => {
      setReports(sourceReports({
        items: lib.items, sources: lib.sources,
        ctx: { topics: lib.topics, ai: { rules: lib.aiRules, labels: lib.labels } },
        highlighted, alertHits: hits,
      }));
    }, 30);
    return () => clearTimeout(t);
  }, [lib, highlighted, hits]);

  const profiles = r.profiles;
  const here = r.profile;
  const byId = useMemo(() => new Map(lib.sources.map((s) => [s.id, s])), [lib.sources]);

  const pause = async (s: Source) => {
    await api.updateSource(s.id, { enabled: !s.enabled });
    await r.reload();
    r.toast(s.enabled ? `Paused syncing ${s.label}` : `${s.label} syncs again`, { undo: async () => { await api.updateSource(s.id, { enabled: s.enabled }); void r.reload(); } });
  };
  const mute = async (s: Source) => {
    if (here) {
      await api.profileSources(here.id, { remove: [s.id] });
      await r.reload();
      r.toast(`${s.label} is out of ${here.name}`, { undo: async () => { await api.profileSources(here.id, { add: [s.id] }); void r.reload(); } });
    } else {
      r.setSpec((x) => ({ ...x, excludeSources: x.excludeSources.includes(s.id) ? x.excludeSources : [...x.excludeSources, s.id] }), `mute ${s.label}`);
      r.toast(`Muted ${s.label} in this feed`);
    }
  };
  const move = async (s: Source, to: string) => {
    setMoving(null);
    const target = profiles.find((p) => p.id === to);
    if (!target) return;
    await api.profileSources(target.id, { add: [s.id] });
    if (here && here.id !== target.id) await api.profileSources(here.id, { remove: [s.id] });
    await r.reload();
    r.toast(here ? `Moved ${s.label} to ${target.name}` : `${s.label} is now in ${target.name} too`, {
      undo: async () => {
        await api.profileSources(target.id, { remove: [s.id] });
        if (here && here.id !== target.id) await api.profileSources(here.id, { add: [s.id] });
        void r.reload();
      },
    });
  };

  if (!reports) return <p className="f-hint rc-wait" role="status">Working out the last 30 days…</p>;
  const act = reports.filter((x) => x.verdict === 'let-go' || x.verdict === 'quieter');
  const list = show === 'act' ? act : reports;

  return (
    <div className="rc">
      <p className="f-hint lead">
        The last 30 days of every source{here ? ` in ${here.name}` : ''}, from what you read, saved, highlighted and hid. Worked out on this computer, no AI.
        {' '}Every action here is local: nothing changes on the site itself.
      </p>
      <div className="rc-bar">
        <div className="seg" role="radiogroup" aria-label="Which sources">
          <button role="radio" aria-checked={show === 'all'} className={show === 'all' ? 'on' : ''} onClick={() => setShow('all')}>All {reports.length}</button>
          <button role="radio" aria-checked={show === 'act'} className={show === 'act' ? 'on' : ''} onClick={() => setShow('act')}>Worth a look {act.length}</button>
        </div>
        <span className="rc-key" aria-hidden><i className="k-vol" /> posts <i className="k-read" /> read</span>
      </div>
      {list.length === 0 && <p className="f-hint">{show === 'act' ? 'Every source earns its place. Nice.' : 'No sources yet.'}</p>}
      <ul className="rc-list">
        {list.map((rep) => {
          const s = byId.get(rep.sourceId);
          if (!s) return null;
          const syncs = s.connector !== 'import' && s.connector !== 'demo';
          const others = profiles.filter((p) => p.id !== here?.id);
          return (
            <li key={rep.sourceId} className={`rc-card v-${rep.verdict}`}>
              <div className="rc-top">
                <span className={`mark ${s.isDemo ? 'demo' : ''}`} style={{ background: s.isDemo ? undefined : `var(--hue-${s.platform})` }} />
                <h3 className="rc-name">{s.label}{!s.enabled && <span className="tag">Paused</span>}</h3>
                <span className={`rc-verdict v-${rep.verdict}`}>{VERDICT[rep.verdict]}</span>
              </div>
              <p className="rc-reason">{rep.reason}</p>
              <div className="rc-mid">
                <Spark rep={rep} />
                <dl className="rc-nums">
                  <div><dt>a day</dt><dd>{rep.perDay}</dd></div>
                  <div><dt>read</dt><dd>{rep.read}</dd></div>
                  <div><dt>saved</dt><dd>{rep.saved}</dd></div>
                  {rep.highlighted > 0 && <div><dt>highlighted</dt><dd>{rep.highlighted}</dd></div>}
                  {rep.laterDone + rep.laterOpen > 0 && <div><dt>read later</dt><dd>{rep.laterDone}/{rep.laterDone + rep.laterOpen}</dd></div>}
                  {rep.alertHits > 0 && <div><dt>alerts</dt><dd>{rep.alertHits}</dd></div>}
                  <div><dt>you hid</dt><dd>{rep.hidden}</dd></div>
                  <div><dt>rules hid</dt><dd>{rep.posts ? `${Math.round((rep.rulesHid / rep.posts) * 100)}%` : '0'}</dd></div>
                </dl>
              </div>
              <div className="rc-actions">
                {syncs && <button className="btn small ghost" onClick={() => void pause(s)}>{s.enabled ? 'Pause syncing' : 'Resume syncing'}</button>}
                <button className="btn small ghost" onClick={() => void mute(s)}>{here ? `Remove from ${here.name}` : 'Mute in this feed'}</button>
                {others.length > 0 && (moving === s.id ? (
                  <span className="rc-move">
                    <label className="sr-only" htmlFor={`rc-move-${s.id}`}>Move {s.label} to</label>
                    <select id={`rc-move-${s.id}`} defaultValue="" onChange={(e) => e.target.value && void move(s, e.target.value)}>
                      <option value="" disabled>{here ? 'Move to…' : 'Add to…'}</option>
                      {others.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <button className="btn small ghost" onClick={() => setMoving(null)}>Cancel</button>
                  </span>
                ) : (
                  <button className="btn small ghost" onClick={() => setMoving(s.id)}>{here ? 'Move to a profile' : 'Add to a profile'}</button>
                ))}
                {openInColumns && <button className="btn small ghost" onClick={() => openInColumns(s.id)}><Icon name="columns" size={14} /> Open in Columns</button>}
              </div>
            </li>
          );
        })}
      </ul>
      {r.profileId !== ALL_PROFILE && <p className="f-hint">Sources outside {here?.name} are not shown. Switch to All to see every source.</p>}
    </div>
  );
}
