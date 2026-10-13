// The filtering engine. Pure and synchronous: given items and a FilterSpec it
// returns what is visible, what is hidden, and why, for every item.

import { classifyNoise, itemHaystack, matchTopics, termMatches, type NoiseVerdict, type TopicMatch } from './classify.ts';
import { contentTypesOf, normalizeForMatch } from './normalize.ts';
import type { AiRule, FilterSpec, Item, Topic } from './types.ts';

export const DEFAULT_SPEC: FilterSpec = {
  query: '',
  include: [],
  includeMode: 'any',
  exclude: [],
  sources: [],
  excludeSources: [],
  authors: [],
  excludeAuthors: [],
  platforms: [],
  contentTypes: [],
  kinds: [],
  langs: [],
  topics: [],
  dateFrom: null,
  dateTo: null,
  read: 'any',
  saved: 'any',
  archived: 'hide',
  collection: null,
  hideNoise: false,
  hideDuplicates: true,
  showDemo: true,
  aiRules: true,
  sort: 'newest',
};

export function normalizeSpec(partial: Partial<FilterSpec> | null | undefined): FilterSpec {
  return { ...DEFAULT_SPEC, ...(partial ?? {}) };
}

/** A clause that hid an item. `key` identifies the filter control so the UI can offer to clear it. */
export interface HideReason {
  key: keyof FilterSpec | 'duplicate';
  label: string;
}

/** A positive explanation of why an item is shown (matched terms, topics). */
export interface MatchReason {
  kind: 'query' | 'include' | 'topic' | 'author' | 'source' | 'ai';
  label: string;
}

export interface Evaluation {
  item: Item;
  visible: boolean;
  hidden: HideReason[];
  matched: MatchReason[];
  noise: NoiseVerdict;
  topics: TopicMatch[];
  duplicateOf: string | null;
  duplicates: string[]; // ids of other copies when this item is the primary
  score: number;
}

export interface ParsedQuery {
  terms: string[];
  phrases: string[];
  negated: string[];
  from: string[];
  site: string[];
}

/** Search syntax: words (all must match), "exact phrases", -excluded, from:handle, site:host. */
export function parseQuery(q: string): ParsedQuery {
  const out: ParsedQuery = { terms: [], phrases: [], negated: [], from: [], site: [] };
  const re = /(-?)"([^"]+)"|(\S+)/g;
  for (const m of q.matchAll(re)) {
    if (m[2] !== undefined) {
      (m[1] ? out.negated : out.phrases).push(normalizeForMatch(m[2]));
      continue;
    }
    const tok = m[3];
    if (/^from:/i.test(tok) && tok.length > 5) out.from.push(normalizeForMatch(tok.slice(5).replace(/^@/, '')));
    else if (/^site:/i.test(tok) && tok.length > 5) out.site.push(normalizeForMatch(tok.slice(5)));
    else if (tok.startsWith('-') && tok.length > 1) out.negated.push(normalizeForMatch(tok.slice(1)));
    else out.terms.push(normalizeForMatch(tok));
  }
  return out;
}

export interface DedupeGroups {
  /** item id -> primary item id, for every non-primary copy */
  duplicateOf: Map<string, string>;
  /** primary item id -> other copies */
  copies: Map<string, string[]>;
}

/** Group items sharing a dedupe key. The primary is the richest copy (longest text, then earliest). */
export function groupDuplicates(items: Item[]): DedupeGroups {
  const byKey = new Map<string, Item[]>();
  for (const it of items) {
    const arr = byKey.get(it.dedupeKey);
    if (arr) arr.push(it);
    else byKey.set(it.dedupeKey, [it]);
  }
  const duplicateOf = new Map<string, string>();
  const copies = new Map<string, string[]>();
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(
      (a, b) =>
        Number(b.state.saved) - Number(a.state.saved) ||
        b.text.length + b.media.length * 50 - (a.text.length + a.media.length * 50) ||
        byIso(a.publishedAt, b.publishedAt),
    );
    const primary = sorted[0];
    copies.set(primary.id, sorted.slice(1).map((x) => x.id));
    for (const other of sorted.slice(1)) duplicateOf.set(other.id, primary.id);
  }
  return { duplicateOf, copies };
}

/** ISO timestamps sort as plain strings; localeCompare is many times slower at 100k posts. */
const byIso = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Calendar day in local time, matching the date inputs and "last N days" in the UI. */
function dayOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface FilterContext {
  topics: Topic[];
  sourceLabels?: Record<string, string>;
  now?: Date;
  /** Items read during the current visit stay in an unread list until the filters change. */
  keepRead?: ReadonlySet<string>;
  /** Plain-English rules and the labels the AI has given posts so far. */
  ai?: { rules?: AiRule[]; labels?: Record<string, Record<string, { match: boolean; reason: string | null }>> };
}

// Per-item work that does not depend on the filters is cached. Items are immutable in the UI
// (a state change makes a new object), so a WeakMap keyed by the item is always fresh.
interface Prepared {
  hay: string;
  noise: NoiseVerdict;
  topicsFor: Topic[] | null;
  topics: TopicMatch[];
  handle: string;
  authorName: string;
  authorKey: string;
  day: string;
  publishedMs: number;
}
const prep = new WeakMap<Item, Prepared>();
function prepared(item: Item, topicList: Topic[]) {
  let p = prep.get(item);
  if (!p) {
    p = {
      hay: itemHaystack(item),
      noise: classifyNoise(item),
      topicsFor: null,
      topics: [],
      handle: normalizeForMatch(item.author.handle ?? ''),
      authorName: normalizeForMatch(item.author.name),
      authorKey: (item.author.handle ?? item.author.name).toLowerCase(),
      day: dayOf(item.publishedAt),
      publishedMs: Date.parse(item.publishedAt),
    };
    prep.set(item, p);
  }
  if (p.topicsFor !== topicList) {
    p.topics = matchTopics(p.hay, topicList);
    p.topicsFor = topicList;
  }
  return p;
}

/**
 * Does the per-item work ahead of time, a slice at a time, so a big library that has just
 * arrived is filtered without one long pause. Resolves once every item is ready.
 */
export async function warmItems(items: Item[], topicList: Topic[], sliceMs = 12): Promise<void> {
  let i = 0;
  while (i < items.length) {
    const end = performance.now() + sliceMs;
    while (i < items.length && performance.now() < end) {
      for (const stop = Math.min(items.length, i + 200); i < stop; i++) prepared(items[i], topicList);
    }
    if (i < items.length) await new Promise((r) => setTimeout(r, 0));
  }
}

export function evaluate(item: Item, spec: FilterSpec, ctx: FilterContext, groups: DedupeGroups, parsed: ParsedQuery): Evaluation {
  const hidden: HideReason[] = [];
  const matched: MatchReason[] = [];
  const { hay, topics, noise, handle, authorName, authorKey, day, publishedMs } = prepared(item, ctx.topics);
  let score = 0;

  if (!spec.showDemo && item.isDemo) hidden.push({ key: 'showDemo', label: 'Demo item (demo hidden)' });

  // Search
  if (spec.query.trim()) {
    const misses: string[] = [];
    for (const t of parsed.terms) {
      if (hay.includes(t)) {
        score += termMatches(hay, t) ? 3 : 1;
      } else misses.push(t);
    }
    for (const p of parsed.phrases) {
      if (hay.includes(p)) score += 4;
      else misses.push(`“${p}”`);
    }
    for (const n of parsed.negated) if (hay.includes(n)) misses.push(`not “${n}”`);
    if (parsed.from.length && !parsed.from.some((f) => handle.includes(f) || authorName.includes(f))) misses.push(`from:${parsed.from.join(',')}`);
    if (parsed.site.length && !parsed.site.some((s) => normalizeForMatch(item.url + ' ' + item.links.join(' ')).includes(s))) misses.push(`site:${parsed.site.join(',')}`);
    if (misses.length) hidden.push({ key: 'query', label: `Search: no match for ${misses.join(', ')}` });
    else matched.push({ kind: 'query', label: `Matches search “${spec.query.trim()}”` });
  }

  // Include / exclude keywords
  if (spec.include.length) {
    const hits = spec.include.filter((k) => termMatches(hay, k));
    const ok = spec.includeMode === 'all' ? hits.length === spec.include.length : hits.length > 0;
    if (!ok) {
      const missing = spec.include.filter((k) => !hits.includes(k));
      hidden.push({ key: 'include', label: spec.includeMode === 'all' ? `Missing keyword ${missing.map((k) => `“${k}”`).join(', ')}` : `None of the keywords ${spec.include.map((k) => `“${k}”`).join(', ')}` });
    } else {
      score += hits.length * 2;
      matched.push({ kind: 'include', label: `Keyword ${hits.map((k) => `“${k}”`).join(', ')}` });
    }
  }
  if (spec.exclude.length) {
    const hit = spec.exclude.find((k) => termMatches(hay, k));
    if (hit) hidden.push({ key: 'exclude', label: `Muted word “${hit}”` });
  }

  // Sources and authors
  if (spec.sources.length && !spec.sources.includes(item.sourceId)) hidden.push({ key: 'sources', label: 'Source not selected' });
  if (spec.excludeSources.includes(item.sourceId)) hidden.push({ key: 'excludeSources', label: `Muted source ${ctx.sourceLabels?.[item.sourceId] ?? ''}`.trim() });
  if (spec.authors.length) {
    if (!spec.authors.some((a) => a.toLowerCase() === authorKey)) hidden.push({ key: 'authors', label: 'Author not selected' });
    else matched.push({ kind: 'author', label: `From ${item.author.name}` });
  }
  if (spec.excludeAuthors.some((a) => a.toLowerCase() === authorKey)) hidden.push({ key: 'excludeAuthors', label: `Muted author ${item.author.handle ? '@' + item.author.handle : item.author.name}` });
  if (spec.platforms.length && !spec.platforms.includes(item.platform)) hidden.push({ key: 'platforms', label: `Platform ${item.platform} not selected` });

  // Content shape
  if (spec.contentTypes.length) {
    const types = contentTypesOf(item);
    if (!spec.contentTypes.some((t) => types.includes(t))) hidden.push({ key: 'contentTypes', label: `Type is ${types.join(', ')}` });
  }
  if (spec.kinds.length && !spec.kinds.includes(item.kind)) hidden.push({ key: 'kinds', label: `Kind is ${item.kind}` });
  if (spec.langs.length) {
    if (!item.lang) hidden.push({ key: 'langs', label: 'Language unknown' });
    else if (!spec.langs.includes(item.lang.slice(0, 2).toLowerCase())) hidden.push({ key: 'langs', label: `Language is ${item.lang}` });
  }

  // Topics
  if (spec.topics.length) {
    const hit = topics.filter((t) => spec.topics.includes(t.topicId));
    if (!hit.length) hidden.push({ key: 'topics', label: 'Not in selected topics' });
    else {
      score += hit.length * 2;
      for (const t of hit) matched.push({ kind: 'topic', label: `${t.topicName} via “${t.term}”` });
    }
  }

  // Dates
  if (spec.dateFrom && day < spec.dateFrom) hidden.push({ key: 'dateFrom', label: `Before ${spec.dateFrom}` });
  if (spec.dateTo && day > spec.dateTo) hidden.push({ key: 'dateTo', label: `After ${spec.dateTo}` });

  // Local state
  if (spec.read === 'unread' && item.state.read && !ctx.keepRead?.has(item.id)) hidden.push({ key: 'read', label: 'Already read' });
  if (spec.read === 'read' && !item.state.read) hidden.push({ key: 'read', label: 'Unread' });
  if (spec.saved === 'saved' && !item.state.saved) hidden.push({ key: 'saved', label: 'Not saved' });
  if (spec.saved === 'unsaved' && item.state.saved) hidden.push({ key: 'saved', label: 'Saved' });
  if (spec.archived === 'hide' && item.state.archived) hidden.push({ key: 'archived', label: 'Archived' });
  if (spec.archived === 'only' && !item.state.archived) hidden.push({ key: 'archived', label: 'Not archived' });
  if (spec.collection && !item.state.collections.includes(spec.collection)) hidden.push({ key: 'collection', label: `Not in “${spec.collection}”` });

  // Classifiers
  if (spec.hideNoise && noise.isNoise) {
    hidden.push({ key: 'hideNoise', label: noise.overridden ? 'Marked as noise by you' : `Noise: ${noise.signals.map((s) => s.label.toLowerCase()).join(', ')}` });
  }

  if (spec.aiRules && ctx.ai?.rules?.length) {
    for (const rule of ctx.ai.rules) {
      if (!rule.enabled) continue;
      const l = ctx.ai.labels?.[rule.id]?.[item.id];
      if (!l) continue; // not labelled yet: never hide on a guess
      const why = l.reason ? `: ${l.reason}` : '';
      if (rule.action === 'hide' && l.match) hidden.push({ key: 'aiRules', label: `AI rule “${rule.name}”${why}` });
      else if (rule.action === 'only' && !l.match) hidden.push({ key: 'aiRules', label: `AI rule “${rule.name}”: not a match` });
      else if (l.match && rule.action !== 'hide') {
        matched.push({ kind: 'ai', label: `AI rule “${rule.name}”${why}` });
        score += 1;
      }
    }
  }

  const duplicateOf = groups.duplicateOf.get(item.id) ?? null;
  if (spec.hideDuplicates && duplicateOf) hidden.push({ key: 'duplicate', label: 'Duplicate of another copy' });

  if (item.state.saved) score += 1;
  score += topics.length * 0.5;
  // Gentle recency term so relevance ties break toward newer items.
  const ageDays = ((ctx.now ? ctx.now.getTime() : Date.now()) - publishedMs) / 86_400_000;
  score += Math.max(0, 2 - Math.max(0, ageDays) / 30);

  return {
    item,
    visible: hidden.length === 0,
    hidden,
    matched,
    noise,
    topics,
    duplicateOf,
    duplicates: groups.copies.get(item.id) ?? [],
    score,
  };
}

export interface FilterResult {
  visible: Evaluation[];
  hidden: Evaluation[];
  /** How many items each clause hid (an item hidden by two clauses counts for both). */
  hiddenBy: Partial<Record<HideReason['key'], number>>;
  total: number;
  ms: number;
}

// What a result was computed from, so the next call can tell whether only a few items changed.
interface ResultInputs {
  items: Item[];
  specKey: string;
  parsed: ParsedQuery;
  topics: Topic[];
  sourceLabels: FilterContext['sourceLabels'];
  rules: AiRule[] | undefined;
  labels: NonNullable<FilterContext['ai']>['labels'];
  keepRead: ReadonlySet<string> | undefined;
  /** Positions of the items sharing each dedupe key held by more than one item; built on first need. */
  sharedAt?: Map<string, number[]>;
}
const inputs = new WeakMap<FilterResult, ResultInputs>();
const NO_GROUPS: DedupeGroups = { duplicateOf: new Map(), copies: new Map() };
const EMPTY_SET: ReadonlySet<string> = new Set();
/** Past this many changed items a full pass is about as quick. */
const INCREMENTAL_MAX = 400;

/**
 * Re-evaluates only the items that changed since `prev` (marking a few posts read while
 * scrolling), when nothing else did. Returns null whenever a full pass is needed, including when
 * a changed item shares a dedupe key with another, because duplicates are grouped across items.
 */
function refilter(prev: FilterResult, items: Item[], spec: FilterSpec, ctx: FilterContext, t0: number): FilterResult | null {
  const m = inputs.get(prev);
  if (!m || ctx.now || m.items.length !== items.length) return null;
  if (m.topics !== ctx.topics || m.sourceLabels !== ctx.sourceLabels || m.rules !== ctx.ai?.rules || m.labels !== ctx.ai?.labels) return null;
  if (m.specKey !== JSON.stringify(spec)) return null;
  // Changed posts are found by position, and the old evaluations to drop are matched by object
  // (the old item), which is cheaper than looking ids up across 100k posts again.
  const targets = new Set<string>();
  const changed: number[] = [];
  const stale = new Set<Item>();
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    const b = m.items[i];
    if (a === b) continue;
    if (a.id !== b.id || a.dedupeKey !== b.dedupeKey) return null;
    targets.add(a.id);
    changed.push(i);
    stale.add(b);
    if (targets.size > INCREMENTAL_MAX) return null;
  }
  if (m.keepRead !== ctx.keepRead) {
    const before = m.keepRead ?? EMPTY_SET;
    const after = ctx.keepRead ?? EMPTY_SET;
    for (const id of before) if (!after.has(id)) return null;
    const extra = new Set<string>();
    for (const id of after) if (!before.has(id) && !targets.has(id)) extra.add(id);
    if (targets.size + extra.size > INCREMENTAL_MAX) return null;
    if (extra.size) {
      for (let i = 0; i < items.length; i++) {
        if (!extra.has(items[i].id)) continue;
        targets.add(items[i].id);
        changed.push(i);
        stale.add(items[i]);
      }
      changed.sort((a, b) => a - b);
    }
  }
  if (!targets.size) {
    const same = { ...prev, ms: 0 };
    inputs.set(same, { ...m, items, keepRead: ctx.keepRead });
    return same;
  }
  if (!m.sharedAt) {
    const first = new Map<string, number>();
    const at = new Map<string, number[]>();
    for (let i = 0; i < items.length; i++) {
      const k = items[i].dedupeKey;
      const f = first.get(k);
      if (f === undefined) first.set(k, i);
      else if (at.has(k)) at.get(k)!.push(i);
      else at.set(k, [f, i]);
    }
    m.sharedAt = at;
  }
  // Duplicates are grouped per dedupe key, so a changed post that has copies re-checks its whole
  // group (usually two or three posts) instead of sending the library back through a full pass.
  const fresh: Evaluation[] = [];
  const groups = new Set<string>();
  for (const i of changed) {
    const it = items[i];
    if (m.sharedAt.has(it.dedupeKey)) groups.add(it.dedupeKey);
    else fresh.push(evaluate(it, spec, ctx, NO_GROUPS, m.parsed));
  }
  for (const k of groups) {
    const evs = m.sharedAt.get(k)!.map((j) => {
      const it = items[j];
      if (!targets.has(it.id)) {
        targets.add(it.id);
        stale.add(m.items[j]);
      }
      return evaluate(it, spec, ctx, NO_GROUPS, m.parsed);
    });
    const g = groupDuplicates(evs.filter((e) => e.visible).map((e) => e.item));
    for (const ev of evs) {
      ev.duplicateOf = g.duplicateOf.get(ev.item.id) ?? null;
      ev.duplicates = g.copies.get(ev.item.id) ?? [];
      if (spec.hideDuplicates && ev.duplicateOf) {
        ev.hidden.push({ key: 'duplicate', label: 'Duplicate of another copy' });
        ev.visible = false;
      }
      fresh.push(ev);
    }
  }
  const hiddenBy = { ...prev.hiddenBy };
  const keep = (list: Evaluation[], countHidden: boolean) =>
    list.filter((ev) => {
      if (!stale.has(ev.item)) return true;
      if (countHidden) for (const r of ev.hidden) hiddenBy[r.key] = (hiddenBy[r.key] ?? 0) - 1;
      return false;
    });
  const visible = keep(prev.visible, false);
  const hidden = keep(prev.hidden, true);
  const cmp = comparator(spec, ctx);
  const insert = (list: Evaluation[], ev: Evaluation) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cmp(list[mid], ev) <= 0) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, ev);
  };
  for (const ev of fresh) {
    if (ev.visible) insert(visible, ev);
    else {
      insert(hidden, ev);
      for (const r of ev.hidden) hiddenBy[r.key] = (hiddenBy[r.key] ?? 0) + 1;
    }
  }
  for (const k of Object.keys(hiddenBy) as (keyof typeof hiddenBy)[]) if (!hiddenBy[k]) delete hiddenBy[k];
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const out: FilterResult = { visible, hidden, hiddenBy, total: items.length, ms: t1 - t0 };
  inputs.set(out, { ...m, items, keepRead: ctx.keepRead });
  return out;
}

/**
 * Filters the library. Pass the previous result as `prev` to make repeated calls cheap: when the
 * only difference is a handful of changed items, just those are evaluated again.
 */
export function applyFilters(items: Item[], spec: FilterSpec, ctx: FilterContext, prev?: FilterResult | null): FilterResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (prev) {
    const quick = refilter(prev, items, spec, ctx, t0);
    if (quick) return quick;
  }
  const parsed = parseQuery(spec.query);
  const visible: Evaluation[] = [];
  const hidden: Evaluation[] = [];
  const hiddenBy: FilterResult['hiddenBy'] = {};
  // Two passes: duplicates are grouped only among posts that pass every other filter, so hiding
  // the fuller copy (another source, archived, muted) never makes the post vanish entirely.
  const noGroups: DedupeGroups = { duplicateOf: new Map(), copies: new Map() };
  const evs = items.map((item) => evaluate(item, spec, ctx, noGroups, parsed));
  const groups = groupDuplicates(evs.filter((e) => e.visible).map((e) => e.item));
  for (const ev of evs) {
    ev.duplicateOf = groups.duplicateOf.get(ev.item.id) ?? null;
    ev.duplicates = groups.copies.get(ev.item.id) ?? [];
    if (spec.hideDuplicates && ev.duplicateOf) {
      ev.hidden.push({ key: 'duplicate', label: 'Duplicate of another copy' });
      ev.visible = false;
    }
  }
  for (const ev of evs) {
    if (ev.visible) visible.push(ev);
    else {
      hidden.push(ev);
      for (const r of ev.hidden) hiddenBy[r.key] = (hiddenBy[r.key] ?? 0) + 1;
    }
  }
  const cmp = comparator(spec, ctx);
  visible.sort(cmp);
  hidden.sort(cmp);
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const out: FilterResult = { visible, hidden, hiddenBy, total: items.length, ms: t1 - t0 };
  inputs.set(out, { items, specKey: JSON.stringify(spec), parsed, topics: ctx.topics, sourceLabels: ctx.sourceLabels, rules: ctx.ai?.rules, labels: ctx.ai?.labels, keepRead: ctx.keepRead });
  return out;
}

function comparator(spec: FilterSpec, ctx: FilterContext) {
  switch (spec.sort) {
    case 'oldest':
      return (a: Evaluation, b: Evaluation) => byIso(a.item.publishedAt, b.item.publishedAt);
    case 'relevance':
      return (a: Evaluation, b: Evaluation) => b.score - a.score || byIso(b.item.publishedAt, a.item.publishedAt);
    case 'source':
      return (a: Evaluation, b: Evaluation) =>
        (ctx.sourceLabels?.[a.item.sourceId] ?? a.item.sourceId).localeCompare(ctx.sourceLabels?.[b.item.sourceId] ?? b.item.sourceId) ||
        byIso(b.item.publishedAt, a.item.publishedAt);
    default:
      return (a: Evaluation, b: Evaluation) => byIso(b.item.publishedAt, a.item.publishedAt);
  }
}

/** Number of non-default clauses in a spec, for the "N filters on" summary. */
export function activeClauses(spec: FilterSpec): (keyof FilterSpec)[] {
  const keys: (keyof FilterSpec)[] = [];
  for (const k of Object.keys(DEFAULT_SPEC) as (keyof FilterSpec)[]) {
    if (k === 'sort' || k === 'includeMode') continue;
    const a = spec[k];
    const d = DEFAULT_SPEC[k];
    if (Array.isArray(a) ? a.length > 0 : a !== d && !(typeof a === 'string' && !a.trim() && !d)) keys.push(k);
  }
  return keys;
}

/** Reset one clause to its default. */
export function clearClause(spec: FilterSpec, key: keyof FilterSpec | 'duplicate'): FilterSpec {
  if (key === 'duplicate') return { ...spec, hideDuplicates: false };
  if (key === 'aiRules') return { ...spec, aiRules: !spec.aiRules };
  return { ...spec, [key]: DEFAULT_SPEC[key] } as FilterSpec;
}
