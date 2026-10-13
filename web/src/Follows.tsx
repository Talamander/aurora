// Bring your follows: drop a data export (or a whole ZIP), type a Bluesky handle or paste links,
// review who comes over and where, then watch them arrive. Exports are read in this browser; only
// the extracted accounts go to the server, and nothing starts until the button is pressed.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type FollowJobView, type FollowPlanView, type FollowTargetView } from './api.ts';
import { plural } from './format.ts';
import { Icon } from './icons.tsx';
import { proxied } from './imgProxy.ts';
import { useDialog } from './useDialog.ts';
import { isFollowsEntry, mergeTargets, MAX_FOLLOW_FILE_BYTES, parseFollowsFile, parseList, PLATFORM_LABEL, type FollowPlatform, type ParsedFollows } from '../../core/follows.ts';
import { isZip, listZip } from '../../core/zip.ts';
import type { Library } from '../../core/types.ts';

type Toast = (text: string, opts?: { tone?: 'info' | 'error' | 'alert' }) => void;
type FileReport = { file: string; kind?: string; count: number; error?: string; skipped?: number };

const HUE: Record<FollowPlatform, string> = {
  youtube: 'var(--hue-youtube)',
  instagram: 'var(--hue-instagram)',
  tiktok: 'var(--hue-tiktok)',
  x: 'var(--hue-x)',
  threads: 'var(--hue-threads)',
  mastodon: 'var(--hue-mastodon)',
  bluesky: 'var(--hue-bluesky)',
  reddit: 'var(--hue-reddit)',
  substack: '#ff6719',
  feed: 'var(--hue-rss)',
};

const HOW_TO: { p: string; steps: string }[] = [
  { p: 'YouTube', steps: 'takeout.google.com: choose only "YouTube and YouTube Music", then under "All YouTube data included" keep only subscriptions. Drop the ZIP here.' },
  { p: 'Instagram', steps: 'Accounts Center, Your information and permissions, Download your information. Pick "Followers and following" in JSON. Drop the ZIP or following.json.' },
  { p: 'TikTok', steps: 'Settings and privacy, Account, Download your data, format JSON. Drop the ZIP or user_data.json.' },
  { p: 'Mastodon', steps: 'Preferences, Import and export, Data export: download "Follows" (following_accounts.csv).' },
  { p: 'Reddit', steps: 'reddit.com/settings/data-request. The ZIP has subscribed_subreddits.csv.' },
  { p: 'Substack', steps: 'Any export or list that has publication links (name.substack.com) works, or paste the links below.' },
  { p: 'Bluesky', steps: 'Nothing to download: type your handle below. Aurora reads your public follows list.' },
  { p: 'X', steps: 'The X archive has following.js, but it lists account numbers, not handles. Paste profile links instead.' },
  { p: 'Any reader', steps: 'An OPML file from Feedly, Inoreader, NetNewsWire and the like.' },
];

const LANE_BADGE: Record<string, string> = { feed: 'Instant', actor: 'Connector ready', build: 'One AI build', unsupported: "Can't import", exists: 'Already following' };

function Avatar({ t }: { t: { avatar?: string; name?: string; handle: string; platform: FollowPlatform } }) {
  const [bad, setBad] = useState(false);
  const label = (t.name || t.handle).replace(/^[@r/]+|^https?:\/\//g, '');
  if (t.avatar && !bad) return <img className="fl-av" src={proxied(t.avatar)} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBad(true)} />;
  return <span className="fl-av initials" style={{ ['--hue' as string]: HUE[t.platform] }} aria-hidden>{label.slice(0, 1).toUpperCase() || '?'}</span>;
}

const shown = (t: { platform: FollowPlatform; handle: string; name?: string }) =>
  t.platform === 'reddit' ? `r/${t.handle}` : t.platform === 'feed' || t.handle.startsWith('https://') ? t.handle.replace(/^https?:\/\//, '').replace(/\/$/, '') : t.platform === 'youtube' && /^UC/.test(t.handle) ? 'YouTube channel' : t.platform === 'x' && /^\d+$/.test(t.handle) ? `account #${t.handle}` : `@${t.handle.replace(/^@/, '')}`;

export function FollowsSheet({ close, lib, toast, aiReady, openSources }: { close: () => void; lib: Library; toast: Toast; aiReady: boolean; openSources: () => void }) {
  const dlg = useDialog<HTMLDivElement>();
  const [step, setStep] = useState<'pick' | 'review' | 'progress'>('pick');
  const [reports, setReports] = useState<FileReport[]>([]);
  const [lists, setLists] = useState<FollowTargetView[][]>([]);
  const [reading, setReading] = useState(false);
  const [drag, setDrag] = useState(false);
  const [bsky, setBsky] = useState('');
  const [paste, setPaste] = useState('');
  const [plan, setPlan] = useState<FollowPlanView | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const profiles = lib.profiles ?? [];
  const defaultProfile = lib.activeProfile && lib.activeProfile !== 'all' ? lib.activeProfile : '';
  const [groupProfile, setGroupProfile] = useState<Record<string, string>>({});
  const [job, setJob] = useState<FollowJobView | null>(null);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const targets = useMemo(() => mergeTargets(lists), [lists]);

  // An import already under way (or just finished) opens on its progress.
  const loadJob = useCallback(async () => {
    try {
      const r = await api.followsJob();
      setJob(r.job);
      setRunning(r.running);
      return r;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    void loadJob().then((r) => {
      if (r?.job && (!r.job.finishedAt || Date.now() - Date.parse(r.job.finishedAt) < 6 * 3600_000)) setStep('progress');
    });
  }, [loadJob]);
  const live = step === 'progress' && (running || (job && !job.finishedAt));
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void loadJob(), 1500);
    return () => clearInterval(t);
  }, [live, loadJob]);

  const addParsed = (p: ParsedFollows | null, file: string) => {
    if (!p) {
      setReports((r) => [...r, { file, count: 0, error: 'Not a following list Aurora knows. Try the file named "following" or "subscriptions" in the export.' }]);
      return;
    }
    setReports((r) => [...r, { file: p.file, kind: p.kind, count: p.targets.length, skipped: p.skipped, error: !p.targets.length ? (p.errors[0] ?? 'No accounts in this file.') : undefined }]);
    if (p.targets.length) setLists((l) => [...l, p.targets]);
  };

  const readFiles = async (files: FileList | File[]) => {
    setReading(true);
    try {
      for (const f of Array.from(files)) {
        try {
          if (await isZip(f)) {
            const entries = await listZip(f, isFollowsEntry, MAX_FOLLOW_FILE_BYTES);
            if (!entries.length) {
              setReports((r) => [...r, { file: f.name, count: 0, error: 'No following list inside this ZIP. Is it the right export?' }]);
              continue;
            }
            for (const e of entries) {
              try {
                addParsed(parseFollowsFile(e.name, await e.read()), e.name);
              } catch (err) {
                setReports((r) => [...r, { file: e.name, count: 0, error: (err as Error).message }]);
              }
            }
            continue;
          }
          if (f.size > MAX_FOLLOW_FILE_BYTES) {
            setReports((r) => [...r, { file: f.name, count: 0, error: 'Too large to read here (over 150 MB). Drop the smaller following file instead.' }]);
            continue;
          }
          addParsed(parseFollowsFile(f.name, await f.text()), f.name);
        } catch (err) {
          setReports((r) => [...r, { file: f.name, count: 0, error: (err as Error).message }]);
        }
      }
    } finally {
      setReading(false);
    }
  };

  const findBluesky = async () => {
    if (!bsky.trim()) return;
    setReading(true);
    try {
      const r = await api.followsBluesky(bsky.trim());
      setReports((x) => [...x, { file: `@${bsky.trim().replace(/^@/, '')}`, kind: 'Bluesky follows', count: r.targets.length, error: r.targets.length ? undefined : 'This account follows nobody yet.' }]);
      if (r.targets.length) setLists((l) => [...l, r.targets]);
      setBsky('');
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    } finally {
      setReading(false);
    }
  };

  const addPaste = () => {
    if (!paste.trim()) return;
    const p = parseList(paste);
    addParsed(p.targets.length ? p : { ...p, targets: [] }, 'Pasted links');
    if (p.targets.length) setPaste('');
  };

  const review = async () => {
    setReading(true);
    try {
      const p = await api.followsPlan(targets);
      setPlan(p);
      const lane = new Map(p.items.map((i) => [i.key, i.lane]));
      setSelected(new Set(targets.filter((t) => t.importable && lane.get(t.key) !== 'exists' && lane.get(t.key) !== 'unsupported').map((t) => t.key)));
      setGroupProfile(Object.fromEntries(p.platforms.map((g) => [g.platform, defaultProfile])));
      setStep('review');
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    } finally {
      setReading(false);
    }
  };

  const start = async () => {
    const pick = targets.filter((t) => selected.has(t.key));
    if (!pick.length) return;
    setStarting(true);
    try {
      const r = await api.followsStart(pick, groupProfile);
      setJob(r.job);
      setRunning(true);
      setStep('progress');
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    } finally {
      setStarting(false);
    }
  };

  const reset = async () => {
    try {
      await api.followsClear();
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
      return;
    }
    setJob(null);
    setReports([]);
    setLists([]);
    setPlan(null);
    setStep('pick');
  };

  const lanes = useMemo(() => new Map(plan?.items.map((i) => [i.key, i.lane]) ?? []), [plan]);
  const q = query.trim().toLowerCase();
  const matches = (t: { handle: string; name?: string }) => !q || t.handle.toLowerCase().includes(q) || (t.name ?? '').toLowerCase().includes(q);
  const pickedBuilds = plan?.platforms.filter((g) => g.lane === 'build' && targets.some((t) => t.platform === g.platform && selected.has(t.key))).length ?? 0;

  return (
    <div className="sheet-backdrop" onClick={close}>
      <div ref={dlg} className="sheet follows-sheet" role="dialog" aria-modal="true" aria-label="Bring your follows" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          {step === 'review' && <button className="icon-btn" onClick={() => setStep('pick')} aria-label="Back"><Icon name="back" /></button>}
          <h2>Bring your follows</h2>
          <button className="icon-btn" onClick={close} aria-label="Close"><Icon name="x" /></button>
        </div>

        {step === 'pick' && (
          <div className="sheet-body">
            <div
              className={`fl-hero ${drag ? 'over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); void readFiles(e.dataTransfer.files); }}
            >
              <div className="fl-orbit" aria-hidden>
                {(['youtube', 'instagram', 'tiktok', 'bluesky', 'mastodon', 'reddit'] as FollowPlatform[]).map((p, i) => <span key={p} style={{ ['--hue' as string]: HUE[p], ['--i' as string]: i }} />)}
                <Icon name="people" size={22} />
              </div>
              <h3>Everyone you follow, in one move</h3>
              <p>Drop the data export you can download from YouTube, Instagram, TikTok, Mastodon, Reddit or any feed reader. A whole ZIP is fine. Aurora reads only the following list, here on this computer.</p>
              <button className="btn primary" onClick={() => fileRef.current?.click()} disabled={reading}><Icon name="upload" size={15} /> {reading ? 'Reading…' : 'Choose export files'}</button>
              <input ref={fileRef} type="file" multiple hidden accept=".zip,.json,.csv,.js,.html,.htm,.txt,.opml,.xml" onChange={(e) => { if (e.target.files) void readFiles(e.target.files); e.target.value = ''; }} />
            </div>

            <form className="fl-row" onSubmit={(e) => { e.preventDefault(); void findBluesky(); }}>
              <span className="fl-dot" style={{ ['--hue' as string]: HUE.bluesky }} aria-hidden />
              <input value={bsky} onChange={(e) => setBsky(e.target.value)} placeholder="Your Bluesky handle" aria-label="Your Bluesky handle" autoCapitalize="off" spellCheck={false} />
              <button className="btn small" disabled={!bsky.trim() || reading}>Find follows</button>
            </form>

            <details className="fl-paste">
              <summary>Paste profile links instead</summary>
              <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={4} placeholder={'https://www.youtube.com/@mkbhd\nhttps://www.instagram.com/natgeo\n@Gargron@mastodon.social\nr/LocalLLaMA'} aria-label="Profile links, one per line" />
              <button className="btn small" type="button" onClick={addPaste} disabled={!paste.trim()}>Add these</button>
            </details>

            {reports.length > 0 && (
              <ul className="fl-reports" aria-live="polite">
                {reports.map((r, i) => (
                  <li key={i} className={r.error ? 'bad' : ''}>
                    <Icon name={r.error ? 'info' : 'check'} size={14} />
                    <span className="fl-rep-main"><b>{r.file}</b>{r.kind && <small>{r.kind}</small>}</span>
                    {r.error ? <span className="fl-rep-err">{r.error}</span> : <span className="fl-rep-n">{plural(r.count, 'account')}{r.skipped ? `, ${r.skipped} skipped` : ''}</span>}
                  </li>
                ))}
              </ul>
            )}

            <details className="fl-howto">
              <summary>Where do I get my export?</summary>
              <dl>{HOW_TO.map((h) => <div key={h.p}><dt>{h.p}</dt><dd>{h.steps}</dd></div>)}</dl>
            </details>

            <p className="fl-promise"><Icon name="check" size={13} /> Read-only. Aurora never follows, likes or posts anything on these sites; it reads public posts into this computer.</p>

            <div className="fl-foot">
              <button className="btn ghost" onClick={openSources}>Other imports</button>
              <button className="btn primary" disabled={!targets.length || reading} onClick={() => void review()}>
                {targets.length ? `Review ${plural(targets.length, 'account')}` : 'Review'}
              </button>
            </div>
          </div>
        )}

        {step === 'review' && plan && (
          <div className="sheet-body">
            <div className="fl-summary">
              <b>{plural(targets.length, 'account')}</b> from {plural(plan.platforms.length, 'place')}
              <span>{plural(selected.size, 'account')} selected</span>
            </div>
            <label className="fl-search">
              <Icon name="search" size={14} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search names and handles" aria-label="Search accounts" />
            </label>
            {plan.platforms.map((g) => {
              const all = targets.filter((t) => t.platform === g.platform);
              const rows = all.filter(matches);
              const pickable = all.filter((t) => t.importable && !['exists', 'unsupported'].includes(lanes.get(t.key) ?? ''));
              const on = pickable.filter((t) => selected.has(t.key)).length;
              const expanded = open.has(g.platform) || !!q;
              const visible = expanded ? rows.slice(0, 400) : rows.slice(0, 6);
              if (q && !rows.length) return null;
              return (
                <section key={g.platform} className={`fl-group lane-${g.lane}`} style={{ ['--hue' as string]: HUE[g.platform] }}>
                  <header>
                    <span className="fl-dot" aria-hidden />
                    <div className="fl-g-title">
                      <b>{g.label}</b>
                      <small>{plural(g.total, 'account')}{g.exists ? `, ${g.exists} already followed` : ''}</small>
                    </div>
                    <span className={`fl-lane ${g.lane}`}>{LANE_BADGE[g.lane]}</span>
                  </header>
                  <p className="fl-how">{g.how}</p>
                  {pickable.length > 0 && (
                    <div className="fl-g-tools">
                      <button className="link-btn" onClick={() => setSelected((s) => new Set([...s, ...pickable.map((t) => t.key)]))} disabled={on === pickable.length}>Select all</button>
                      <button className="link-btn" onClick={() => setSelected((s) => new Set([...s].filter((k) => !pickable.some((t) => t.key === k))))} disabled={on === 0}>None</button>
                      <span className="fl-g-count">{on} of {pickable.length}</span>
                      {profiles.length > 0 && (
                        <label className="fl-profile">
                          <span>Into</span>
                          <select value={groupProfile[g.platform] ?? ''} onChange={(e) => setGroupProfile((m) => ({ ...m, [g.platform]: e.target.value }))} aria-label={`Profile for ${g.label}`}>
                            <option value="">All (no profile)</option>
                            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        </label>
                      )}
                    </div>
                  )}
                  <ul className="fl-list">
                    {visible.map((t) => {
                      const lane = lanes.get(t.key);
                      const disabled = !t.importable || lane === 'exists' || lane === 'unsupported';
                      return (
                        <li key={t.key} className={disabled ? 'off' : ''}>
                          <label>
                            <input type="checkbox" checked={!disabled && selected.has(t.key)} disabled={disabled} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(t.key); else n.delete(t.key); return n; })} />
                            <Avatar t={t} />
                            <span className="fl-who"><b>{t.name || shown(t)}</b>{t.name && t.name !== shown(t) && <small>{shown(t)}</small>}</span>
                            {lane === 'exists' && <span className="fl-tag">Following</span>}
                            {!t.importable && <span className="fl-tag" title={t.note}>ID only</span>}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                  {!expanded && rows.length > visible.length && <button className="fl-more" onClick={() => setOpen((s) => new Set([...s, g.platform]))}>Show all {rows.length}</button>}
                  {expanded && rows.length > 400 && <p className="fl-how">Showing 400 of {rows.length}. Search to find the rest.</p>}
                </section>
              );
            })}
            <div className="fl-foot sticky">
              <div className="fl-cost">
                {pickedBuilds > 0 ? (
                  aiReady ? <>About <b>${(pickedBuilds * plan.cost.min).toFixed(2)} to ${(pickedBuilds * plan.cost.max).toFixed(2)}</b> for {plural(pickedBuilds, 'connector build')}{plan.cost.samples ? ', based on your past builds' : ''}. Everything else is free.</> : <>Some platforms need a connector, and building one needs the AI. They wait until it is set up.</>
                ) : (
                  <>No AI needed. Free.</>
                )}
              </div>
              <button className="btn primary" disabled={!selected.size || starting} onClick={() => void start()}>{starting ? 'Starting…' : `Follow ${plural(selected.size, 'account')}`}</button>
            </div>
          </div>
        )}

        {step === 'progress' && job && <Progress job={job} running={!!live} onStop={async () => { const r = await api.followsCancel(); setJob(r.job); }} onReset={() => void reset()} onClose={close} />}
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  adding: 'Adding',
  done: 'Added',
  exists: 'Already followed',
  failed: 'Failed',
  waiting: 'Waiting for connector',
  building: 'Building connector',
  blocked: 'Not added',
  cancelled: 'Stopped',
};

function Progress({ job, running, onStop, onReset, onClose }: { job: FollowJobView; running: boolean; onStop: () => void; onReset: () => void; onClose: () => void }) {
  const total = job.items.length;
  const count = (s: string[]) => job.items.filter((x) => s.includes(x.status)).length;
  const done = count(['done']);
  const settled = count(['done', 'exists', 'failed', 'blocked', 'cancelled']);
  const pct = total ? Math.round((settled / total) * 100) : 100;
  const failed = count(['failed', 'blocked']);
  const waiting = count(['waiting', 'building']);
  const posts = job.items.reduce((n, x) => n + (x.added ?? 0), 0);
  const platforms = [...new Set(job.items.map((x) => x.platform))];
  const order = ['adding', 'building', 'failed', 'blocked', 'waiting', 'queued', 'done', 'exists', 'cancelled'];
  return (
    <div className="sheet-body">
      <div className={`fl-progress ${running ? 'live' : ''}`}>
        <div className="fl-big"><b>{done}</b><span>of {total} added</span></div>
        <div className="fl-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Import progress"><span style={{ width: `${pct}%` }} /></div>
        <p>
          {running ? 'Adding them one at a time so no site gets flooded. You can close this; it keeps going.' : job.cancelled ? 'Stopped.' : 'Done.'}
          {posts > 0 && <> {plural(posts, 'post')} arrived{running ? ' so far' : ''}.</>}
          {waiting > 0 && <> {waiting} waiting on a connector build.</>}
          {failed > 0 && <> {failed} not added.</>}
        </p>
      </div>
      {platforms.map((p) => {
        const items = job.items.filter((x) => x.platform === p).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
        const build = job.builds[p];
        return (
          <section key={p} className="fl-group" style={{ ['--hue' as string]: HUE[p] }}>
            <header>
              <span className="fl-dot" aria-hidden />
              <div className="fl-g-title"><b>{PLATFORM_LABEL[p]}</b><small>{items.filter((x) => x.status === 'done').length} of {items.length} added</small></div>
              {build && <span className={`fl-lane ${build.status === 'running' ? 'build' : build.status === 'done' ? 'actor' : 'unsupported'}`}>{build.status === 'running' ? 'AI building a connector' : build.status === 'done' ? 'Connector built' : 'Build failed'}</span>}
            </header>
            <ul className="fl-list status">
              {items.slice(0, 200).map((x) => (
                <li key={x.key} className={`st-${x.status}`}>
                  <Avatar t={x} />
                  <span className="fl-who"><b>{x.name || shown(x)}</b>{x.error ? <small className="err">{x.error}</small> : x.name && x.name !== shown(x) ? <small>{shown(x)}</small> : null}</span>
                  <span className={`fl-st ${x.status}`}>{x.status === 'done' && x.added ? `+${x.added}` : STATUS_LABEL[x.status]}</span>
                </li>
              ))}
            </ul>
            {items.length > 200 && <p className="fl-how">and {items.length - 200} more</p>}
          </section>
        );
      })}
      <div className="fl-foot sticky">
        {running ? <button className="btn" onClick={onStop}>Stop after the current one</button> : <button className="btn ghost" onClick={onReset}>Import more</button>}
        <button className="btn primary" onClick={onClose}>{running ? 'Keep going in the background' : 'Close'}</button>
      </div>
    </div>
  );
}
