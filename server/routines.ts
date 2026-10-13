// Routines on the server: stored as settings (so the agent's undo restores them like any other
// setting), checked once a minute and after each sync, and run one at a time through the agent
// with the routine tool allowlist (core/routines.ts). New routines start off: the user reads a
// dry-run plan and turns them on. Each run is limited in dollars, and each routine per month.

import { randomUUID } from 'node:crypto';
import {
  cleanSchedule, DEFAULT_MONTH_CAP, DEFAULT_RUN_CAP, describeSchedule, dueAction, MAX_ROUTINES, parseMoney, parseSchedule,
  ROUTINE_TOOLS, splitRoutine, SYNC_GAP_MS, upcoming, type Routine, type RoutineRun, type Schedule,
} from '../core/routines.ts';
import { periodStarts } from './agent/routing.ts';
import type { RoutineJob, RoutineResult } from './agent/runtime.ts';
import type { Store } from './db.ts';
import type { ServerEvent } from './events.ts';
import type { Profile } from '../core/types.ts';

export const ROUTINES_KEY = 'routines';
const RUNS_KEY = 'routines.runs';
const MAX_RUNS = 200;

export const listRoutines = (store: Store): Routine[] => store.getSetting<Routine[]>(ROUTINES_KEY) ?? [];
const saveRoutines = (store: Store, list: Routine[]) => store.setSetting(ROUTINES_KEY, list.slice(0, MAX_ROUTINES));
export const listRuns = (store: Store): RoutineRun[] => store.getSetting<RoutineRun[]>(RUNS_KEY) ?? [];

const clip = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, max);

export interface RoutineInput {
  text?: string;
  name?: string;
  prompt?: string;
  schedule?: Schedule | string | null;
  profile?: string | null;
  runCapUsd?: number;
  monthCapUsd?: number;
}

function scheduleOf(v: unknown): Schedule | null {
  if (typeof v === 'string') return parseSchedule(v);
  return cleanSchedule(v);
}

/** Makes a routine, always turned off. Throws with a message for the user on bad input. */
export function createRoutineIn(store: Store, input: RoutineInput, profiles: Profile[]): Routine {
  const list = listRoutines(store);
  if (list.length >= MAX_ROUTINES) throw new Error(`You have ${MAX_ROUTINES} routines, the most Aurora keeps. Delete one first.`);
  const split = splitRoutine(clip(input.text ?? input.prompt, 1500));
  const prompt = clip(input.prompt, 1500) || split.prompt;
  if (prompt.length < 4) throw new Error('Say what the routine should do.');
  const schedule = scheduleOf(input.schedule) ?? split.schedule;
  if (!schedule) throw new Error('Say when it should run, like "every weekday at 7:30", "Sunday night" or "every 2 hours".');
  const now = new Date().toISOString();
  const r: Routine = {
    id: randomUUID(),
    name: clip(input.name, 60) || split.name,
    prompt,
    schedule,
    profile: resolveProfile(input.profile, profiles),
    enabled: false,
    paused: null,
    runCapUsd: parseMoney(input.runCapUsd, DEFAULT_RUN_CAP, 20),
    monthCapUsd: parseMoney(input.monthCapUsd, DEFAULT_MONTH_CAP, 200),
    plan: null,
    planFor: null,
    plannedAt: null,
    lastSlotAt: null,
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
  };
  saveRoutines(store, [r, ...list]);
  return r;
}

function resolveProfile(v: unknown, profiles: Profile[]): string | null {
  if (v === null || v === undefined || v === '' || v === 'all') return null;
  const k = String(v).toLowerCase();
  const p = profiles.find((x) => x.id === v) ?? profiles.find((x) => x.name.toLowerCase() === k);
  if (!p) throw new Error(`No profile called “${String(v).slice(0, 40)}”.`);
  return p.id;
}

export interface RoutinePatch extends RoutineInput {
  enabled?: boolean;
}

/**
 * Changes a routine. Turning one on needs a plan made for its current task (the user saw what it
 * will do); `allowEnable` is false for the agent, so only a person can turn a routine on.
 */
export function updateRoutineIn(store: Store, id: string, patch: RoutinePatch, profiles: Profile[], allowEnable: boolean): Routine {
  const list = listRoutines(store);
  const i = list.findIndex((r) => r.id === id);
  if (i < 0) throw new Error('No such routine');
  const r = { ...list[i] };
  if (patch.name !== undefined) r.name = clip(patch.name, 60) || r.name;
  if (patch.prompt !== undefined) {
    const p = clip(patch.prompt, 1500);
    if (p.length < 4) throw new Error('Say what the routine should do.');
    r.prompt = p;
  }
  if (patch.schedule !== undefined) {
    const s = scheduleOf(patch.schedule);
    if (!s) throw new Error('That schedule did not make sense. Try "every weekday at 7:30", "Sunday night" or "every 2 hours".');
    r.schedule = s;
    r.lastSlotAt = null;
  }
  if (patch.profile !== undefined) r.profile = resolveProfile(patch.profile, profiles);
  if (patch.runCapUsd !== undefined) r.runCapUsd = parseMoney(patch.runCapUsd, r.runCapUsd, 20);
  if (patch.monthCapUsd !== undefined) {
    r.monthCapUsd = parseMoney(patch.monthCapUsd, r.monthCapUsd, 200);
    r.paused = null;
  }
  // A changed task or profile needs a fresh look at the plan before it runs on its own again.
  if (r.prompt !== list[i].prompt || r.profile !== list[i].profile) {
    r.plan = null;
    r.planFor = null;
    r.plannedAt = null;
    r.enabled = false;
  }
  if (patch.enabled === false) r.enabled = false;
  if (patch.enabled === true && !r.enabled) {
    if (!allowEnable) throw new Error('Only the user can turn a routine on, from the Routines sheet.');
    if (!r.plan || r.planFor !== r.prompt) throw new Error('Preview the plan for the first run before turning this routine on.');
    r.enabled = true;
    r.paused = null;
    r.lastSlotAt = new Date().toISOString();
  }
  r.updatedAt = new Date().toISOString();
  list[i] = r;
  saveRoutines(store, list);
  return r;
}

export function deleteRoutineIn(store: Store, id: string): Routine {
  const list = listRoutines(store);
  const r = list.find((x) => x.id === id);
  if (!r) throw new Error('No such routine');
  saveRoutines(store, list.filter((x) => x.id !== id));
  store.setSetting(RUNS_KEY, listRuns(store).filter((x) => x.routineId !== id));
  return r;
}

export function findRoutine(store: Store, key: string | undefined): Routine | null {
  if (!key) return null;
  const k = key.toLowerCase();
  const list = listRoutines(store);
  return list.find((r) => r.id === key) ?? list.find((r) => r.name.toLowerCase() === k) ?? list.find((r) => r.name.toLowerCase().includes(k)) ?? null;
}

/** Dollars a routine has spent this calendar month, from its run history. */
export function monthSpent(runs: RoutineRun[], routineId: string, now = new Date()): number {
  const start = periodStarts(now).month;
  return runs.filter((x) => x.routineId === routineId && x.startedAt >= start).reduce((s, x) => s + (x.costUsd ?? 0), 0);
}

const PLAN_SYSTEM = `You plan one run of a routine in Aurora, a private local social feed app. You do not run it.
Write what the AI will do on its first run, as 3 to 6 short numbered steps in plain English, then one line starting "You will see:" saying what the user gets (a page, posts added to Read later, a summary). Use only the tools listed. If the task needs something the tools cannot do (adding sources, posting, liking, anything on another site), say so plainly in a step. No headings, no emoji, at most 110 words.`;

interface Deps {
  store: Store;
  profiles: () => Profile[];
  runRoutine: (job: RoutineJob) => Promise<RoutineResult>;
  /** A cheap one-shot completion on the routines route, for plans. */
  complete: (prompt: string, opts?: { system?: string; model?: string }) => Promise<string>;
  ready: () => { ready: boolean; provider: string; reason?: string };
  broadcast: (e: ServerEvent) => void;
  log?: (msg: string) => void;
}

export function createRoutines(deps: Deps) {
  const { store } = deps;
  const queue: { id: string; origin: 'user' | 'schedule' }[] = [];
  let busy: string | null = null;
  let syncTimer: NodeJS.Timeout | null = null;

  const changed = () => deps.broadcast({ type: 'ui', action: { kind: 'routines-changed' } });

  function patchRoutine(id: string, p: Partial<Routine>) {
    const list = listRoutines(store);
    const i = list.findIndex((r) => r.id === id);
    if (i < 0) return;
    list[i] = { ...list[i], ...p };
    saveRoutines(store, list);
  }

  function writeRun(run: RoutineRun) {
    const runs = listRuns(store).filter((x) => x.id !== run.id);
    store.setSetting(RUNS_KEY, [run, ...runs].slice(0, MAX_RUNS));
  }

  function enqueue(id: string, origin: 'user' | 'schedule') {
    if (busy === id || queue.some((q) => q.id === id)) return false;
    queue.push({ id, origin });
    void pump();
    return true;
  }

  async function pump() {
    if (busy) return;
    const next = queue.shift();
    if (!next) return;
    busy = next.id;
    try {
      await runOne(next.id, next.origin);
    } catch (e) {
      deps.log?.(`routines: ${(e as Error).message}`);
    } finally {
      busy = null;
      void pump();
    }
  }

  async function runOne(id: string, origin: 'user' | 'schedule') {
    const r = listRoutines(store).find((x) => x.id === id);
    if (!r) return;
    const started = new Date();
    const run: RoutineRun = { id: randomUUID(), routineId: r.id, origin, status: 'running', startedAt: started.toISOString(), finishedAt: null, costUsd: null, summary: '', error: null, threadId: null, steps: [] };
    const finish = (p: Partial<RoutineRun>) => {
      writeRun({ ...run, ...p, finishedAt: new Date().toISOString() });
      patchRoutine(r.id, { lastRunAt: run.startedAt });
      changed();
    };
    const st = deps.ready();
    if (!st.ready) return finish({ status: 'skipped', error: st.reason ?? 'The AI is not set up.' });
    const spent = monthSpent(listRuns(store), r.id, started);
    if (spent >= r.monthCapUsd && r.monthCapUsd > 0) {
      const why = `This routine's monthly limit of $${r.monthCapUsd.toFixed(2)} is reached.`;
      if (origin === 'schedule') {
        patchRoutine(r.id, { paused: why });
        deps.broadcast({ type: 'ui', action: { kind: 'ai-paused', task: 'routines', label: `Routine “${r.name}”`, spent, cap: r.monthCapUsd } });
      }
      return finish({ status: 'skipped', error: why });
    }
    writeRun(run);
    changed();
    const out = await deps.runRoutine({
      routineId: r.id,
      name: r.name,
      prompt: r.prompt,
      schedule: describeSchedule(r.schedule),
      profile: r.profile && deps.profiles().some((p) => p.id === r.profile) ? r.profile : null,
      origin,
      maxBudgetUsd: Math.max(0.05, Math.min(r.runCapUsd, r.monthCapUsd > 0 ? r.monthCapUsd - spent : r.runCapUsd)),
    });
    finish({
      status: out.ok ? 'ok' : 'error',
      costUsd: out.costUsd,
      summary: clip(out.text, 2000),
      error: out.error ? clip(out.error, 300) : null,
      threadId: out.threadId,
      steps: out.steps,
    });
  }

  /** Once a minute: queue every routine whose slot has come. */
  function tick(now = new Date()) {
    for (const r of listRoutines(store)) {
      if (!r.enabled || r.paused || r.schedule.kind === 'sync') continue;
      const since = new Date(r.lastSlotAt ?? r.updatedAt);
      const act = dueAction(r.schedule, since, now);
      if (act === 'wait') continue;
      patchRoutine(r.id, { lastSlotAt: now.toISOString() });
      if (act === 'run') enqueue(r.id, 'schedule');
      else deps.log?.(`routines: skipped a missed run of “${r.name}” (the computer was off)`);
    }
  }

  /** After a sync: routines that wait for new posts, at most once per half hour each. */
  function afterSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      const now = Date.now();
      for (const r of listRoutines(store)) {
        if (!r.enabled || r.paused || r.schedule.kind !== 'sync') continue;
        if (r.lastSlotAt && now - Date.parse(r.lastSlotAt) < SYNC_GAP_MS) continue;
        patchRoutine(r.id, { lastSlotAt: new Date(now).toISOString() });
        enqueue(r.id, 'schedule');
      }
    }, 20_000);
    syncTimer.unref?.();
  }

  /** The dry run: what the first run will do, from a cheap model. Stored on the routine. */
  async function plan(id: string): Promise<Routine> {
    const r = listRoutines(store).find((x) => x.id === id);
    if (!r) throw new Error('No such routine');
    const st = deps.ready();
    if (!st.ready) throw new Error(st.reason ?? 'The AI is not set up, so routines cannot run yet.');
    const profile = r.profile ? deps.profiles().find((p) => p.id === r.profile) : null;
    const prompt = [
      `Routine name: ${r.name}`,
      `When: ${describeSchedule(r.schedule)}`,
      `Works in: ${profile ? `the ${profile.name} profile` : 'All (every source)'}`,
      `Tools the run may use: ${ROUTINE_TOOLS.join(', ')}. Pages it makes are updated in place each run.`,
      `Sources in the library: ${store.listSources().length}. Existing pages: ${store.listPages().map((p) => p.name).slice(0, 20).join(', ') || 'none'}.`,
      '',
      `The task, in the user's words:\n${r.prompt}`,
      '',
      'Write the plan.',
    ].join('\n');
    const model = st.provider === 'claude' ? store.getSetting<string>('ai.classifyModel') ?? 'claude-haiku-5-5' : undefined;
    const text = clip((await deps.complete(prompt, { system: PLAN_SYSTEM, model })).replace(/[#*`]/g, ''), 1200);
    if (!text) throw new Error('The AI gave no plan. Try again.');
    const latest = listRoutines(store).find((x) => x.id === id);
    if (!latest) throw new Error('No such routine');
    const at = new Date().toISOString();
    patchRoutine(id, { plan: text, planFor: latest.prompt, plannedAt: at });
    changed();
    return { ...latest, plan: text, planFor: latest.prompt, plannedAt: at };
  }

  function view(r: Routine, runs: RoutineRun[]) {
    const mine = runs.filter((x) => x.routineId === r.id);
    return {
      ...r,
      when: describeSchedule(r.schedule),
      nextRunAt: upcoming(r),
      running: busy === r.id,
      queued: queue.some((q) => q.id === r.id),
      monthSpent: monthSpent(runs, r.id),
      lastRun: mine[0] ?? null,
      runs: mine.slice(0, 8),
    };
  }

  function summary() {
    const runs = listRuns(store);
    const st = deps.ready();
    return { routines: listRoutines(store).map((r) => view(r, runs)), aiReady: st.ready, aiReason: st.ready ? null : st.reason ?? null };
  }

  type Route = (method: string, path: string, handler: (req: any, res: any, params: Record<string, string>, body: any) => unknown) => void;
  function register(route: Route, HttpError: new (status: number, msg: string) => Error) {
    const guard = async <T>(fn: () => T | Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    };
    route('GET', '/api/routines', () => summary());
    route('POST', '/api/routines', (_q, _s, _p, body) =>
      guard(() => {
        const r = createRoutineIn(store, body ?? {}, deps.profiles());
        changed();
        return view(r, []);
      }));
    route('PATCH', '/api/routines/:id', (_q, _s, p, body) =>
      guard(() => {
        const r = updateRoutineIn(store, p.id, body ?? {}, deps.profiles(), true);
        changed();
        return view(r, listRuns(store));
      }));
    route('DELETE', '/api/routines/:id', (_q, _s, p) => guard(() => (deleteRoutineIn(store, p.id), changed(), { ok: true })));
    route('POST', '/api/routines/:id/plan', (_q, _s, p) => guard(async () => view(await plan(p.id), listRuns(store))));
    route('POST', '/api/routines/:id/run', (_q, _s, p) =>
      guard(() => {
        if (!listRoutines(store).some((r) => r.id === p.id)) throw new Error('No such routine');
        const st = deps.ready();
        if (!st.ready) throw new Error(st.reason ?? 'The AI is not set up.');
        const queued = enqueue(p.id, 'user');
        changed();
        return { queued };
      }));
  }

  return { tick, afterSync, register, plan, summary, enqueue };
}
