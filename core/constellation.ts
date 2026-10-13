// Constellation: a map of your reading world, worked out locally from reading state.
// People, sources and topics become nodes sized by what you did with their posts over the last
// N days (read, saved, highlighted, kept for later); links join an author to the sources they
// post in and the topics they post about. No AI and no network. The layout is a small,
// deterministic force simulation that can run a slice at a time, so the UI never stalls.

import { itemHaystack, matchTopics } from './classify.ts';
import type { Item, Source, Topic } from './types.ts';

export type NodeKind = 'person' | 'source' | 'topic';

export interface CNode {
  /** Unique across kinds: "p:<author key>", "s:<source id>", "t:<topic id>". */
  id: string;
  kind: NodeKind;
  /** Author key, source id or topic id. */
  ref: string;
  label: string;
  /** A handle for a person, the platform for a source. */
  sub?: string;
  /** The platform that colours the node (a person takes their main source's). */
  platform?: string;
  /** For a topic: its place in the topic list, which picks its colour. */
  hue?: number;
  posts: number;
  read: number;
  saved: number;
  highlighted: number;
  /** Engagement score that sizes the node. */
  weight: number;
  /** The newest post in the window: what a card shows, and the seed for a person page. */
  lastItemId?: string;
  lastAt?: string;
  lastText?: string;
  avatar?: string;
  /** Radius in layout units. */
  r: number;
  x: number;
  y: number;
}

export interface CLink {
  /** Indices into nodes. */
  a: number;
  b: number;
  /** Shared posts. */
  w: number;
}

export interface Constellation {
  nodes: CNode[];
  links: CLink[];
  days: number;
  /** Posts in the window, and how many of them you engaged with. */
  posts: number;
  engaged: number;
}

export interface ConstellationInput {
  items: Item[];
  sources: Source[];
  topics: Topic[];
  /** Item ids with at least one highlight. */
  highlighted?: ReadonlySet<string>;
  now?: Date;
  days?: number;
  maxPeople?: number;
  maxSources?: number;
  maxTopics?: number;
}

const DAY = 86_400_000;
const READ_LATER = 'Read later';

/** What one post earns its author, source and topics. */
export function engagement(it: Item, highlighted?: ReadonlySet<string>): number {
  let e = 0;
  if (it.state.read) e += 1;
  if (it.state.saved) e += 3;
  if (highlighted?.has(it.id)) e += 3;
  if (it.state.collections.length) e += it.state.collections.includes(READ_LATER) ? 1 : 1.5;
  return e;
}

export const authorKeyOf = (it: Pick<Item, 'author'>) => (it.author.handle ?? it.author.name).trim().toLowerCase();

interface Acc {
  posts: number;
  read: number;
  saved: number;
  highlighted: number;
  eng: number;
  last: Item | null;
  /** Neighbour key -> shared posts. */
  links: Map<string, number>;
}
const acc = (): Acc => ({ posts: 0, read: 0, saved: 0, highlighted: 0, eng: 0, last: null, links: new Map() });

function add(a: Acc, it: Item, e: number, hl: boolean) {
  a.posts++;
  if (it.state.read) a.read++;
  if (it.state.saved) a.saved++;
  if (hl) a.highlighted++;
  a.eng += e;
  if (!a.last || it.publishedAt > a.last.publishedAt) a.last = it;
}

const bump = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

/** A node's weight: engagement first, with a little for sheer presence so busy sources show. */
const weightOf = (a: Acc) => a.eng + Math.sqrt(a.posts) * 0.35;

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export function buildConstellation(input: ConstellationInput): Constellation {
  const now = (input.now ?? new Date()).getTime();
  const days = input.days ?? 90;
  const since = now - days * DAY;
  const hl = input.highlighted;
  const realOnly = input.items.some((i) => !i.isDemo);
  const sourceById = new Map(input.sources.map((s) => [s.id, s]));

  const people = new Map<string, Acc>();
  const sources = new Map<string, Acc>();
  const topics = new Map<string, Acc>();
  const personFace = new Map<string, Item>();
  let posts = 0;
  let engaged = 0;

  for (const it of input.items) {
    if (realOnly && it.isDemo) continue;
    const t = Date.parse(it.publishedAt);
    if (!(t >= since) || t > now + DAY) continue;
    posts++;
    const e = engagement(it, hl);
    if (e > 0) engaged++;
    const h = !!hl?.has(it.id);
    const pk = authorKeyOf(it);
    if (!pk) continue;
    const p = people.get(pk) ?? acc();
    people.set(pk, p);
    add(p, it, e, h);
    if (it.author.avatar && !personFace.has(pk)) personFace.set(pk, it);
    const sid = it.sourceId;
    if (sourceById.has(sid)) {
      const s = sources.get(sid) ?? acc();
      sources.set(sid, s);
      add(s, it, e, h);
      bump(p.links, `s:${sid}`);
    }
    if (input.topics.length) {
      for (const m of matchTopics(itemHaystack(it), input.topics)) {
        const tp = topics.get(m.topicId) ?? acc();
        topics.set(m.topicId, tp);
        add(tp, it, e, h);
        bump(p.links, `t:${m.topicId}`);
        if (sourceById.has(sid)) bump(tp.links, `s:${sid}`);
      }
    }
  }

  const top = (m: Map<string, Acc>, n: number) =>
    [...m.entries()].sort((a, b) => weightOf(b[1]) - weightOf(a[1]) || b[1].posts - a[1].posts || a[0].localeCompare(b[0])).slice(0, n);

  const keptSources = top(sources, input.maxSources ?? 24);
  const keptTopics = top(topics, input.maxTopics ?? 16).filter(([, a]) => a.posts > 0);
  // People who did nothing for you and post little stay out: they are noise in a sky.
  const keptPeople = top(people, input.maxPeople ?? 110).filter(([, a]) => a.eng > 0 || a.posts >= 3);

  const nodes: CNode[] = [];
  const index = new Map<string, number>();
  const push = (n: Omit<CNode, 'r' | 'x' | 'y'>) => {
    index.set(n.id, nodes.length);
    nodes.push({ ...n, r: 0, x: 0, y: 0 });
  };
  const base = (a: Acc) => ({
    posts: a.posts, read: a.read, saved: a.saved, highlighted: a.highlighted, weight: weightOf(a),
    lastItemId: a.last?.id, lastAt: a.last?.publishedAt, lastText: a.last ? oneLine(a.last.title || a.last.text).slice(0, 160) : undefined,
  });

  for (const [sid, a] of keptSources) {
    const s = sourceById.get(sid)!;
    push({ id: `s:${sid}`, kind: 'source', ref: sid, label: s.label, sub: s.platform, platform: s.platform, ...base(a) });
  }
  const topicOrder = new Map(input.topics.map((t, i) => [t.id, i]));
  for (const [tid, a] of keptTopics) {
    const t = input.topics.find((x) => x.id === tid)!;
    push({ id: `t:${tid}`, kind: 'topic', ref: tid, label: t.name, hue: topicOrder.get(tid) ?? 0, ...base(a) });
  }
  for (const [pk, a] of keptPeople) {
    const face = personFace.get(pk) ?? a.last!;
    // A person wears the colour of the source they post in most.
    let main: string | undefined;
    let best = -1;
    for (const [k, n] of a.links) if (k.startsWith('s:') && n > best) { best = n; main = k.slice(2); }
    push({
      id: `p:${pk}`, kind: 'person', ref: pk, label: oneLine(face.author.name) || pk,
      sub: face.author.handle ? oneLine(face.author.handle) : undefined,
      platform: main ? sourceById.get(main)?.platform : face.platform,
      avatar: face.author.avatar, ...base(a),
    });
  }

  // Links: each person to their two strongest sources and two strongest topics; each topic to its
  // three strongest sources. Few links keep the sky readable.
  const links: CLink[] = [];
  const link = (from: string, m: Map<string, number>, prefix: 's:' | 't:', n: number) => {
    const a = index.get(from);
    if (a === undefined) return;
    const best = [...m.entries()].filter(([k]) => k.startsWith(prefix) && index.has(k)).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, n);
    for (const [k, w] of best) links.push({ a, b: index.get(k)!, w });
  };
  for (const [pk, a] of keptPeople) {
    link(`p:${pk}`, a.links, 's:', 2);
    link(`p:${pk}`, a.links, 't:', 2);
  }
  for (const [tid, a] of keptTopics) link(`t:${tid}`, a.links, 's:', 3);

  sizeNodes(nodes);
  seedPositions(nodes);
  return { nodes, links, days, posts, engaged };
}

const RADIUS: Record<NodeKind, [number, number]> = { person: [3.5, 14], source: [7, 20], topic: [9, 24] };

/** Radii by kind, by the square root of weight relative to the heaviest node of that kind. */
export function sizeNodes(nodes: CNode[]) {
  const max: Record<NodeKind, number> = { person: 0, source: 0, topic: 0 };
  for (const n of nodes) max[n.kind] = Math.max(max[n.kind], n.weight);
  for (const n of nodes) {
    const [lo, hi] = RADIUS[n.kind];
    n.r = lo + (hi - lo) * Math.sqrt(max[n.kind] ? n.weight / max[n.kind] : 0);
  }
}

/** Golden-angle spiral, heaviest in the middle: deterministic, and a good start for the forces. */
function seedPositions(nodes: CNode[]) {
  const order = nodes.map((_, i) => i).sort((a, b) => nodes[b].r - nodes[a].r);
  const golden = Math.PI * (3 - Math.sqrt(5));
  order.forEach((i, k) => {
    const d = 18 * Math.sqrt(k + 0.5);
    nodes[i].x = Math.cos(k * golden) * d;
    nodes[i].y = Math.sin(k * golden) * d;
  });
}

export interface Simulation {
  /** Runs up to `n` more steps; true once the layout has settled. */
  step(n: number): boolean;
  readonly done: boolean;
}

/**
 * A small force layout: every pair repels, links pull to a rest length set by the two radii,
 * a soft gravity holds the sky together and overlaps are pushed apart. Cooling makes it settle.
 * Plain O(n²) per step is fine at the ~150 nodes the builder keeps.
 */
export function simulate(g: Pick<Constellation, 'nodes' | 'links'>, total = 360): Simulation {
  const { nodes, links } = g;
  const n = nodes.length;
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  const mass = nodes.map((d) => (d.kind === 'person' ? 1 : 3));
  let k = 0;
  return {
    get done() {
      return k >= total;
    },
    step(count: number) {
      for (let s = 0; s < count && k < total; s++, k++) {
        const alpha = 1 - k / total;
        const heat = 0.12 + alpha * 0.88;
        // Repulsion and collision.
        for (let i = 0; i < n; i++) {
          const a = nodes[i];
          for (let j = i + 1; j < n; j++) {
            const b = nodes[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 0.01) { dx = (i - j) * 0.01 + 0.01; dy = 0.01; d2 = dx * dx + dy * dy; }
            const d = Math.sqrt(d2);
            const minD = (a.r + b.r) * (a.kind === 'topic' || b.kind === 'topic' ? 1.3 : 1) + (a.kind === 'person' && b.kind === 'person' ? 6 : 16);
            let f = ((a.r + b.r) * 150 + 320) / d2;
            // Topics and sources are the bright anchors: they keep well apart from each other.
            if (a.kind !== 'person' && b.kind !== 'person') f *= a.kind === 'topic' && b.kind === 'topic' ? 6 : 2.2;
            if (d < minD) f += (minD - d) * 0.35 / d;
            const fx = (dx / d) * f * heat;
            const fy = (dy / d) * f * heat;
            vx[i] -= fx / mass[i]; vy[i] -= fy / mass[i];
            vx[j] += fx / mass[j]; vy[j] += fy / mass[j];
          }
        }
        // Springs.
        for (const l of links) {
          const a = nodes[l.a];
          const b = nodes[l.b];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const rest = a.r + b.r + 46;
          const f = (d - rest) * 0.02 * Math.min(2, 0.6 + Math.log2(1 + l.w) * 0.25) * heat;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          vx[l.a] += fx / mass[l.a]; vy[l.a] += fy / mass[l.a];
          vx[l.b] -= fx / mass[l.b]; vy[l.b] -= fy / mass[l.b];
        }
        // Gravity, a little stronger on the edges, then damping.
        for (let i = 0; i < n; i++) {
          const d = nodes[i];
          // A wider-than-tall sky fits screens better.
          vx[i] -= d.x * 0.0042 * heat;
          vy[i] -= d.y * 0.0085 * heat;
          vx[i] *= 0.6;
          vy[i] *= 0.6;
          const sp = Math.hypot(vx[i], vy[i]);
          const cap = 12 * heat + 0.5;
          if (sp > cap) { vx[i] *= cap / sp; vy[i] *= cap / sp; }
          d.x += vx[i];
          d.y += vy[i];
        }
      }
      return k >= total;
    },
  };
}

/** The layout's bounding box, radii included. */
export function bounds(nodes: CNode[]): { x0: number; y0: number; x1: number; y1: number } {
  if (!nodes.length) return { x0: -1, y0: -1, x1: 1, y1: 1 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r);
    x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r);
  }
  return { x0, y0, x1, y1 };
}

/**
 * The nearest node in an arrow-key direction, for keyboard travel. Nodes within 70 degrees of the
 * direction count; distance is penalised by how far off-axis they sit.
 */
export function neighbourIn(nodes: Pick<CNode, 'x' | 'y'>[], from: number, dir: 'left' | 'right' | 'up' | 'down', visible?: (i: number) => boolean): number {
  const o = nodes[from];
  const [ux, uy] = dir === 'left' ? [-1, 0] : dir === 'right' ? [1, 0] : dir === 'up' ? [0, -1] : [0, 1];
  let best = -1;
  let bestScore = Infinity;
  nodes.forEach((n, i) => {
    if (i === from || (visible && !visible(i))) return;
    const dx = n.x - o.x;
    const dy = n.y - o.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.001) return;
    const cos = (dx * ux + dy * uy) / d;
    if (cos < Math.cos((70 * Math.PI) / 180)) return;
    const score = d * (1 + (1 - cos) * 3);
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}
