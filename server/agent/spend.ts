// What the AI costs: one row per model call, with the job it did, the model, tokens and the cost
// the provider reported. Kept in its own small file (data/spend.db) so the library stays untouched.

import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AI_TASKS, periodStarts, type AiTask } from './routing.ts';

export interface SpendEntry {
  task: AiTask;
  provider: string;
  model: string;
  /** Dollars, when the provider reported a cost. Local models are 0. */
  costUsd: number | null;
  inTokens?: number | null;
  outTokens?: number | null;
  local: boolean;
  /** A thread id, for builds and chats. */
  ref?: string | null;
  /** A short human label: the build request or chat title. */
  label?: string | null;
  at?: string;
}

export interface Totals {
  cost: number;
  calls: number;
  inTokens: number;
  outTokens: number;
  /** Calls whose cost the provider did not report (hosted OpenAI-compatible services). */
  unknown: number;
}

export interface SpendSummary {
  today: Totals;
  week: Totals;
  month: Totals;
  byTask: ({ task: AiTask } & Totals)[];
  byModel: ({ model: string; provider: string; local: boolean } & Totals)[];
  topBuilds: { ref: string | null; label: string; model: string; cost: number; at: string }[];
  /** The last 30 days, oldest first, dollars per local day. */
  daily: { day: string; cost: number }[];
  monthByTask: Partial<Record<AiTask, number>>;
}

const totals = (r: any): Totals => ({ cost: Number(r?.cost ?? 0), calls: Number(r?.calls ?? 0), inTokens: Number(r?.inTok ?? 0), outTokens: Number(r?.outTok ?? 0), unknown: Number(r?.unknown ?? 0) });
const SUMS = 'COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS calls, COALESCE(SUM(in_tok), 0) AS inTok, COALESCE(SUM(out_tok), 0) AS outTok, COALESCE(SUM(cost_known = 0), 0) AS unknown';

export function createSpend(path: string) {
  const db = new DatabaseSync(path);
  try {
    if (path !== ':memory:') chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS spend (
      id INTEGER PRIMARY KEY,
      at TEXT NOT NULL,
      task TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      cost REAL NOT NULL DEFAULT 0,
      cost_known INTEGER NOT NULL DEFAULT 1,
      in_tok INTEGER,
      out_tok INTEGER,
      local INTEGER NOT NULL DEFAULT 0,
      ref TEXT,
      label TEXT
    );
    CREATE INDEX IF NOT EXISTS spend_at ON spend(at);
  `);
  const ins = db.prepare('INSERT INTO spend(at, task, provider, model, cost, cost_known, in_tok, out_tok, local, ref, label) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const since = db.prepare(`SELECT ${SUMS} FROM spend WHERE at >= ?`);
  const byTask = db.prepare(`SELECT task, ${SUMS} FROM spend WHERE at >= ? GROUP BY task ORDER BY cost DESC, task`);
  const byModel = db.prepare(`SELECT model, provider, MAX(local) AS local, ${SUMS} FROM spend WHERE at >= ? GROUP BY model, provider ORDER BY cost DESC, calls DESC LIMIT 12`);
  const builds = db.prepare(`SELECT ref, MAX(label) AS label, MAX(model) AS model, SUM(cost) AS cost, MAX(at) AS at FROM spend WHERE task = 'builder' AND at >= ? GROUP BY COALESCE(ref, id) ORDER BY cost DESC LIMIT 5`);
  const rows = db.prepare('SELECT at, cost FROM spend WHERE at >= ?');

  function record(e: SpendEntry) {
    const cost = e.local ? 0 : e.costUsd;
    ins.run(
      e.at ?? new Date().toISOString(),
      e.task,
      e.provider.slice(0, 40),
      (e.model || '?').slice(0, 120),
      Number.isFinite(cost as number) ? (cost as number) : 0,
      e.local || Number.isFinite(cost as number) ? 1 : 0,
      Number.isFinite(e.inTokens as number) ? Math.round(e.inTokens as number) : null,
      Number.isFinite(e.outTokens as number) ? Math.round(e.outTokens as number) : null,
      e.local ? 1 : 0,
      e.ref ?? null,
      e.label ? e.label.replace(/\s+/g, ' ').slice(0, 160) : null,
    );
  }

  function monthByTask(now = new Date()): Partial<Record<AiTask, number>> {
    const out: Partial<Record<AiTask, number>> = {};
    for (const r of byTask.all(periodStarts(now).month) as any[]) if ((AI_TASKS as readonly string[]).includes(r.task)) out[r.task as AiTask] = Number(r.cost);
    return out;
  }

  function summary(now = new Date()): SpendSummary {
    const p = periodStarts(now);
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
    const daily = new Map<string, number>();
    for (let i = 0; i < 30; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      daily.set(dayKey(d), 0);
    }
    for (const r of rows.all(start.toISOString()) as any[]) {
      const k = dayKey(new Date(r.at));
      if (daily.has(k)) daily.set(k, daily.get(k)! + Number(r.cost));
    }
    const ninety = new Date(now.getTime() - 90 * 86400_000).toISOString();
    return {
      today: totals(since.get(p.today)),
      week: totals(since.get(p.week)),
      month: totals(since.get(p.month)),
      byTask: (byTask.all(p.month) as any[]).map((r) => ({ task: r.task as AiTask, ...totals(r) })),
      byModel: (byModel.all(p.month) as any[]).map((r) => ({ model: String(r.model), provider: String(r.provider), local: !!r.local, ...totals(r) })),
      topBuilds: (builds.all(ninety) as any[]).filter((r) => Number(r.cost) > 0).map((r) => ({ ref: r.ref ?? null, label: String(r.label ?? 'Connector build'), model: String(r.model), cost: Number(r.cost), at: String(r.at) })),
      daily: [...daily].map(([day, cost]) => ({ day, cost })),
      monthByTask: monthByTask(now),
    };
  }

  return { record, summary, monthByTask, close: () => db.close() };
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export type Spend = ReturnType<typeof createSpend>;

const open = new Map<string, Spend>();
/** One spend log per data folder, shared by the runtime and the agent's tools. */
export function spendFor(dataDir: string): Spend {
  let s = open.get(dataDir);
  if (!s) {
    s = createSpend(join(dataDir, 'spend.db'));
    open.set(dataDir, s);
  }
  return s;
}

export function money(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}
