// Source report cards: which sources earn their place, worked out locally from reading state.
// No AI and no network: one pass over the posts of the last N days, plus the plain-English rules
// already in the library. The verdict is a nudge with its numbers, never an automatic action.

import { DEFAULT_SPEC, evaluate, normalizeSpec, parseQuery, type FilterContext } from './filter.ts';
import type { Item, Source } from './types.ts';

export type Verdict = 'keep' | 'quieter' | 'let-go' | 'new';

export interface SourceReport {
  sourceId: string;
  label: string;
  /** Posts published in the window. */
  posts: number;
  perDay: number;
  read: number;
  saved: number;
  highlighted: number;
  /** Posts you hid yourself (archived). */
  hidden: number;
  /** Posts your rules kept out of the feed: noise, muted words, plain-English AI rules. */
  rulesHid: number;
  laterDone: number;
  laterOpen: number;
  alertHits: number;
  /** Posts you did something with: saved, highlighted, finished in Read later, or an alert hit. */
  kept: number;
  /** Daily counts, oldest first, one per day of the window. */
  daily: { posts: number[]; read: number[] };
  verdict: Verdict;
  reason: string;
}

export interface ReportInput {
  items: Item[];
  sources: Source[];
  ctx: FilterContext;
  /** Item ids with at least one highlight. */
  highlighted?: ReadonlySet<string>;
  /** Item ids that triggered an alert. */
  alertHits?: ReadonlySet<string>;
  now?: Date;
  days?: number;
}

const DAY = 86_400_000;
const READ_LATER = 'Read later';
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

/** Local midnight `days - 1` days before `now`: the first day of the window. */
function windowStart(now: Date, days: number): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - (days - 1));
  return d.getTime();
}

export function sourceReports(input: ReportInput): SourceReport[] {
  const now = input.now ?? new Date();
  const days = input.days ?? 30;
  const start = windowStart(now, days);
  // Days are counted on the local calendar, so a DST change never moves a post to the wrong day.
  const dayIndex = (t: number) => {
    const d = new Date(t);
    const mid = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return Math.round((mid - start) / DAY);
  };
  // The rules alone: noise, muted words and AI rules, with nothing about reading state.
  const rules = normalizeSpec({ ...DEFAULT_SPEC, hideNoise: true, archived: 'any', hideDuplicates: false });
  const parsed = parseQuery('');
  const noGroups = { duplicateOf: new Map<string, string>(), copies: new Map<string, string[]>() };

  const by = new Map<string, SourceReport>();
  for (const s of input.sources) {
    by.set(s.id, {
      sourceId: s.id, label: s.label, posts: 0, perDay: 0, read: 0, saved: 0, highlighted: 0, hidden: 0, rulesHid: 0,
      laterDone: 0, laterOpen: 0, alertHits: 0, kept: 0,
      daily: { posts: new Array(days).fill(0), read: new Array(days).fill(0) },
      verdict: 'keep', reason: '',
    });
  }

  for (const it of input.items) {
    const rep = by.get(it.sourceId);
    if (!rep) continue;
    const t = Date.parse(it.publishedAt);
    if (!Number.isFinite(t) || t < start || t > now.getTime() + DAY) continue;
    const di = Math.min(days - 1, Math.max(0, dayIndex(t)));
    rep.posts++;
    rep.daily.posts[di]++;
    const st = it.state;
    if (st.read) { rep.read++; rep.daily.read[di]++; }
    if (st.saved) rep.saved++;
    if (st.archived) rep.hidden++;
    const hl = !!input.highlighted?.has(it.id);
    if (hl) rep.highlighted++;
    const later = st.collections.includes(READ_LATER);
    if (later && st.read) rep.laterDone++;
    else if (later) rep.laterOpen++;
    const hit = !!input.alertHits?.has(it.id);
    if (hit) rep.alertHits++;
    if (st.saved || hl || (later && st.read) || hit) rep.kept++;
    if (!evaluate(it, rules, input.ctx, noGroups, parsed).visible) rep.rulesHid++;
  }

  const created = new Map(input.sources.map((s) => [s.id, Date.parse(s.createdAt)]));
  const out = [...by.values()];
  for (const r of out) {
    const age = (now.getTime() - (created.get(r.sourceId) ?? 0)) / DAY;
    r.perDay = Math.round((r.posts / Math.min(days, Math.max(1, Math.ceil(age)))) * 10) / 10;
    Object.assign(r, judge(r, age, days));
  }
  // Most worth a look first: let go, quieter, then keep and new, busiest first inside each.
  const rank: Record<Verdict, number> = { 'let-go': 0, quieter: 1, keep: 2, new: 3 };
  return out.sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.posts - a.posts);
}

/** The verdict and its one-line reason, in plain words with the numbers behind it. */
export function judge(r: Pick<SourceReport, 'posts' | 'read' | 'kept' | 'saved' | 'rulesHid' | 'hidden'>, ageDays: number, days = 30): { verdict: Verdict; reason: string } {
  const span = days === 30 ? 'in 30 days' : `in ${days} days`;
  const keptLine = r.kept === 0 ? `You kept none of its ${r.posts} posts ${span}` : `You kept ${r.kept} of ${r.posts} posts ${span}`;
  const ruled = pct(r.rulesHid, r.posts);
  const read = pct(r.read, r.posts);
  if (ageDays < 7) {
    const d = Math.max(0, Math.floor(ageDays));
    return { verdict: 'new', reason: `Added ${d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`}, too new to judge.` };
  }
  if (r.posts === 0) return { verdict: 'keep', reason: `Nothing new ${span}. A quiet source costs you nothing.` };
  if (r.posts < 10 && r.kept === 0) return { verdict: 'keep', reason: `Only ${r.posts} post${r.posts === 1 ? '' : 's'} ${span}, too few to cost you much.` };
  const keptRate = r.kept / r.posts;
  if (r.posts >= 30 && r.kept === 0 && (read < 10 || ruled >= 70)) {
    return { verdict: 'let-go', reason: `${keptLine}${ruled >= 50 ? `; your rules hid ${ruled}%` : `, and read ${read}%`}.` };
  }
  if (r.kept > 0 && (keptRate >= 0.02 || r.posts <= 30)) {
    return { verdict: 'keep', reason: `${keptLine}${ruled >= 40 ? `; your rules hid ${ruled}%` : ''}.` };
  }
  if (r.posts >= 60 && keptRate < 0.01) {
    return { verdict: 'quieter', reason: `${keptLine} (${r.posts >= 300 ? `${Math.round(r.posts / days)} a day` : 'a lot'} for so little)${ruled >= 40 ? `; your rules hid ${ruled}%` : ''}. A topic or a mute in this profile may help.` };
  }
  if (ruled >= 50) return { verdict: 'quieter', reason: `Your rules hid ${ruled}% of its ${r.posts} posts ${span}${r.kept ? `; you kept ${r.kept}` : ''}.` };
  if (read >= 50) return { verdict: 'keep', reason: `You read ${read}% of its ${r.posts} posts ${span}.` };
  return { verdict: r.kept ? 'keep' : 'quieter', reason: `${keptLine}, and read ${read}%.` };
}
