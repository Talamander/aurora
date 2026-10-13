// The agent runtime: conversations, background builder jobs, provider choice and the HTTP routes.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { broadcast } from '../events.ts';
import { chatTools, undoChange } from './tools.ts';
import { builderTools } from './builder.ts';
import { builderSystem, chatSystem, routineSystem } from './prompts.ts';
import { ROUTINE_TOOLS } from '../../core/routines.ts';
import { runClaude } from './providers/claude.ts';
import { runOpenAI } from './providers/openai.ts';
import { AI_TASKS, TASK_INFO, capBlock, capStates, isTask, parseCap, parseRoute, periodStarts, resolveRoute, type AiTask, type Caps, type Resolved, type Routes } from './routing.ts';
import { money, spendFor } from './spend.ts';
import { detectLocalModels } from './localModels.ts';
import type { AgentApp, AiConfig, ProviderResult, ProviderRun, ToolCtx } from './types.ts';
import type { AgentThread } from '../../core/types.ts';

type RouteFn = (method: string, path: string, handler: (req: any, res: any, params: Record<string, string>, body: any, url: URL) => unknown) => void;

const DEFAULT_CONFIG: AiConfig = { provider: 'claude', model: 'claude-sonnet-5-5', builderModel: 'claude-opus-5-5', baseUrl: null };
const MAX_JOBS = 3;

export interface AgentRuntime {
  startJob: AgentApp['startJob'];
  status: () => { ready: boolean; provider: string; model: string; builderModel: string; reason?: string; via?: string };
  /** One-shot completion without tools, for classification and digests. */
  complete: (prompt: string, opts?: { system?: string; model?: string; task?: AiTask }) => Promise<string>;
  /** complete() bound to one job, so its model route, spend and cap apply. */
  completeFor: (task: AiTask) => (prompt: string, opts?: { system?: string; model?: string }) => Promise<string>;
  send: (threadId: string, text: string, context?: unknown, origin?: ToolCtx['origin']) => void;
  /** One unattended routine run with the routine tool allowlist, a dollar limit and its own thread. */
  runRoutine: (job: RoutineJob) => Promise<RoutineResult>;
}

export interface RoutineJob {
  routineId: string;
  name: string;
  prompt: string;
  schedule: string;
  profile: string | null;
  origin: 'user' | 'schedule';
  maxBudgetUsd: number;
}

export interface RoutineResult {
  threadId: string;
  ok: boolean;
  text: string;
  costUsd: number | null;
  error: string | null;
  steps: string[];
}

export function createAgentRuntime(app: Omit<AgentApp, 'startJob'>, deps: { route: RouteFn; HttpError: new (status: number, msg: string) => Error }): AgentRuntime {
  const { store } = app;
  const running = new Map<string, AbortController>();
  const queues = new Map<string, { text: string; context?: unknown; origin: ToolCtx['origin'] }[]>();
  const jobQueue: string[] = [];

  const config = (): AiConfig => ({ ...DEFAULT_CONFIG, ...(store.getSetting<Partial<AiConfig>>('ai.config') ?? {}) });
  const apiKey = () => store.getSecret('ai.apiKey') ?? (config().provider === 'claude' ? process.env.ANTHROPIC_API_KEY ?? null : process.env.OPENAI_API_KEY ?? null);
  const routes = (): Routes => store.getSetting<Routes>('ai.routes') ?? {};
  const caps = (): Caps => store.getSetting<Caps>('ai.caps') ?? {};
  const spend = spendFor(app.dataDir);

  function status() {
    const c = config();
    if (c.provider === 'openai') {
      if (!c.baseUrl) return { ready: false, provider: c.provider, model: c.model, builderModel: c.builderModel, reason: 'Set the endpoint URL (for Ollama: http://127.0.0.1:11434/v1).' };
      return { ready: true, provider: c.provider, model: c.model, builderModel: c.builderModel, via: c.baseUrl };
    }
    if (apiKey()) return { ready: true, provider: c.provider, model: c.model, builderModel: c.builderModel, via: 'API key' };
    // The Claude Code login is used if this machine has one. We only check that it exists.
    const loggedIn = existsSync(join(homedir(), '.claude', '.credentials.json')) || existsSync(join(homedir(), '.claude.json'));
    if (loggedIn) return { ready: true, provider: c.provider, model: c.model, builderModel: c.builderModel, via: 'Claude Code login on this computer' };
    return { ready: false, provider: c.provider, model: c.model, builderModel: c.builderModel, reason: 'Add an Anthropic API key, sign in to Claude Code on this computer, or point it at a local model.' };
  }

  async function provide(run: ProviderRun, r: Resolved): Promise<ProviderResult> {
    // A key saved for one service never goes to another one (see resolveRoute).
    if (r.provider === 'openai') return runOpenAI(run, { baseUrl: r.baseUrl ?? '', apiKey: r.key === 'main' ? apiKey() : null });
    return runClaude(run, { dataDir: app.dataDir, apiKey: r.key === 'main' ? apiKey() : process.env.ANTHROPIC_API_KEY ?? null });
  }

  /** Writes one call to the spend log. Never lets bookkeeping break a run. */
  function recordSpend(r: Resolved, result: ProviderResult, ref?: string | null, label?: string | null) {
    try {
      spend.record({ task: r.task, provider: r.provider, model: r.model, costUsd: result.costUsd ?? (r.local ? 0 : null), inTokens: result.inTokens, outTokens: result.outTokens, local: r.local, ref, label });
    } catch (e) {
      console.warn('[spend] could not record:', (e as Error).message);
    }
  }

  // Tell the open app once per job and month that a cap paused it.
  const pausedNoticed = new Set<string>();
  function checkCap(task: AiTask, origin: ToolCtx['origin'], local: boolean) {
    const hit = capBlock(task, origin, spend.monthByTask(), caps(), local);
    if (!hit) return;
    if (hit.localOnly) throw new Error(`${TASK_INFO[task].label} is set to local models only (a $0 cap). Pick a local model for it in AI settings, Models & jobs.`);
    const key = `${task}|${periodStarts().month}`;
    if (!pausedNoticed.has(key)) {
      pausedNoticed.add(key);
      broadcast({ type: 'ui', action: { kind: 'ai-paused', task, label: TASK_INFO[task].label, spent: hit.spent, cap: hit.cap } });
    }
    throw new Error(`${TASK_INFO[task].label} paused: this month's cap of ${money(hit.cap)} is reached (${money(hit.spent)} spent). Raise it in AI settings, Spend.`);
  }

  function emitter(threadId: string) {
    return (type: string, data: unknown) => {
      const ev = store.addEvent(threadId, type, data);
      broadcast({ type: 'agent', threadId, event: { id: ev.id, type, data, at: ev.at } });
    };
  }

  function setStatus(t: AgentThread, status: AgentThread['status'], meta?: Record<string, unknown>) {
    store.updateThread(t.id, { status, ...(meta ? { meta } : {}) });
    broadcast({ type: 'thread', threadId: t.id, status, kind: t.kind, title: t.title, parentId: t.parentId });
  }

  function history(threadId: string) {
    return store
      .listEvents(threadId)
      .filter((e) => e.type === 'user' || e.type === 'assistant')
      .map((e) => ({ role: e.type === 'user' ? ('user' as const) : ('assistant' as const), text: String(e.data?.text ?? '') }));
  }

  function contextText(context: any): string {
    if (!context || typeof context !== 'object') return '(unknown)';
    const lines: string[] = [];
    // The profile the user is looking at becomes the server's active one, so tools see what they see.
    if (app.profiles && typeof context.profile === 'string') {
      try {
        if (app.profiles.active() !== context.profile) app.profiles.setActive(context.profile);
      } catch {
        /* a deleted profile: keep the current one */
      }
    }
    const profile = app.profiles?.get(app.profiles.active());
    if (profile) {
      lines.push(`Active profile: ${profile.name} (id ${profile.id}). Every library tool sees only this profile's ${profile.sourceIds.length} sources and its own views, pages and rules. New sources, views, pages and rules you create join this profile.`);
      if (profile.instructions) lines.push(`The user's instructions for this profile (follow them in this profile): ${profile.instructions}`);
    } else if (app.profiles?.list().length) {
      lines.push(`Active profile: All (sees every source). Other profiles: ${app.profiles.list().map((p) => `${p.name} (${p.id})`).join(', ')}.`);
    }
    if (context.screen) lines.push(`Screen: ${context.screen}`);
    if (context.viewName) lines.push(`View: ${context.viewName}`);
    if (context.pageName) lines.push(`Page: ${context.pageName} (${context.pageId})`);
    if (context.shown !== undefined) lines.push(`Posts shown: ${context.shown}`);
    if (context.spec) lines.push(`Current filter (non-default parts): ${JSON.stringify(context.spec)}`);
    if (context.selectedPostId) lines.push(`Selected post: ${context.selectedPostId}`);
    lines.push(`Local time: ${new Date().toString()}`);
    return lines.join('\n');
  }

  async function execute(thread: AgentThread, text: string, context: unknown, origin: ToolCtx['origin']) {
    const abort = new AbortController();
    running.set(thread.id, abort);
    const emit = emitter(thread.id);
    const ctx: ToolCtx = { threadId: thread.id, origin, app: { ...app, startJob }, emit };
    const prior = history(thread.id);
    emit('user', { text, context: thread.kind === 'chat' ? context ?? null : null });
    if (!thread.title) {
      const title = text.replace(/\s+/g, ' ').slice(0, 70);
      store.updateThread(thread.id, { title });
      thread.title = title;
    }
    setStatus(thread, 'running');
    const isChat = thread.kind === 'chat';
    const task: AiTask = isChat ? 'chat' : 'builder';
    const route = resolveRoute(task, config(), routes());
    try {
      checkCap(task, origin, route.local);
      const result = await provide({
        system: isChat ? chatSystem(contextText(context)) : builderSystem(thread.kind === 'repair' ? 'repair' : 'build'),
        prompt: text,
        history: prior,
        tools: isChat ? chatTools : builderTools,
        ctx,
        model: route.model,
        sessionId: (thread.meta.sessionId as string) ?? null,
        signal: abort.signal,
        onDelta: (d) => broadcast({ type: 'delta', threadId: thread.id, text: d }),
        maxTurns: isChat ? 30 : 80,
      }, route);
      recordSpend(route, result, thread.id, thread.title);
      const meta = { ...store.getThread(thread.id)!.meta, sessionId: result.sessionId ?? thread.meta.sessionId ?? null, costUsd: ((thread.meta.costUsd as number) ?? 0) + (result.costUsd ?? 0) };
      emit('done', { costUsd: result.costUsd ?? null, turns: result.turns ?? null });
      setStatus(thread, isChat ? 'idle' : 'done', meta);
      if (thread.parentId) emitter(thread.parentId)('job_done', { jobId: thread.id, ok: true, summary: result.text.slice(0, 2000), title: thread.title });
    } catch (e) {
      const msg = abort.signal.aborted ? 'Stopped.' : (e as Error).message || 'The AI run failed';
      emit('error', { text: msg });
      setStatus(thread, isChat ? 'idle' : 'error');
      if (thread.parentId) emitter(thread.parentId)('job_done', { jobId: thread.id, ok: false, summary: msg, title: thread.title });
    } finally {
      running.delete(thread.id);
      const next = queues.get(thread.id)?.shift();
      if (next) void execute(store.getThread(thread.id)!, next.text, next.context, next.origin);
      else if (!isChat) pumpJobs();
    }
  }

  function send(threadId: string, text: string, context?: unknown, origin: ToolCtx['origin'] = 'user') {
    const thread = store.getThread(threadId);
    if (!thread) throw new deps.HttpError(404, 'No such conversation');
    if (running.has(threadId)) {
      const q = queues.get(threadId) ?? [];
      q.push({ text, context, origin });
      queues.set(threadId, q);
      return;
    }
    void execute(thread, text, context, origin);
  }

  function runningJobs() {
    return [...running.keys()].filter((id) => store.getThread(id)?.kind !== 'chat').length;
  }

  function pumpJobs() {
    while (jobQueue.length && runningJobs() < MAX_JOBS) {
      const id = jobQueue.shift()!;
      const t = store.getThread(id);
      if (!t) continue;
      void execute(t, String(t.meta.request ?? ''), null, (t.meta.origin as ToolCtx['origin']) ?? 'user');
    }
  }

  function startJob(job: { kind: 'build' | 'repair'; request: string; parentId: string | null; sourceId?: string; origin: ToolCtx['origin'] }) {
    let request = job.request;
    if (job.kind === 'repair' && job.sourceId) {
      const s = store.getSource(job.sourceId);
      request += `\nSource id: ${job.sourceId}. Actor: ${String(s?.config.actorId ?? '?')}. Input: ${JSON.stringify(s?.config.input ?? {})}. Start with get_source and get_actor.`;
      if (job.origin !== 'user') request += '\nThis repair started automatically. Do not add hosts outside the actor\'s current list; if new hosts are needed, stop and explain.';
    }
    const t = store.createThread({ kind: job.kind, title: job.request.slice(0, 90), parentId: job.parentId, meta: { request, origin: job.origin, sourceId: job.sourceId ?? null } });
    if (job.parentId) emitter(job.parentId)('job', { jobId: t.id, kind: job.kind, title: t.title });
    broadcast({ type: 'thread', threadId: t.id, status: 'waiting', kind: t.kind, title: t.title, parentId: t.parentId });
    store.updateThread(t.id, { status: 'waiting' });
    jobQueue.push(t.id);
    pumpJobs();
    return { threadId: t.id };
  }

  async function complete(prompt: string, opts: { system?: string; model?: string; task?: AiTask } = {}): Promise<string> {
    const task = opts.task ?? 'briefs';
    const r = resolveRoute(task, config(), routes(), opts.model);
    checkCap(task, 'schedule', r.local);
    const thread = { id: 'complete', kind: 'task', title: null, status: 'running', parentId: null, meta: {}, createdAt: '', updatedAt: '' } as AgentThread;
    const ctx: ToolCtx = { threadId: thread.id, origin: 'schedule', app: { ...app, startJob }, emit: () => {} };
    const out = await provide({ system: opts.system ?? 'Answer exactly as asked.', prompt, history: [], tools: [], ctx, model: r.model, signal: new AbortController().signal, onDelta: () => {}, maxTurns: 2 }, r);
    recordSpend(r, out);
    return out.text;
  }
  async function runRoutine(job: RoutineJob): Promise<RoutineResult> {
    const thread = store.createThread({ kind: 'task', title: `Routine: ${job.name}`.slice(0, 90), meta: { origin: 'routine', routineId: job.routineId, trigger: job.origin } });
    const abort = new AbortController();
    running.set(thread.id, abort);
    const emit = emitter(thread.id);
    const steps: string[] = [];
    const ctx: ToolCtx = {
      threadId: thread.id,
      origin: job.origin,
      unattended: true,
      app: { ...app, startJob },
      emit: (type, data: any) => {
        if (type === 'tool_call' && steps.length < 30) steps.push(String(data?.label ?? data?.name ?? 'step').slice(0, 90));
        emit(type, data);
      },
    };
    const allowed = new Set<string>(ROUTINE_TOOLS);
    const tools = chatTools.filter((t) => allowed.has(t.name));
    const route = resolveRoute('routines', config(), routes());
    // A routine works in its own profile; the user's active profile comes back afterwards.
    const prevProfile = app.profiles?.active();
    const timer = setTimeout(() => abort.abort(), 10 * 60_000);
    emit('user', { text: job.prompt, context: null });
    setStatus(thread, 'running');
    try {
      checkCap('routines', job.origin, route.local);
      if (job.profile && app.profiles && app.profiles.active() !== job.profile) app.profiles.setActive(job.profile);
      const result = await provide({
        system: routineSystem(contextText({ profile: job.profile ?? 'all', screen: 'none (routine running unattended)' }), job),
        prompt: job.prompt,
        history: [],
        tools,
        ctx,
        model: route.model,
        signal: abort.signal,
        onDelta: () => {},
        maxTurns: 24,
        maxBudgetUsd: route.local ? undefined : job.maxBudgetUsd,
      }, route);
      recordSpend(route, result, thread.id, `Routine: ${job.name}`);
      emit('done', { costUsd: result.costUsd ?? null, turns: result.turns ?? null });
      setStatus(thread, 'done', { ...thread.meta, costUsd: result.costUsd ?? null });
      return { threadId: thread.id, ok: true, text: result.text, costUsd: result.costUsd ?? (route.local ? 0 : null), error: null, steps };
    } catch (e) {
      const cost = (e as { costUsd?: number }).costUsd;
      if (typeof cost === 'number') recordSpend(route, { text: '', costUsd: cost }, thread.id, `Routine: ${job.name}`);
      const msg = abort.signal.aborted ? 'Stopped after 10 minutes.' : (e as Error).message || 'The AI run failed';
      emit('error', { text: msg });
      setStatus(thread, 'error');
      return { threadId: thread.id, ok: false, text: '', costUsd: typeof cost === 'number' ? cost : null, error: msg, steps };
    } finally {
      clearTimeout(timer);
      running.delete(thread.id);
      try {
        if (prevProfile !== undefined && app.profiles && app.profiles.active() !== prevProfile) app.profiles.setActive(prevProfile);
      } catch {
        /* the profile was deleted meanwhile */
      }
    }
  }

  const completeFor = (task: AiTask) => (prompt: string, opts: { system?: string; model?: string } = {}) => complete(prompt, { ...opts, task });

  function routing() {
    const c = config();
    const rs = routes();
    // AI rules and alerts ask for the cheaper labelling model when Claude is the main provider.
    const label = c.provider === 'claude' ? store.getSetting<string>('ai.classifyModel') ?? 'claude-haiku-5-5' : undefined;
    return AI_TASKS.map((task) => ({ task, ...TASK_INFO[task], resolved: resolveRoute(task, c, rs, task === 'classifier' || task === 'alerts' ? label : undefined) }));
  }
  function spendView() {
    const sum = spend.summary();
    return { ...sum, caps: caps(), capStates: capStates(sum.monthByTask, caps()), tasks: AI_TASKS.map((t) => ({ task: t, label: TASK_INFO[t].label, background: TASK_INFO[t].background })) };
  }

  // ---------------------------------------------------------------- routes
  const { route, HttpError } = deps;
  route('GET', '/api/agent/status', () => ({ ...status(), config: { ...config() }, hasKey: !!store.getSecret('ai.apiKey') }));
  // Model servers on this computer. Fixed loopback ports only; in cloud mode there is nothing to find.
  route('GET', '/api/ai/local', async () => (process.env.SR_CLOUD === '1' ? { cloud: true, servers: [] } : { cloud: false, servers: await detectLocalModels() }));
  route('GET', '/api/ai/routes', () => ({ tasks: routing() }));
  route('PUT', '/api/ai/routes', (_q, _s, _p, body) => {
    const list: unknown[] = Array.isArray(body?.changes) ? body.changes.slice(0, AI_TASKS.length) : [body];
    const next = { ...routes() };
    for (const ch of list as any[]) {
      if (!isTask(ch?.task)) throw new HttpError(400, 'Unknown task');
      let r;
      try {
        r = parseRoute(ch.route);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      if (r) next[ch.task as AiTask] = r;
      else delete next[ch.task as AiTask];
    }
    store.setSetting('ai.routes', next);
    return { tasks: routing() };
  });
  route('GET', '/api/ai/spend', () => spendView());
  route('PUT', '/api/ai/caps', (_q, _s, _p, body) => {
    if (!isTask(body?.task)) throw new HttpError(400, 'Unknown task');
    let cap: number | null;
    try {
      cap = parseCap(body.usd);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const next = { ...caps() };
    if (cap === null) delete next[body.task as AiTask];
    else next[body.task as AiTask] = cap;
    store.setSetting('ai.caps', next);
    // A raised cap lets the app announce the next pause again.
    for (const k of [...pausedNoticed]) if (k.startsWith(`${body.task}|`)) pausedNoticed.delete(k);
    return spendView();
  });
  route('PUT', '/api/agent/config', (_q, _s, _p, body) => {
    const cur = config();
    const next: AiConfig = {
      provider: body?.provider === 'openai' ? 'openai' : body?.provider === 'claude' ? 'claude' : cur.provider,
      model: typeof body?.model === 'string' && body.model.trim() ? body.model.trim().slice(0, 120) : cur.model,
      builderModel: typeof body?.builderModel === 'string' && body.builderModel.trim() ? body.builderModel.trim().slice(0, 120) : cur.builderModel,
      baseUrl: typeof body?.baseUrl === 'string' ? body.baseUrl.trim().slice(0, 300) || null : cur.baseUrl,
    };
    if (next.baseUrl && !/^https?:\/\//.test(next.baseUrl)) throw new HttpError(400, 'The endpoint must be an http(s) URL');
    store.setSetting('ai.config', next);
    if (typeof body?.apiKey === 'string') store.setSecret('ai.apiKey', body.apiKey.trim() || null);
    return { ...status(), config: next, hasKey: !!store.getSecret('ai.apiKey') };
  });
  route('GET', '/api/agent/threads', (_q, _s, _p, _b, url) => store.listThreads(url.searchParams.get('kind') ?? undefined, 60));
  route('POST', '/api/agent/threads', (_q, _s, _p, body) => store.createThread({ kind: 'chat', title: body?.title ? String(body.title).slice(0, 80) : null }));
  route('GET', '/api/agent/threads/:id', (_q, _s, p, _b, url) => {
    const thread = store.getThread(p.id);
    if (!thread) throw new HttpError(404, 'No such conversation');
    const jobs = store.listThreads(undefined, 200).filter((t) => t.parentId === p.id);
    return { thread, events: store.listEvents(p.id, Number(url.searchParams.get('after') ?? 0)), jobs, running: running.has(p.id) };
  });
  route('POST', '/api/agent/threads/:id/messages', (_q, _s, p, body) => {
    const text = String(body?.text ?? '').trim().slice(0, 20000);
    if (!text) throw new HttpError(400, 'Say something');
    const st = status();
    if (!st.ready) throw new HttpError(409, st.reason ?? 'AI is not set up');
    send(p.id, text, body?.context ?? null, 'user');
    return { ok: true };
  });
  route('POST', '/api/agent/threads/:id/stop', (_q, _s, p) => {
    running.get(p.id)?.abort();
    queues.delete(p.id);
    return { ok: true };
  });
  route('POST', '/api/agent/changes/:id/undo', async (_q, _s, p) => ({ text: await undoChange({ ...app, startJob }, p.id) }));
  route('GET', '/api/agent/jobs', () => store.listThreads(undefined, 100).filter((t) => t.kind === 'build' || t.kind === 'repair'));
  route('POST', '/api/agent/jobs', (_q, _s, _p, body) => {
    const st = status();
    if (!st.ready) throw new HttpError(409, st.reason ?? 'AI is not set up');
    const kind = body?.kind === 'repair' ? 'repair' : 'build';
    const sourceId = body?.sourceId ? String(body.sourceId) : undefined;
    if (kind === 'repair' && (!sourceId || !store.getSource(sourceId))) throw new HttpError(400, 'Pick a source to repair');
    const request = String(body?.request ?? '').trim().slice(0, 4000) || (kind === 'repair' ? `Repair the source "${store.getSource(sourceId!)?.label}".` : '');
    if (!request) throw new HttpError(400, 'Say what to build');
    return startJob({ kind, request, parentId: body?.parentId ? String(body.parentId) : null, sourceId, origin: 'user' });
  });

  return { startJob, status, complete, completeFor, send, runRoutine };
}
