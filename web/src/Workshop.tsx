// Workshop: the connectors (actors) the AI built, and the AI jobs that build and repair them.
// Everything shown here (code, logs, actor output) is untrusted text: rendered as text only.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentEvent, AgentThread, Library, Source, SyncRun } from '../../core/types.ts';
import { Icon } from './icons.tsx';
import { agoText, fullTime, plural, relTime } from './format.ts';
import { useDialog } from './useDialog.ts';

// Mirrors server/actors/types.ts (kept local so the web bundle never imports server code).
interface ActorManifest {
  id: string;
  name: string;
  version: number;
  runtime: 'python' | 'node';
  entry: string;
  platform: string;
  description?: string;
  tier: 'api' | 'http' | 'browser' | 'session';
  hosts: string[];
  hostsFromInput?: string[];
  input?: Record<string, unknown>;
  python?: { requires?: string[] };
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  notes?: string;
}
interface ActorDetail {
  manifest: ActorManifest;
  code: string;
  versions: { version: number; updatedAt: string; current: boolean }[];
  sources: Source[];
  runs: SyncRun[];
  threads: AgentThread[];
}
interface ThreadDetail {
  thread: AgentThread;
  events: AgentEvent[];
  jobs: AgentThread[];
  running: boolean;
}
type Toast = (text: string, opts?: { tone?: 'info' | 'error' }) => void;
type Sel = { type: 'actor' | 'job'; id: string } | null;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

const enc = encodeURIComponent;

/** Downloads a connector as a JSON file (manifest plus code) that another Aurora can import. */
async function exportActor(id: string) {
  const bundle = await call<unknown>('GET', `/api/actors/${enc(id)}/bundle`);
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${id}.actor.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const firstLine = (v: unknown, max = 160): string => {
  const s = str(v).trim().split('\n')[0] ?? '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
};
const isDesktop = () => typeof window !== 'undefined' && window.matchMedia('(min-width: 861px)').matches;

const STATUS_LABEL: Record<Source['status'], string> = { ok: 'Working', error: 'Failing', blocked: 'Needs you', syncing: 'Syncing', never: 'Not synced yet' };
const JOB_LABEL: Record<AgentThread['status'], string> = { waiting: 'Queued', running: 'Working', done: 'Done', error: 'Failed', idle: 'Idle' };

function SafeLink({ href, children }: { href: unknown; children: ReactNode }) {
  const u = str(href);
  if (!u.startsWith('https://')) return <>{children}</>;
  return <a href={u} target="_blank" rel="noopener noreferrer">{children}</a>;
}

function Dot({ platform }: { platform: string }) {
  const p = /^[a-z0-9-]{1,32}$/.test(platform) ? platform : 'import';
  return <span className="ws-dot" style={{ background: `var(--hue-${p}, var(--hue-import))` }} aria-hidden />;
}

function Spinner() {
  return <span className="ws-spin" aria-hidden />;
}

// ------------------------------------------------------------- code view
const KW: Record<string, Set<string>> = {
  python: new Set('def return if elif else for while in import from as class try except finally with lambda yield not and or is None True False raise pass break continue async await global nonlocal del assert'.split(' ')),
  node: new Set('const let var function return if else for while of in import from export default class extends try catch finally new await async throw typeof instanceof null undefined true false break continue switch case this yield delete void interface type as'.split(' ')),
};
const TOK: Record<string, RegExp> = {
  python: /(#.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_]\w*)\b/g,
  node: /(\/\/.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$]*)\b/g,
};

function highlight(line: string, runtime: string): ReactNode[] {
  const re = new RegExp(TOK[runtime] ?? TOK.node);
  const kw = KW[runtime] ?? KW.node;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(line))) {
    if (m[0] === '') { re.lastIndex++; continue; }
    let cls = '';
    if (m[1]) cls = 'c';
    else if (m[2]) cls = 's';
    else if (m[3]) cls = 'n';
    else if (m[4] && kw.has(m[4])) cls = 'k';
    if (!cls) continue;
    if (m.index > last) out.push(line.slice(last, m.index));
    out.push(<span key={k++} className={`ws-t-${cls}`}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

function CodeView({ code, runtime }: { code: string; runtime: string }) {
  const lines = useMemo(() => code.replace(/\r\n?/g, '\n').split('\n'), [code]);
  const big = lines.length > 4000;
  return (
    <div className="ws-code" role="region" aria-label="Connector code" tabIndex={0}>
      <pre>
        {lines.map((ln, i) => (
          <div className="ws-ln" key={i}>
            <span className="ws-ln-n" aria-hidden>{i + 1}</span>
            <code>{big ? ln : highlight(ln, runtime)}{ln === '' ? ' ' : null}</code>
          </div>
        ))}
      </pre>
    </div>
  );
}

// ------------------------------------------------------------- job log
function EventRow({ ev }: { ev: AgentEvent }) {
  const d = ev.data ?? {};
  switch (ev.type) {
    case 'user':
      return <li className="ws-ev user"><span className="ws-ev-k">Asked</span><p>{str(d.text)}</p></li>;
    case 'tool_call':
      return <li className="ws-ev call"><span className="ws-ev-k">Step</span><p>{str(d.label || d.name)}</p></li>;
    case 'tool_result':
      return (
        <li className={`ws-ev result ${d.ok ? 'ok' : 'bad'}`}>
          <span className="ws-ev-k">{d.ok ? 'OK' : 'Failed'}</span>
          <p className="ws-mono">{firstLine(d.text) || (d.ok ? 'Done' : 'No output')}</p>
        </li>
      );
    case 'assistant':
      return <li className="ws-ev say"><span className="ws-ev-k">AI</span><p className="ws-pre">{str(d.text)}</p></li>;
    case 'actor':
      return <li className="ws-ev actor"><span className="ws-ev-k">Saved</span><p><span className="ws-mono">{str(d.id)}</span> v{str(d.version)}</p></li>;
    case 'test': {
      const sample: any[] = Array.isArray(d.sample) ? d.sample.slice(0, 3) : [];
      return (
        <li className={`ws-ev test ${d.ok ? 'ok' : 'bad'}`}>
          <span className="ws-ev-k">Test</span>
          <div>
            <p>{d.ok ? `Passed with ${plural(Number(d.count) || 0, 'item')}` : `Failed${d.count ? ` (${plural(Number(d.count), 'item')})` : ''}`}</p>
            {sample.length > 0 && (
              <ul className="ws-sample">
                {sample.map((p, i) => {
                  const who = str(p?.author?.name) || str(p?.author?.handle);
                  const what = firstLine(p?.title || p?.text, 110) || str(p?.url);
                  return (
                    <li key={i}>
                      {who && <b>{who}{p?.author?.handle && p?.author?.name ? <span className="muted"> @{str(p.author.handle).replace(/^@/, '')}</span> : null}</b>}
                      <SafeLink href={p?.url}>{what || 'Untitled'}</SafeLink>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </li>
      );
    }
    case 'installed':
      return (
        <li className={`ws-ev installed ${d.error ? 'bad' : 'ok'}`}>
          <span className="ws-ev-k">Installed</span>
          <p>“{str(d.label)}”{typeof d.added === 'number' ? ` · ${plural(d.added, 'new post')}` : ''}{d.tier ? ` · ${str(d.tier)} tier` : ''}{d.error ? ` · ${firstLine(d.error)}` : ''}</p>
          {d.coverage ? <p className="ws-coverage">{str(d.coverage)}</p> : null}
        </li>
      );
    case 'error':
      return <li className="ws-ev bad"><span className="ws-ev-k">Error</span><p className="ws-pre">{str(d.text)}</p></li>;
    case 'done':
      return <li className="ws-ev done ok"><span className="ws-ev-k">Done</span><p>{typeof d.costUsd === 'number' ? `Cost $${d.costUsd.toFixed(3)}` : 'Finished'}{d.turns ? ` · ${plural(d.turns, 'turn')}` : ''}</p></li>;
    case 'job':
      return null;
    default:
      return <li className="ws-ev"><span className="ws-ev-k">{ev.type.slice(0, 16)}</span><p>{firstLine(d.text ?? d.label ?? '')}</p></li>;
  }
}

function JobPane({ detail, onStop, back }: { detail: ThreadDetail | null; onStop: (id: string) => void; back: () => void }) {
  const end = useRef<HTMLLIElement>(null);
  const count = detail?.events.length ?? 0;
  useEffect(() => {
    if (detail?.running) end.current?.scrollIntoView({ block: 'nearest' });
  }, [count, detail?.running]);
  if (!detail) return <div className="ws-empty"><Spinner /> Loading</div>;
  const t = detail.thread;
  const live = detail.running || t.status === 'running' || t.status === 'waiting';
  return (
    <div className="ws-detail">
      <button className="btn small ghost ws-back" onClick={back}><Icon name="back" size={14} /> Workshop</button>
      <header className="ws-dhead">
        <p className="eyebrow">{t.kind === 'repair' ? 'Repair job' : 'Build job'} · <time dateTime={t.createdAt} title={fullTime(t.createdAt)}>{relTime(t.createdAt)}</time></p>
        <h3>{t.title ?? 'Untitled job'}</h3>
        <p className="ws-dmeta">
          <span className={`ws-job-st ${t.status}`}>{live && <Spinner />}{JOB_LABEL[t.status] ?? t.status}</span>
          {live && <button className="btn small ghost" onClick={() => onStop(t.id)}>Stop</button>}
        </p>
      </header>
      {detail.events.length === 0 ? (
        <p className="f-hint">{t.status === 'waiting' ? 'Waiting for a free slot.' : 'Nothing logged yet.'}</p>
      ) : (
        <ol className="ws-log">
          {detail.events.map((ev) => <EventRow key={ev.id} ev={ev} />)}
          <li ref={end} className="ws-log-end" aria-hidden />
        </ol>
      )}
    </div>
  );
}

// ------------------------------------------------------------- actor pane
function SchemaView({ schema }: { schema: Record<string, unknown> | undefined }) {
  const props = schema && typeof schema.properties === 'object' && schema.properties ? (schema.properties as Record<string, any>) : null;
  if (!props || !Object.keys(props).length) return <p className="f-hint">No input.</p>;
  const req = new Set(Array.isArray(schema?.required) ? (schema!.required as unknown[]).map(str) : []);
  return (
    <ul className="ws-schema">
      {Object.entries(props).map(([k, v]) => (
        <li key={k}>
          <code>{k}</code>
          <span className="muted">{str(v?.type) || 'any'}{req.has(k) ? ', required' : ''}</span>
          {v?.description && <span className="ws-schema-d">{str(v.description)}</span>}
        </li>
      ))}
    </ul>
  );
}

function ActorPane({ detail, busy, act, back, askAgent }: {
  detail: ActorDetail | null;
  busy: string | null;
  act: { rollback: (v: number) => void; sync: (s: Source) => void; repair: (s: Source) => void };
  back: () => void;
  askAgent: (text: string) => void;
}) {
  const [confirmRb, setConfirmRb] = useState<number | null>(null);
  const [showCode, setShowCode] = useState(true);
  if (!detail) return <div className="ws-empty"><Spinner /> Loading</div>;
  const m = detail.manifest;
  return (
    <div className="ws-detail">
      <button className="btn small ghost ws-back" onClick={back}><Icon name="back" size={14} /> Workshop</button>
      <header className="ws-dhead">
        <p className="eyebrow"><Dot platform={m.platform} /> {m.platform} · {m.runtime} · v{m.version}</p>
        <h3>{m.name}</h3>
        {m.description && <p className="ws-desc">{m.description}</p>}
        <p className="ws-dmeta">
          <span className={`ws-tier ${m.tier}`}>{m.tier}</span>
          <span className="muted">Updated <time dateTime={m.updatedAt} title={fullTime(m.updatedAt)}>{agoText(m.updatedAt)}</time>{m.createdBy ? ` · by ${m.createdBy === 'agent' ? 'your AI' : m.createdBy}` : ''}</span>
          <button className="btn small ghost" onClick={() => askAgent(`About the connector "${m.name}" (${m.id}): `)}>Ask AI</button>
          <button className="btn small ghost" onClick={() => void exportActor(m.id)} title="Save this connector as a file you can share">Export</button>
          {m.createdBy === 'import' && <button className="btn small" onClick={() => askAgent(`Test the imported connector ${m.id} and, if it works, add it as a source for: `)}>Test and add</button>}
        </p>
      </header>

      <section className="ws-sec">
        <h4>Following with it</h4>
        {detail.sources.length === 0 && <p className="f-hint">No source uses this connector yet.</p>}
        <ul className="ws-srcs">
          {detail.sources.map((s) => (
            <li key={s.id} className={`ws-src ${s.status}`}>
              <div className="ws-src-main">
                <p className="ws-src-name">{s.label}{!s.enabled && <span className="tag">Paused</span>}</p>
                <p className="ws-src-meta">
                  <span className={`status ${s.status}`}>{STATUS_LABEL[s.status]}</span>
                  {' · '}{plural(s.itemCount, 'post')}
                  {s.lastSyncAt && <> · <time dateTime={s.lastSyncAt} title={fullTime(s.lastSyncAt)}>{agoText(s.lastSyncAt)}</time></>}
                </p>
                {s.statusDetail && <p className={`src-detail ${s.status}`}>{s.statusDetail}</p>}
                {typeof s.config.coverage === 'string' && s.config.coverage && <p className="ws-coverage">{s.config.coverage}</p>}
              </div>
              <div className="ws-src-actions">
                <button className="btn small" disabled={busy === `sync:${s.id}`} onClick={() => act.sync(s)}><Icon name="sync" size={14} /> {busy === `sync:${s.id}` ? 'Syncing' : 'Sync now'}</button>
                <button className="btn small ghost" disabled={busy === `repair:${s.id}`} onClick={() => act.repair(s)}>Ask AI to fix</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <div className="ws-cols">
        <section className="ws-sec">
          <h4>Reaches</h4>
          {m.hosts.length ? <ul className="ws-hosts">{m.hosts.map((h) => <li key={h}><code>{h}</code></li>)}</ul> : <p className="f-hint">No network access.</p>}
          {m.hostsFromInput?.length ? <p className="f-hint">Plus the site named in {m.hostsFromInput.map((f) => <code key={f}>{f}</code>)}, and its subdomains.</p> : null}
          {m.python?.requires?.length ? <p className="f-hint">Python packages: {m.python.requires.join(', ')}</p> : null}
        </section>
        <section className="ws-sec">
          <h4>Input</h4>
          <SchemaView schema={m.input} />
        </section>
      </div>

      {m.notes && (
        <section className="ws-sec">
          <h4>Notes</h4>
          <p className="ws-pre ws-notes">{m.notes}</p>
        </section>
      )}

      <section className="ws-sec">
        <h4>
          Code <span className="muted ws-h-note">{m.entry} · {plural(detail.code.split('\n').length, 'line')}</span>
          <button className="btn small ghost ws-h-btn" onClick={() => setShowCode((v) => !v)}>{showCode ? 'Hide' : 'Show'}</button>
        </h4>
        {showCode && <CodeView code={detail.code} runtime={m.runtime} />}
      </section>

      {detail.versions.length > 0 && (
        <section className="ws-sec">
          <h4>Versions</h4>
          <ul className="ws-versions">
            {[...detail.versions].sort((a, b) => b.version - a.version).map((v) => (
              <li key={v.version}>
                <span className="ws-mono">v{v.version}</span>
                <time className="muted" dateTime={v.updatedAt} title={fullTime(v.updatedAt)}>{relTime(v.updatedAt)}</time>
                {v.current ? <span className="tag">Current</span> : confirmRb === v.version ? (
                  <span className="confirm">
                    <button className="btn small danger" disabled={busy === 'rollback'} onClick={() => { setConfirmRb(null); act.rollback(v.version); }}>Confirm roll back to v{v.version}</button>
                    <button className="btn small ghost" onClick={() => setConfirmRb(null)}>Cancel</button>
                  </span>
                ) : (
                  <button className="btn small ghost" onClick={() => setConfirmRb(v.version)}>Roll back to v{v.version}</button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.runs.length > 0 && (
        <section className="ws-sec">
          <h4>Recent runs</h4>
          <ul className="ws-runs">
            {detail.runs.slice(0, 12).map((r) => (
              <li key={r.id} className={r.ok ? 'ok' : 'bad'}>
                <time dateTime={r.startedAt} title={fullTime(r.startedAt)}>{relTime(r.startedAt)}</time>
                <span className="ws-run-st">{r.ok ? 'OK' : 'Failed'}</span>
                <span className="ws-run-msg">{r.ok ? `+${r.added}${r.updated ? ` · ${r.updated} refreshed` : ''}` : firstLine(r.errors[0] ?? 'No details')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ------------------------------------------------------------- Workshop
export function Workshop({ close, lib, toast, askAgent }: { close: () => void; lib: Library; toast: Toast; askAgent: (text: string) => void }) {
  const dlg = useDialog<HTMLDivElement>();
  const [avail, setAvail] = useState<boolean | null>(null);
  const [actors, setActors] = useState<ActorManifest[]>([]);
  const [jobs, setJobs] = useState<AgentThread[]>([]);
  const [sel, setSel] = useState<Sel>(null);
  const [actor, setActor] = useState<ActorDetail | null>(null);
  const [job, setJob] = useState<ThreadDetail | null>(null);
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const selRef = useRef<Sel>(null);
  selRef.current = sel;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const autoPicked = useRef(false);

  const loadLists = useCallback(async () => {
    const [a, j] = await Promise.allSettled([
      call<{ available: boolean; actors: ActorManifest[] }>('GET', '/api/actors'),
      call<AgentThread[]>('GET', '/api/agent/jobs'),
    ]);
    if (a.status === 'fulfilled') {
      setAvail(a.value.available);
      setActors(a.value.actors ?? []);
      setListError(null);
      if (!autoPicked.current && !selRef.current && a.value.actors?.length && isDesktop()) {
        autoPicked.current = true;
        setSel({ type: 'actor', id: a.value.actors[0].id });
      }
    } else setListError((a.reason as Error).message);
    if (j.status === 'fulfilled' && Array.isArray(j.value)) setJobs(j.value);
  }, []);

  const loadSel = useCallback(async () => {
    const s = selRef.current;
    if (!s) return;
    try {
      if (s.type === 'actor') {
        const d = await call<ActorDetail>('GET', `/api/actors/${enc(s.id)}`);
        if (selRef.current?.id === s.id) setActor(d);
      } else {
        const d = await call<ThreadDetail>('GET', `/api/agent/threads/${enc(s.id)}`);
        if (selRef.current?.id === s.id) setJob(d);
      }
    } catch (e) {
      if (selRef.current?.id === s.id) {
        toastRef.current((e as Error).message, { tone: 'error' });
        setSel(null);
      }
    }
  }, []);

  useEffect(() => {
    void loadLists();
    const t = setInterval(() => {
      if (document.hidden) return;
      void loadLists();
      void loadSel();
    }, 3000);
    return () => clearInterval(t);
  }, [loadLists, loadSel]);

  useEffect(() => {
    setActor(null);
    setJob(null);
    void loadSel();
  }, [sel?.type, sel?.id, loadSel]);

  const sourcesFor = (id: string) => lib.sources.filter((s) => s.connector === 'actor' && s.config.actorId === id);

  const startJob = async (body: Record<string, unknown>, okText: string) => {
    const out = await call<{ threadId: string }>('POST', '/api/agent/jobs', body);
    toast(okText);
    void loadLists();
    setSel({ type: 'job', id: out.threadId });
  };

  const build = async () => {
    const text = request.trim();
    if (!text) return;
    setBusy('build');
    try {
      await startJob({ kind: 'build', request: text }, 'Building…');
      setRequest('');
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const act = {
    rollback: async (version: number) => {
      const s = selRef.current;
      if (s?.type !== 'actor') return;
      setBusy('rollback');
      try {
        const m = await call<ActorManifest>('POST', `/api/actors/${enc(s.id)}/rollback`, { version });
        toast(`${m.name} is back on v${version}${m.version !== version ? ` (saved as v${m.version})` : ''}`);
        await Promise.all([loadSel(), loadLists()]);
      } catch (e) {
        toast((e as Error).message, { tone: 'error' });
      } finally {
        setBusy(null);
      }
    },
    sync: async (src: Source) => {
      setBusy(`sync:${src.id}`);
      try {
        const r = await call<{ added?: number; updated?: number; errors?: string[]; error?: string; blocked?: string }>('POST', `/api/sources/${enc(src.id)}/sync`, {});
        if (r.blocked) toast(`${src.label}: ${r.blocked}`, { tone: 'error' });
        else if (r.error) toast(`${src.label}: ${r.error}`, { tone: 'error' });
        else toast(`${src.label}: ${plural(r.added ?? 0, 'new post')}${r.errors?.length ? `, ${plural(r.errors.length, 'problem')}` : ''}`);
        void loadSel();
      } catch (e) {
        toast((e as Error).message, { tone: 'error' });
      } finally {
        setBusy(null);
      }
    },
    repair: async (src: Source) => {
      setBusy(`repair:${src.id}`);
      try {
        await startJob({ kind: 'repair', sourceId: src.id }, `Asked the AI to fix ${src.label}`);
      } catch (e) {
        toast((e as Error).message, { tone: 'error' });
      } finally {
        setBusy(null);
      }
    },
  };

  const stop = async (id: string) => {
    try {
      await call('POST', `/api/agent/threads/${enc(id)}/stop`, {});
      toast('Stopping');
      void loadSel();
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  };

  const importActor = async (file: File) => {
    try {
      const bundle = JSON.parse(await file.text());
      const r = await call<{ manifest: ActorManifest; renamed: boolean }>('POST', '/api/actors/import', { bundle });
      toast(`Imported “${r.manifest.name}”${r.renamed ? ` as ${r.manifest.id}` : ''}. Check what it reaches, then test it.`);
      await loadLists();
      setSel({ type: 'actor', id: r.manifest.id });
    } catch (e) {
      toast(e instanceof SyntaxError ? 'That file is not JSON' : (e as Error).message, { tone: 'error' });
    }
  };

  const liveJobs = jobs.filter((j) => j.status === 'running' || j.status === 'waiting').length;

  return (
    <div className="sheet-backdrop" onClick={close}>
      <div ref={dlg} className="sheet ws-sheet" role="dialog" aria-modal="true" aria-label="Workshop" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Workshop</h2>
          {liveJobs > 0 && <span className="ws-live"><Spinner /> {plural(liveJobs, 'job')} running</span>}
          <button className="icon-btn" onClick={close} aria-label="Close"><Icon name="x" /></button>
        </div>

        <form className="ws-build" onSubmit={(e) => { e.preventDefault(); void build(); }}>
          <span className="ws-build-ic" aria-hidden><Icon name="plus" size={16} /></span>
          <input
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            placeholder="Describe what to follow…"
            aria-label="Describe what to follow"
            maxLength={4000}
          />
          <button className="btn primary small" type="submit" disabled={!request.trim() || busy === 'build'}>{busy === 'build' ? 'Starting' : 'Build connector'}</button>
        </form>

        <div className={`ws-grid ${sel ? 'has-sel' : ''}`}>
          <nav className="ws-side" aria-label="Connectors and jobs">
            <p className="eyebrow ws-side-head">
              Connectors
              <label className="btn small ghost ws-import" title="Add a connector someone shared as a file">
                Import
                <input type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importActor(f); }} />
              </label>
            </p>
            {listError && <p className="form-error ws-pad">{listError}</p>}
            {avail === false && <p className="f-hint ws-pad">The actor runtime is not available on this server, so the AI cannot build or run connectors here.</p>}
            {avail && actors.length === 0 && <p className="f-hint ws-pad">None yet. Describe something to follow above and the AI builds a connector for it.</p>}
            <ul className="ws-list">
              {actors.map((a) => {
                const srcs = sourcesFor(a.id);
                const worst = srcs.find((s) => s.status === 'error' || s.status === 'blocked') ?? srcs.find((s) => s.status === 'syncing') ?? srcs[0];
                const last = srcs.map((s) => s.lastSyncAt).filter(Boolean).sort().pop();
                const on = sel?.type === 'actor' && sel.id === a.id;
                return (
                  <li key={a.id}>
                    <button className={`ws-item ${on ? 'on' : ''}`} aria-current={on || undefined} onClick={() => setSel({ type: 'actor', id: a.id })}>
                      <Dot platform={a.platform} />
                      <span className="ws-item-main">
                        <span className="ws-item-name">{a.name}</span>
                        <span className="ws-item-meta">
                          <span className={`ws-tier ${a.tier}`}>{a.tier}</span>
                          <span>v{a.version}</span>
                          {worst ? <span className={`status ${worst.status}`}>{STATUS_LABEL[worst.status]}</span> : <span>Unused</span>}
                          {last && <span>{agoText(last)}</span>}
                        </span>
                        {worst?.statusDetail && worst.status !== 'ok' && <span className="ws-item-detail">{firstLine(worst.statusDetail, 90)}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <p className="eyebrow ws-eyebrow-gap">Jobs</p>
            {jobs.length === 0 && <p className="f-hint ws-pad">No AI jobs yet.</p>}
            <ul className="ws-list">
              {jobs.slice(0, 40).map((j) => {
                const on = sel?.type === 'job' && sel.id === j.id;
                const live = j.status === 'running' || j.status === 'waiting';
                return (
                  <li key={j.id}>
                    <button className={`ws-item ws-job ${on ? 'on' : ''}`} aria-current={on || undefined} onClick={() => setSel({ type: 'job', id: j.id })}>
                      <span className={`ws-job-ic ${j.status}`} aria-hidden>{live ? <Spinner /> : null}</span>
                      <span className="ws-item-main">
                        <span className="ws-item-name">{j.title ?? 'Untitled job'}</span>
                        <span className="ws-item-meta">
                          <span>{j.kind === 'repair' ? 'Repair' : 'Build'}</span>
                          <span className={`ws-job-st ${j.status}`}>{JOB_LABEL[j.status] ?? j.status}</span>
                          <span>{relTime(j.createdAt)}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <section className="ws-main" aria-live="polite">
            {!sel && (
              <div className="ws-empty ws-hello">
                <p className="ws-hello-t">Connectors your AI built</p>
                <p className="f-hint">Each one is a small script that runs in a sandbox and can only reach the hosts it lists. Pick one to read its code, see how it is doing, or roll it back.</p>
              </div>
            )}
            {sel?.type === 'actor' && <ActorPane key={sel.id} detail={actor} busy={busy} act={act} back={() => setSel(null)} askAgent={askAgent} />}
            {sel?.type === 'job' && <JobPane key={sel.id} detail={job} onStop={(id) => void stop(id)} back={() => setSel(null)} />}
          </section>
        </div>
      </div>
    </div>
  );
}
