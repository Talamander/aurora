// Routines: jobs the AI does on a schedule, described in a sentence ("every weekday at 7:30, make a
// Work brief"). A new routine is off until the user previews what its first run will do and turns
// it on. Runs only read and organise the library; nothing is posted or changed on any site.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type RoutineView, type RoutinesSummary, type RoutineRunView } from './api.ts';
import { agoText } from './format.ts';
import { Icon } from './icons.tsx';
import { useDialog } from './useDialog.ts';
import { describeSchedule, splitRoutine } from '../../core/routines.ts';
import type { Library } from '../../core/types.ts';
import type { ServerEvent } from './state.ts';
import './routines.css';

const EXAMPLES = [
  'Every weekday at 7:30, make a Work brief from my Work profile',
  'Sunday night, queue the three best long reads I saved this week in Read later',
  'Every 2 hours, put new photos from my Family profile on a Family page',
  'After each sync, save any post that mentions my name',
];

const money = (n: number | null | undefined) => (n == null ? 'cost unknown' : n === 0 ? 'free' : n < 0.01 ? 'under 1¢' : `$${n.toFixed(2)}`);

function whenText(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  if (d.getTime() - now.getTime() < 90_000) return 'any moment';
  if (diff === 0) return `today ${time}`;
  if (diff === 1) return `tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** Plain text with [[post:ID]] citations turned into small buttons. Never parsed as markup. */
function Cited({ text, openPostId }: { text: string; openPostId: (id: string) => void }) {
  const parts = text.split(/(\[\[post:[^\]\s]{1,200}\]\])/g);
  let n = 0;
  return (
    <>
      {parts.map((p, i) => {
        const m = /^\[\[post:([^\]\s]+)\]\]$/.exec(p);
        if (!m) return <span key={i}>{p.replace(/\[\[highlight:[^\]]+\]\]/g, '')}</span>;
        n += 1;
        return <button key={i} type="button" className="rt-cite" onClick={() => openPostId(m[1])} aria-label={`Open cited post ${n}`}>{n}</button>;
      })}
    </>
  );
}

export function RoutinesSheet({
  close, lib, toast, subscribe, openPostId, openPage,
}: {
  close: () => void;
  lib: Library;
  toast: (t: string, o?: { tone?: 'info' | 'error' }) => void;
  subscribe: (fn: (e: ServerEvent) => void) => () => void;
  openPostId: (id: string) => void;
  openPage: (id: string) => void;
}) {
  const dlg = useDialog<HTMLDivElement>();
  const [data, setData] = useState<RoutinesSummary | null>(null);
  const [text, setText] = useState('');
  const [profile, setProfile] = useState<string>('');
  const [busy, setBusy] = useState<Record<string, 'plan' | 'run' | 'save' | undefined>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [making, setMaking] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.routines());
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  }, [toast]);
  useEffect(() => void load(), [load]);
  useEffect(() => subscribe((e) => { if (e.type === 'ui' && e.action.kind === 'routines-changed') void load(); }), [subscribe, load]);
  // While a run is going, refresh now and then so steps and the result show up.
  const anyRunning = !!data?.routines.some((r) => r.running || r.queued);
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  const draft = useMemo(() => (text.trim() ? splitRoutine(text) : null), [text]);
  const profiles = lib.profiles ?? [];

  const create = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!draft) return;
    if (!draft.schedule) {
      toast('Say when, like “every weekday at 7:30” or “every 2 hours”.', { tone: 'error' });
      return;
    }
    setMaking(true);
    try {
      const r = await api.createRoutine({ text, profile: profile || null });
      setText('');
      await load();
      toast(`Made “${r.name}”. Preview its first run, then turn it on.`);
    } catch (err) {
      toast((err as Error).message, { tone: 'error' });
    } finally {
      setMaking(false);
    }
  };

  const withBusy = async (id: string, kind: 'plan' | 'run' | 'save', fn: () => Promise<unknown>) => {
    setBusy((b) => ({ ...b, [id]: kind }));
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    } finally {
      setBusy((b) => ({ ...b, [id]: undefined }));
      void load();
    }
  };

  const plan = (r: RoutineView) => withBusy(r.id, 'plan', () => api.planRoutine(r.id));
  const runNow = (r: RoutineView) => withBusy(r.id, 'run', async () => { await api.runRoutine(r.id); toast(`Running “${r.name}”`); });
  const toggle = (r: RoutineView, on: boolean) => withBusy(r.id, 'save', () => api.updateRoutine(r.id, { enabled: on }));
  const remove = async (r: RoutineView) => {
    setConfirm(null);
    await api.deleteRoutine(r.id).catch((e) => toast((e as Error).message, { tone: 'error' }));
    toast(`Deleted routine “${r.name}”`);
    void load();
  };

  const profileName = (id: string | null) => (id ? profiles.find((p) => p.id === id)?.name ?? 'a removed profile' : 'All');
  const pageFor = (r: RoutineView) => lib.pages?.find((p) => p.name.toLowerCase() === r.name.toLowerCase());

  return (
    <div className="sheet-backdrop" onClick={close}>
      <div ref={dlg} className="sheet routines-sheet" role="dialog" aria-modal="true" aria-labelledby="rt-title" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2 id="rt-title">Routines</h2>
          <button className="icon-btn" onClick={close} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="sheet-body">
          <form className="rt-ask" onSubmit={create}>
            <div className="rt-ask-row">
              <span className="rt-orb" aria-hidden><Icon name="sync" size={18} /></span>
              <label className="rt-ask-l">
                <span>Every so often, Aurora should</span>
                <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={1500} placeholder="Every weekday at 7:30, make a Work brief" aria-label="What the routine should do, and when" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void create(); } }} />
              </label>
            </div>
            {draft && (
              <div className={`rt-parse ${draft.schedule ? '' : 'missing'}`} aria-live="polite">
                {draft.schedule ? <><b>{describeSchedule(draft.schedule)}</b><span>{draft.name}</span></> : <span>Add when it should run: “every weekday at 7:30”, “Sunday night”, “every 2 hours”.</span>}
              </div>
            )}
            <div className="rt-ask-foot">
              {profiles.length > 0 && (
                <label className="rt-profile">
                  <span>Works in</span>
                  <select value={profile} onChange={(e) => setProfile(e.target.value)}>
                    <option value="">All</option>
                    {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
              )}
              <button className="btn primary small" disabled={!draft?.schedule || making}>{making ? 'Making…' : 'Make routine'}</button>
            </div>
            {!text && (
              <div className="rt-examples">
                {EXAMPLES.map((x) => <button type="button" key={x} className="chip" onClick={() => setText(x)}>{x}</button>)}
              </div>
            )}
            {data && !data.aiReady && <p className="rt-hint">Routines need the AI. {data.aiReason ?? 'Set it up in AI settings.'}</p>}
          </form>

          {data && data.routines.length === 0 && (
            <div className="rt-empty">
              <p><b>No routines yet.</b></p>
              <p>Describe a job and when to do it. Aurora shows you the plan first, and nothing runs until you turn it on.</p>
            </div>
          )}

          {data && data.routines.length > 0 && (
            <ul className="rt-list">
              {data.routines.map((r) => {
                const b = busy[r.id];
                const page = pageFor(r);
                const status = r.running ? 'Running now' : r.queued ? 'Waiting to run' : r.paused ? 'Paused' : r.enabled ? (r.nextRunAt ? `Next ${whenText(r.nextRunAt)}` : r.schedule.kind === 'sync' ? 'Waits for new posts' : 'On') : 'Off';
                return (
                  <li key={r.id} className={`rt-card ${r.enabled && !r.paused ? 'on' : ''} ${r.running ? 'running' : ''}`}>
                    <div className="rt-top">
                      <div className="rt-title">
                        <b>{r.name}</b>
                        <small><span className="rt-when">{r.when}</span> · {status}{r.profile ? ` · ${profileName(r.profile)}` : ''}</small>
                      </div>
                      <label className="switch rt-switch" title={r.plan ? (r.enabled ? 'Turn off' : 'Turn on') : 'Preview the plan first'}>
                        <input type="checkbox" checked={r.enabled} disabled={!r.plan || b === 'save'} onChange={(e) => void toggle(r, e.target.checked)} aria-label={r.enabled ? `Turn off ${r.name}` : `Turn on ${r.name}`} />
                      </label>
                    </div>
                    {editing === r.id ? (
                      <EditRoutine r={r} profiles={profiles} done={() => { setEditing(null); void load(); }} toast={toast} />
                    ) : (
                      <p className="rt-task">{r.prompt}</p>
                    )}
                    {r.paused && <p className="rt-paused"><Icon name="pause" size={13} /> {r.paused} Raise the monthly limit under Edit to start it again.</p>}

                    {!r.enabled && !r.plan && editing !== r.id && (
                      <div className="rt-plan empty">
                        <p>Before it runs on its own, see what the first run will do.</p>
                        <button className="btn small" disabled={!!b || !data.aiReady} onClick={() => void plan(r)}>
                          {b === 'plan' ? <><span className="spin" aria-hidden /> Planning…</> : <><Icon name="eye" size={14} /> Preview the first run</>}
                        </button>
                      </div>
                    )}
                    {r.plan && !r.enabled && editing !== r.id && (
                      <div className="rt-plan">
                        <h3>The first run will</h3>
                        <p className="rt-plan-text">{r.plan}</p>
                        <div className="rt-plan-foot">
                          <small>Each run stops at {money(r.runCapUsd)}; this routine at {money(r.monthCapUsd)} a month.</small>
                          <button className="btn primary small" disabled={!!b} onClick={() => void toggle(r, true)}><Icon name="check" size={14} /> Turn on</button>
                        </div>
                      </div>
                    )}

                    {r.lastRun && <RunView run={r.lastRun} openPostId={(id) => { openPostId(id); close(); }} latest />}

                    <div className="rt-actions">
                      <button className="btn ghost small" disabled={!!b || r.running || r.queued || !data.aiReady} onClick={() => void runNow(r)}>
                        {b === 'run' || r.running ? <><span className="spin" aria-hidden /> Running…</> : <><Icon name="play" size={14} /> Run now</>}
                      </button>
                      {page && <button className="btn ghost small" onClick={() => { openPage(page.id); close(); }}><Icon name="page" size={14} /> Open page</button>}
                      <button className="btn ghost small" onClick={() => setEditing(editing === r.id ? null : r.id)}><Icon name="sliders" size={14} /> {editing === r.id ? 'Cancel' : 'Edit'}</button>
                      <span className="rt-spent" title="Spent by this routine this month">{r.monthSpent > 0 ? `${money(r.monthSpent)} this month` : ''}</span>
                      {confirm === r.id ? (
                        <button className="btn danger small" onClick={() => void remove(r)}>Delete?</button>
                      ) : (
                        <button className="icon-btn small" aria-label={`Delete ${r.name}`} onClick={() => setConfirm(r.id)}><Icon name="trash" size={14} /></button>
                      )}
                    </div>
                    {r.runs.length > 1 && (
                      <details className="rt-history">
                        <summary>Earlier runs</summary>
                        <ul>{r.runs.slice(1).map((run) => <li key={run.id}><RunView run={run} openPostId={(id) => { openPostId(id); close(); }} /></li>)}</ul>
                      </details>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <p className="rt-note">
            <Icon name="info" size={13} /> Routines read and organise your library: pages, views, saved posts and Read later. They never add or remove sources, sign in, or post, like or follow anywhere.
          </p>
        </div>
      </div>
    </div>
  );
}

function RunView({ run, openPostId, latest }: { run: RoutineRunView; openPostId: (id: string) => void; latest?: boolean }) {
  const label = run.status === 'running' ? 'Running' : run.status === 'ok' ? 'Done' : run.status === 'skipped' ? 'Skipped' : 'Failed';
  return (
    <div className={`rt-run ${run.status} ${latest ? 'latest' : ''}`}>
      <div className="rt-run-line">
        <span className="rt-dot" aria-hidden />
        <b>{label}</b>
        <time dateTime={run.startedAt}>{agoText(run.startedAt)}</time>
        {run.origin === 'user' && <span className="rt-tag">run by you</span>}
        {run.status !== 'running' && run.status !== 'skipped' && <span className="rt-cost">{money(run.costUsd)}</span>}
      </div>
      {run.summary && <p className="rt-summary"><Cited text={run.summary} openPostId={openPostId} /></p>}
      {run.error && <p className="rt-error">{run.error}</p>}
      {run.steps.length > 0 && latest && (
        <p className="rt-steps">{run.steps.slice(0, 8).map((s, i) => <span key={i}>{s}</span>)}{run.steps.length > 8 && <span>+{run.steps.length - 8} more</span>}</p>
      )}
    </div>
  );
}

function EditRoutine({ r, profiles, done, toast }: { r: RoutineView; profiles: { id: string; name: string }[]; done: () => void; toast: (t: string, o?: { tone?: 'info' | 'error' }) => void }) {
  const [name, setName] = useState(r.name);
  const [prompt, setPrompt] = useState(r.prompt);
  const [when, setWhen] = useState(r.when);
  const [profile, setProfile] = useState(r.profile ?? '');
  const [runCap, setRunCap] = useState(String(r.runCapUsd));
  const [monthCap, setMonthCap] = useState(String(r.monthCapUsd));
  const parsed = useMemo(() => splitRoutine(when).schedule, [when]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.updateRoutine(r.id, {
        name,
        prompt,
        ...(when !== r.when ? { schedule: when } : {}),
        profile: profile || null,
        runCapUsd: Number(runCap),
        ...(Number(monthCap) !== r.monthCapUsd ? { monthCapUsd: Number(monthCap) } : {}),
      });
      if (prompt !== r.prompt) toast('Saved. Preview the new plan before it runs on its own again.');
      done();
    } catch (err) {
      toast((err as Error).message, { tone: 'error' });
    }
  };
  return (
    <form className="rt-edit" onSubmit={save}>
      <label><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></label>
      <label><span>What to do</span><textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} maxLength={1500} /></label>
      <label>
        <span>When</span>
        <input value={when} onChange={(e) => setWhen(e.target.value)} maxLength={120} aria-describedby={`rt-when-${r.id}`} />
        <small id={`rt-when-${r.id}`} className={parsed ? '' : 'bad'}>{parsed ? describeSchedule(parsed) : 'Try “weekdays at 7:30”, “sunday night” or “every 2 hours”.'}</small>
      </label>
      <div className="rt-edit-row">
        {profiles.length > 0 && (
          <label><span>Works in</span>
            <select value={profile} onChange={(e) => setProfile(e.target.value)}>
              <option value="">All</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        <label><span>Per run, $</span><input type="number" min={0.05} max={20} step={0.05} value={runCap} onChange={(e) => setRunCap(e.target.value)} /></label>
        <label><span>Per month, $</span><input type="number" min={0} max={200} step={0.5} value={monthCap} onChange={(e) => setMonthCap(e.target.value)} /></label>
      </div>
      <div className="rt-edit-foot"><button className="btn primary small" disabled={!parsed || prompt.trim().length < 4}>Save</button></div>
    </form>
  );
}
