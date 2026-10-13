// The "Jobs" and "Spend" tabs of AI settings: model servers on this computer, which model does
// which job, and what the AI has cost.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from './icons.tsx';

type Task = 'chat' | 'builder' | 'classifier' | 'alerts' | 'week' | 'summaries' | 'briefs' | 'routines';
type Fit = 'good' | 'fair' | 'weak';

interface Route { provider: 'claude' | 'openai'; model: string; baseUrl?: string | null }
interface Resolved extends Route { routed: boolean; local: boolean; key: 'main' | 'env' | 'none' }
interface TaskRow { task: Task; label: string; what: string; background: 'always' | 'automatic-only' | 'never'; local: Fit; note: string; resolved: Resolved }
interface LocalServer { id: string; name: string; baseUrl: string; models: { id: string; size?: string; params?: number | null }[] }

interface Totals { cost: number; calls: number; inTokens: number; outTokens: number; unknown: number }
interface SpendView {
  today: Totals;
  week: Totals;
  month: Totals;
  byTask: ({ task: Task } & Totals)[];
  byModel: ({ model: string; provider: string; local: boolean } & Totals)[];
  topBuilds: { ref: string | null; label: string; model: string; cost: number; at: string }[];
  daily: { day: string; cost: number }[];
  caps: Partial<Record<Task, number>>;
  capStates: { task: Task; spent: number; cap: number; reached: boolean; localOnly: boolean }[];
  tasks: { task: Task; label: string; background: 'always' | 'automatic-only' | 'never' }[];
}

type Toast = (text: string, opts?: { tone?: 'info' | 'error' }) => void;

export async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
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

const CLAUDE_MODELS = [
  { model: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 · fast, cheap' },
  { model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 · balanced' },
  { model: 'claude-opus-5-5', label: 'Claude Opus 5.5 · strongest' },
];
/** Jobs a small local model does well, for the one-click "use for all small jobs". */
const SMALL_JOBS: Task[] = ['classifier', 'alerts', 'summaries', 'briefs', 'week'];
const FIT_TEXT: Record<Fit, string> = { good: 'Small local model: good', fair: 'Small local model: fair', weak: 'Needs a strong model' };

const keyOf = (r: Route) => `${r.provider}|${r.provider === 'openai' ? (r.baseUrl ?? '') : ''}|${r.model}`;
const host = (url?: string | null) => {
  try {
    return url ? new URL(url).host : '';
  } catch {
    return url ?? '';
  }
};

export function money(n: number): string {
  if (!n) return '$0';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}
const tokens = (t: Totals) => {
  const n = t.inTokens + t.outTokens;
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M tokens` : n >= 1e3 ? `${Math.round(n / 1e3)}k tokens` : `${n} tokens`;
};

// ---------------------------------------------------------------- Jobs

export function AiJobs({ toast }: { toast: Toast }) {
  const [servers, setServers] = useState<LocalServer[] | null>(null);
  const [cloud, setCloud] = useState(false);
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const probe = useCallback(() => {
    setServers(null);
    call<{ cloud: boolean; servers: LocalServer[] }>('GET', '/api/ai/local').then(
      (d) => { setCloud(d.cloud); setServers(d.servers); },
      () => setServers([]),
    );
  }, []);
  useEffect(() => {
    probe();
    call<{ tasks: TaskRow[] }>('GET', '/api/ai/routes').then((d) => setTasks(d.tasks), (e) => toast((e as Error).message, { tone: 'error' }));
  }, [probe, toast]);

  const save = async (changes: { task: Task; route: Route | null }[], done: string) => {
    setBusy(true);
    try {
      const d = await call<{ tasks: TaskRow[] }>('PUT', '/api/ai/routes', { changes });
      setTasks(d.tasks);
      toast(done);
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const label = (t: Task) => tasks?.find((x) => x.task === t)?.label ?? t;
  const useLocal = (s: LocalServer, model: string, which: Task | 'small') => {
    const list = which === 'small' ? SMALL_JOBS : [which];
    const route: Route = { provider: 'openai', model, baseUrl: s.baseUrl };
    void save(list.map((task) => ({ task, route })), which === 'small' ? `${model} now does the small jobs` : `${model} now does ${label(which)}`);
  };

  // Every choice a job can take: the default, Claude models and each model found on this computer.
  const choices = useMemo(() => {
    const out: { key: string; label: string; route: Route; group: string }[] = [];
    for (const c of CLAUDE_MODELS) out.push({ key: keyOf({ provider: 'claude', model: c.model }), label: c.label, route: { provider: 'claude', model: c.model }, group: 'Claude' });
    for (const s of servers ?? []) for (const m of s.models) {
      const route: Route = { provider: 'openai', model: m.id, baseUrl: s.baseUrl };
      out.push({ key: keyOf(route), label: `${m.id}${m.size ? ` · ${m.size}` : ''} · free`, route, group: `${s.name} on this computer` });
    }
    return out;
  }, [servers]);

  return (
    <div className="aij">
      <section className="f-sec">
        <div className="f-row-head">
          <h3>Models on this computer</h3>
          {!cloud && <button type="button" className="btn small ghost" onClick={probe} disabled={servers === null}><Icon name="sync" size={13} /> Look again</button>}
        </div>
        <p className="f-hint">Aurora checks for Ollama, LM Studio and a llama.cpp server on this computer only (127.0.0.1), never the network. Local models are free and nothing leaves the machine.</p>
        {cloud && <p className="f-hint">This is a hosted Aurora, so there is no computer of yours to look on. Use a hosted model below.</p>}
        {!cloud && servers === null && <p className="aij-probe" role="status"><span className="aij-spin" /> Looking…</p>}
        {!cloud && servers?.length === 0 && (
          <div className="aij-empty">
            <p>No local model server is running.</p>
            <p className="f-hint">Install <b>Ollama</b> and run <code>ollama pull qwen3:8b</code> for the small jobs (about 5 GB). A 30B-class model such as <code>qwen3-coder:30b</code> can also chat. Then press Look again.</p>
          </div>
        )}
        {servers?.map((s) => {
          const shown = open[s.id] ? s.models : s.models.slice(0, 6);
          return (
            <div key={s.id} className="aij-server">
              <div className="aij-server-head">
                <span className="aij-dot" />
                <b>{s.name}</b>
                <span className="aij-url">{host(s.baseUrl)}</span>
                <span className="aij-count">{s.models.length} model{s.models.length === 1 ? '' : 's'}</span>
              </div>
              {s.models.length === 0 && <p className="f-hint">Running, but no models are loaded yet.</p>}
              <ul className="aij-models">
                {shown.map((m) => (
                  <li key={m.id}>
                    <span className="aij-model">
                      <b>{m.id}</b>
                      <small>{m.size ?? (m.params ? `${m.params}B` : '')}{m.params != null && m.params < 20 ? ' · good for small jobs' : m.params != null ? ' · can chat' : ''}</small>
                    </span>
                    <select
                      className="aij-use"
                      aria-label={`Use ${m.id} for`}
                      value=""
                      disabled={busy || !tasks}
                      onChange={(e) => { const v = e.target.value; if (v) useLocal(s, m.id, v as Task | 'small'); }}
                    >
                      <option value="">Use for…</option>
                      <option value="small">All small jobs</option>
                      {tasks?.map((t) => <option key={t.task} value={t.task}>{t.label}{t.local === 'weak' ? ' (not advised)' : ''}</option>)}
                    </select>
                  </li>
                ))}
              </ul>
              {s.models.length > 6 && <button type="button" className="chip ghost" onClick={() => setOpen({ ...open, [s.id]: !open[s.id] })}>{open[s.id] ? 'Show fewer' : `Show all ${s.models.length}`}</button>}
            </div>
          );
        })}
      </section>

      <section className="f-sec">
        <h3>Who does what</h3>
        <p className="f-hint">Each job can run on its own model. Default follows the provider on the Setup tab. Small local models label, match alerts and summarise well; connector builds need a strong model.</p>
        {!tasks && <p className="aij-probe"><span className="aij-spin" /> Loading…</p>}
        <ul className="aij-jobs">
          {tasks?.map((t) => {
            const cur = t.resolved.routed ? keyOf(t.resolved) : '';
            const known = !cur || choices.some((c) => c.key === cur);
            return (
              <li key={t.task} className="aij-job">
                <div className="aij-job-main">
                  <span className="aij-job-title">{t.label}</span>
                  <span className="aij-job-what">{t.what}</span>
                  <span className="aij-job-now">
                    <span className={`aij-badge ${t.resolved.local ? 'free' : ''}`}>{t.resolved.local ? 'local · free' : t.resolved.provider === 'claude' ? 'Claude' : host(t.resolved.baseUrl) || 'hosted'}</span>
                    <code>{t.resolved.model || 'not set'}</code>
                    {t.resolved.routed && t.resolved.key === 'none' && !t.resolved.local && <span className="aij-warn">no key is sent to this service</span>}
                  </span>
                </div>
                <select
                  className="aij-pick"
                  aria-label={`Model for ${t.label}`}
                  value={cur}
                  disabled={busy}
                  onChange={(e) => {
                    const v = e.target.value;
                    const c = choices.find((x) => x.key === v);
                    void save([{ task: t.task, route: v ? c?.route ?? null : null }], v ? `${t.label} now uses ${c?.route.model}` : `${t.label} back to the default`);
                  }}
                >
                  <option value="">Default</option>
                  {!known && <option value={cur}>{t.resolved.model} (saved)</option>}
                  {['Claude', ...new Set(choices.filter((c) => c.group !== 'Claude').map((c) => c.group))].map((g) => (
                    <optgroup key={g} label={g}>
                      {choices.filter((c) => c.group === g).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                    </optgroup>
                  ))}
                </select>
                <p className={`aij-fit ${t.local}`}><b>{FIT_TEXT[t.local]}.</b> {t.note}</p>
              </li>
            );
          })}
        </ul>
        <p className="f-hint">A saved API key only goes to the service it was saved for. Claude jobs use that key or the Claude Code login on this computer.</p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- Spend

export function AiSpend({ toast }: { toast: Toast }) {
  const [v, setV] = useState<SpendView | null>(null);
  const [draft, setDraft] = useState<Partial<Record<Task, string>>>({});

  useEffect(() => {
    call<SpendView>('GET', '/api/ai/spend').then(setV, (e) => toast((e as Error).message, { tone: 'error' }));
  }, [toast]);

  const label = (t: Task) => v?.tasks.find((x) => x.task === t)?.label ?? t;
  const saveCap = async (task: Task) => {
    const raw = draft[task];
    if (raw === undefined) return;
    const usd = raw.trim() === '' ? null : Number(raw.replace(/^\$/, ''));
    if (usd !== null && !(usd >= 0)) return toast('Enter a dollar amount, or leave it empty for no cap', { tone: 'error' });
    try {
      const next = await call<SpendView>('PUT', '/api/ai/caps', { task, usd });
      setV(next);
      setDraft((d) => { const c = { ...d }; delete c[task]; return c; });
      toast(usd === null ? `No cap on ${label(task)}` : `${label(task)} pauses after ${money(usd)} a month`);
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  };

  if (!v) return <p className="aij-probe"><span className="aij-spin" /> Loading…</p>;
  const max = Math.max(...v.daily.map((d) => d.cost), 0);
  const taskMax = Math.max(...v.byTask.map((t) => t.cost), 0);
  const unknown = v.month.unknown;
  const capped = v.tasks.filter((t) => t.background !== 'never');
  const reached = v.capStates.filter((c) => c.reached && !c.localOnly);

  return (
    <div className="aij spend">
      {reached.length > 0 && (
        <div className="spend-paused" role="alert">
          <Icon name="pause" size={15} />
          <p><b>{reached.map((c) => label(c.task)).join(', ')} paused</b> for the rest of the month: the cap is reached. Raise or clear the cap below to resume. Chats you start keep working.</p>
        </div>
      )}
      <div className="spend-cards">
        {([['Today', v.today], ['This week', v.week], ['This month', v.month]] as const).map(([name, t]) => (
          <div key={name} className="spend-card">
            <span className="spend-card-k">{name}</span>
            <span className="spend-card-v">{money(t.cost)}</span>
            <span className="spend-card-s">{t.calls} call{t.calls === 1 ? '' : 's'} · {tokens(t)}</span>
          </div>
        ))}
      </div>
      <div className="spend-days" aria-label="Spending over the last 30 days">
        {v.daily.map((d) => (
          <span key={d.day} className={`spend-day ${d.cost ? '' : 'zero'}`} style={{ height: `${max ? Math.max(4, (d.cost / max) * 100) : 4}%` }} title={`${d.day}: ${money(d.cost)}`} />
        ))}
      </div>
      <p className="spend-days-cap"><span>30 days ago</span><span>Today</span></p>
      <p className="f-hint">Costs are what the provider reported for each call. With the Claude Code login they are estimates of what the same work would cost on the API. Local models count as $0.{unknown ? ` ${unknown} call${unknown === 1 ? '' : 's'} this month went to a service that does not report a cost.` : ''}</p>

      <section className="f-sec">
        <h3>This month by job</h3>
        {v.byTask.length === 0 && <p className="f-hint">Nothing yet. Spending is recorded from now on.</p>}
        <ul className="spend-rows">
          {v.byTask.map((t) => (
            <li key={t.task}>
              <span className="spend-name">{label(t.task)}</span>
              <span className="spend-bar"><span style={{ width: `${taskMax ? (t.cost / taskMax) * 100 : 0}%` }} /></span>
              <span className="spend-num">{money(t.cost)}</span>
              <span className="spend-calls">{t.calls}×</span>
            </li>
          ))}
        </ul>
      </section>

      {v.byModel.length > 0 && (
        <section className="f-sec">
          <h3>This month by model</h3>
          <ul className="spend-rows">
            {v.byModel.map((m) => (
              <li key={`${m.provider}|${m.model}`}>
                <span className="spend-name"><code>{m.model}</code>{m.local && <span className="aij-badge free">local</span>}</span>
                <span className="spend-num">{money(m.cost)}</span>
                <span className="spend-calls">{m.calls}× · {tokens(m)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {v.topBuilds.length > 0 && (
        <section className="f-sec">
          <h3>Most expensive connector builds</h3>
          <ul className="spend-rows builds">
            {v.topBuilds.map((b, i) => (
              <li key={b.ref ?? i}>
                <span className="spend-name">{b.label}<small>{new Date(b.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {b.model}</small></span>
                <span className="spend-num">{money(b.cost)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="f-sec">
        <h3>Monthly caps</h3>
        <p className="f-hint">When a job reaches its cap, Aurora pauses that background work until next month and tells you. A chat you start is never paused; for connector builds only automatic repairs pause. Local models are free, so a cap never stops them: $0 means local models only.</p>
        <ul className="spend-caps">
          {capped.map((t) => {
            const st = v.capStates.find((c) => c.task === t.task);
            const spent = v.byTask.find((x) => x.task === t.task)?.cost ?? 0;
            const val = draft[t.task] ?? (v.caps[t.task] != null ? String(v.caps[t.task]) : '');
            return (
              <li key={t.task} className={st?.reached && !st.localOnly ? 'reached' : ''}>
                <span className="spend-name">{t.label}<small>{money(spent)} this month{st?.localOnly ? ' · local models only' : st ? ` of ${money(st.cap)}${st.reached ? ' · paused' : ''}` : ''}</small></span>
                <label className="spend-cap-in">
                  <span>$</span>
                  <input
                    inputMode="decimal"
                    placeholder="No cap"
                    aria-label={`Monthly cap for ${t.label} in dollars`}
                    value={val}
                    onChange={(e) => setDraft({ ...draft, [t.task]: e.target.value })}
                    onBlur={() => void saveCap(t.task)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  />
                </label>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
