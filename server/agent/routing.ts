// Which model does which job, and when background AI work pauses for a spending cap.
// Pure functions only, so the rules can be tested without a server.

import type { AiConfig } from './types.ts';

export const AI_TASKS = ['chat', 'builder', 'classifier', 'alerts', 'week', 'summaries', 'briefs', 'routines'] as const;
export type AiTask = (typeof AI_TASKS)[number];

export interface TaskInfo {
  label: string;
  /** What the job is, in a few words. */
  what: string;
  /** Background work pauses when its monthly cap is reached. Chats and clicks never do. */
  background: 'always' | 'automatic-only' | 'never';
  /** How well a small local model (7 to 14B) does this job. */
  local: 'good' | 'fair' | 'weak';
  note: string;
}

export const TASK_INFO: Record<AiTask, TaskInfo> = {
  chat: { label: 'Chat', what: 'Answers you and changes the app', background: 'never', local: 'fair', note: 'Needs reliable tool calling. A 30B-class local model works; small ones lose track.' },
  builder: { label: 'Connector builds', what: 'Writes, tests and repairs connectors', background: 'automatic-only', local: 'weak', note: 'Hard coding work. Use a strong model; small local models rarely finish a build.' },
  classifier: { label: 'AI rules', what: 'Labels each new post for your plain-English rules', background: 'always', local: 'good', note: 'Short yes or no judgements. Small local models handle this well.' },
  alerts: { label: 'Alerts', what: 'Decides if a new post matches an alert', background: 'always', local: 'good', note: 'Short judgements over a few posts. Small local models handle this well.' },
  week: { label: 'Your week', what: 'Writes the weekly paragraph', background: 'always', local: 'fair', note: 'A short piece of writing. Local models are fine; larger ones read better.' },
  summaries: { label: 'Article summaries', what: 'Summarises and explains articles when you ask', background: 'never', local: 'good', note: 'Local models summarise well; long articles need a long context window.' },
  routines: { label: 'Routines', what: 'Runs the jobs you scheduled in plain English', background: 'automatic-only', local: 'fair', note: 'Needs reliable tool calling. A 30B-class local model works; small ones lose track.' },
  briefs: { label: 'Briefs and suggestions', what: 'Morning edition, catch-up card, person lines, taste suggestions', background: 'always', local: 'good', note: 'Short summaries. Small local models handle this well.' },
};

export interface TaskRoute {
  provider: 'claude' | 'openai';
  model: string;
  /** For OpenAI-compatible servers. */
  baseUrl?: string | null;
}
export type Routes = Partial<Record<AiTask, TaskRoute>>;

export interface Resolved {
  task: AiTask;
  provider: 'claude' | 'openai';
  model: string;
  baseUrl: string | null;
  /**
   * Which key may go with the call. 'main' is the key saved in AI settings; 'env' means only the
   * environment or the Claude Code login; 'none' sends no key. A key saved for one service is
   * never sent to a different one.
   */
  key: 'main' | 'env' | 'none';
  routed: boolean;
  /** An OpenAI-compatible server on this computer: free, and nothing leaves the machine. */
  local: boolean;
}

export function isTask(x: unknown): x is AiTask {
  return typeof x === 'string' && (AI_TASKS as readonly string[]).includes(x);
}

export function isLoopbackUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
  } catch {
    return false;
  }
}

const sameBase = (a?: string | null, b?: string | null) => !!a && !!b && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/**
 * The model a job runs on. A per-task route wins; otherwise the main settings decide, with the
 * caller's own preference (for example a cheaper model for labelling) kept when the main provider
 * is the one it was meant for.
 */
export function resolveRoute(task: AiTask, main: AiConfig, routes: Routes | null | undefined, callerModel?: string): Resolved {
  const r = routes?.[task];
  if (r && r.model) {
    if (r.provider === 'openai') {
      const baseUrl = r.baseUrl ?? null;
      const key = main.provider === 'openai' && sameBase(baseUrl, main.baseUrl) ? 'main' : 'none';
      return { task, provider: 'openai', model: r.model, baseUrl, key, routed: true, local: isLoopbackUrl(baseUrl) };
    }
    return { task, provider: 'claude', model: r.model, baseUrl: null, key: main.provider === 'claude' ? 'main' : 'env', routed: true, local: false };
  }
  const model = task === 'chat' ? main.model : task === 'builder' ? main.builderModel || main.model : callerModel || main.model;
  const baseUrl = main.provider === 'openai' ? main.baseUrl ?? null : null;
  return { task, provider: main.provider, model, baseUrl, key: 'main', routed: false, local: main.provider === 'openai' && isLoopbackUrl(baseUrl) };
}

/** Validates one route from a request body. Returns null to clear the route. Throws on bad input. */
export function parseRoute(body: unknown): TaskRoute | null {
  if (body === null || body === undefined) return null;
  if (typeof body !== 'object') throw new Error('Bad route');
  const b = body as Record<string, unknown>;
  const model = typeof b.model === 'string' ? b.model.trim().slice(0, 120) : '';
  if (!model) return null;
  if (b.provider === 'claude') {
    if (!/^claude[\w.-]*$/.test(model)) throw new Error('Claude model names start with "claude"');
    return { provider: 'claude', model };
  }
  if (b.provider !== 'openai') throw new Error('Pick claude or openai');
  const baseUrl = typeof b.baseUrl === 'string' ? b.baseUrl.trim().slice(0, 300) : '';
  if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) throw new Error('The endpoint must be an http(s) URL');
  return { provider: 'openai', model, baseUrl };
}

// ------------------------------------------------------------------ caps

export type Caps = Partial<Record<AiTask, number>>;

/** Whether a call of this task, started this way, is background work a cap may pause. */
export function pausable(task: AiTask, origin: 'user' | 'repair' | 'schedule'): boolean {
  const b = TASK_INFO[task].background;
  if (b === 'never') return false;
  if (b === 'automatic-only') return origin !== 'user';
  return true;
}

export interface CapState {
  task: AiTask;
  spent: number;
  cap: number;
  /** Paid calls for this job are stopped until next month (or until the cap changes). */
  reached: boolean;
  /** A $0 cap: the job may only use free local models. Not shown as "paused". */
  localOnly: boolean;
}

export function capStates(spentThisMonth: Partial<Record<AiTask, number>>, caps: Caps | null | undefined): CapState[] {
  const out: CapState[] = [];
  for (const task of AI_TASKS) {
    const cap = caps?.[task];
    if (typeof cap !== 'number' || !(cap >= 0)) continue;
    const spent = spentThisMonth[task] ?? 0;
    out.push({ task, spent, cap, reached: spent >= cap, localOnly: cap === 0 });
  }
  return out;
}

/**
 * Null when the call may go ahead; otherwise the cap that stops it. Calls to a model on this
 * computer cost nothing, so a cap never stops them; a $0 cap therefore means "local models only".
 */
export function capBlock(task: AiTask, origin: 'user' | 'repair' | 'schedule', spentThisMonth: Partial<Record<AiTask, number>>, caps: Caps | null | undefined, local = false): CapState | null {
  if (local || !pausable(task, origin)) return null;
  return capStates(spentThisMonth, caps).find((c) => c.task === task && c.reached) ?? null;
}

export function parseCap(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error('A cap is a dollar amount from 0 to 100000');
  return Math.round(n * 100) / 100;
}

// ------------------------------------------------------------------ periods

/** Local midnight today, the most recent Monday, and the first of the month, as ISO strings. */
export function periodStarts(now = new Date()): { today: string; week: string; month: string } {
  const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const w = new Date(d0);
  w.setDate(w.getDate() - ((w.getDay() + 6) % 7));
  const m = new Date(now.getFullYear(), now.getMonth(), 1);
  return { today: d0.toISOString(), week: w.toISOString(), month: m.toISOString() };
}
