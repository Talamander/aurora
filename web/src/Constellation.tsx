// Constellation: your reading world as a night sky. People, sources and topics are stars sized by
// what you did with their posts over 90 days, joined by faint lines where an author posts in a
// source or about a topic. Everything is worked out here from the local library; nothing is sent
// anywhere. Post text is shown as plain text only.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bounds, buildConstellation, neighbourIn, simulate, type CNode, type Constellation, type NodeKind } from '../../core/constellation.ts';
import type { Item } from '../../core/types.ts';
import { agoText, platformLabel, plural } from './format.ts';
import { Icon } from './icons.tsx';
import { lf } from './longform.ts';
import { openPerson } from './Person.tsx';
import type { Reader } from './state.ts';
import { useDialog } from './useDialog.ts';
import './constellation.css';

const KIND_LABEL: Record<NodeKind, string> = { person: 'Person', source: 'Source', topic: 'Topic' };
const KIND_PLURAL: Record<NodeKind, string> = { person: 'People', source: 'Sources', topic: 'Topics' };
// Topic colours, one per topic in list order. Two sets so each stays readable on its ground.
const TOPIC_DARK = ['#7dcfff', '#c3a6ff', '#9ece6a', '#f5c469', '#ff8fa8', '#73daca', '#ffa66b', '#8fb2ff'];
const TOPIC_LIGHT = ['#0b7fae', '#7148d6', '#3f7d1f', '#a26a00', '#c8325a', '#13867a', '#c25412', '#3456c9'];

// Steady colours for platforms the theme does not name.
const EXTRA_DARK = ['#ffb38a', '#a0e7a0', '#f2a6ff', '#89ddff', '#ffd580', '#ff9eb5', '#9fb7ff', '#7fe0c7'];
const EXTRA_LIGHT = ['#c4561c', '#2f8a3a', '#a33fb8', '#1478a8', '#a87300', '#c23960', '#3d5bc4', '#16806b'];

interface Palette {
  dark: boolean;
  ground: string;
  ink: string;
  ink2: string;
  ink3: string;
  lamp: string;
  lit: string[];
  font: string;
  hue: (platform?: string) => string;
  topic: (i?: number) => string;
}

function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (k: string) => cs.getPropertyValue(k).trim();
  const dark = document.documentElement.dataset.theme === 'dark';
  const lit = (v('--lit').match(/#[0-9a-f]{6}\b/gi) ?? []).slice(0, 3);
  const cache = new Map<string, string>();
  const fallback = v('--hue-web') || '#6b7686';
  return {
    dark,
    ground: v('--ground') || (dark ? '#05060a' : '#f3f4f7'),
    ink: v('--ink') || (dark ? '#eef0f6' : '#0b0d12'),
    ink2: v('--ink-2') || '#a7adba',
    ink3: v('--ink-3') || '#868e9c',
    lamp: v('--lamp') || '#ffad7a',
    lit: lit.length === 3 ? lit : ['#f08a24', '#e8467c', '#6d5cf0'],
    font: v('--ui') || 'system-ui, sans-serif',
    hue: (p) => {
      const key = p ?? 'web';
      let c = cache.get(key);
      if (!c) {
        c = (/^[a-z0-9-]+$/i.test(key) && v(`--hue-${key}`)) || '';
        // Platforms without a theme colour (an AI-built connector's site) get a steady one of
        // their own from the name, so the sky is not a field of grey.
        if (!c && key !== 'web' && key !== 'import') {
          let hsh = 0;
          for (const ch of key) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
          c = (dark ? EXTRA_DARK : EXTRA_LIGHT)[hsh % EXTRA_DARK.length];
        }
        c ||= fallback;
        cache.set(key, c);
      }
      return c;
    },
    topic: (i = 0) => (dark ? TOPIC_DARK : TOPIC_LIGHT)[i % TOPIC_DARK.length],
  };
}

const colorOf = (n: CNode, pal: Palette) => (n.kind === 'topic' ? pal.topic(n.hue) : pal.hue(n.platform));

/** Hex (or anything canvas understands) with an alpha, via a tiny cached canvas parse. */
const alphaCache = new Map<string, string>();
function withAlpha(color: string, a: number): string {
  const key = `${color}|${a.toFixed(3)}`;
  let out = alphaCache.get(key);
  if (out) return out;
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (m) {
    const n = parseInt(m[1], 16);
    out = `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  } else out = color;
  if (alphaCache.size > 4000) alphaCache.clear();
  alphaCache.set(key, out);
  return out;
}

/** A deterministic sprinkle of background stars, in 0..1 screen coordinates. */
function makeStars(count: number) {
  let s = 1234567;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return Array.from({ length: count }, () => ({ x: rnd(), y: rnd(), r: rnd() < 0.08 ? 1.3 : 0.35 + rnd() * 0.6, ph: rnd() * Math.PI * 2, depth: 0.2 + rnd() * 0.8 }));
}
const STARS = makeStars(320);

/** A four-point sparkle, for topics. */
function sparkle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  const k = r * 0.28;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x + k, y - k, x + r, y);
  ctx.quadraticCurveTo(x + k, y + k, x, y + r);
  ctx.quadraticCurveTo(x - k, y + k, x - r, y);
  ctx.quadraticCurveTo(x - k, y - k, x, y - r);
  ctx.closePath();
}

const statsLine = (n: CNode) => {
  const bits = [`${n.read} read`];
  if (n.saved) bits.push(`${n.saved} saved`);
  if (n.highlighted) bits.push(`${n.highlighted} highlighted`);
  return bits.join(' · ');
};

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function ConstellationView({ r, close }: { r: Reader; close: () => void }) {
  const lib = r.lib!;
  const dlg = useDialog<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const skyRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [graph, setGraph] = useState<Constellation | null>(null);
  const [settled, setSettled] = useState(false);
  const [focus, setFocus] = useState(-1);
  const [hover, setHover] = useState(-1);
  const [pinned, setPinned] = useState(false);
  const [shown, setShown] = useState<Record<NodeKind, boolean>>({ person: true, source: true, topic: true });
  const [announce, setAnnounce] = useState('');
  const still = useMemo(reduceMotion, []);

  // Live values the draw loop reads without re-rendering.
  const live = useRef({ focus: -1, hover: -1, shown, cam: { x: 0, y: 0, s: 1 }, goal: null as null | { x: number; y: number; s: number }, autoFit: true, dirty: true, pal: null as Palette | null, w: 0, h: 0, born: 0, rot: false });
  live.current.focus = focus;
  live.current.hover = hover;
  live.current.shown = shown;
  const graphRef = useRef<Constellation | null>(null);
  graphRef.current = graph;
  const avatars = useRef(new Map<string, HTMLImageElement>());

  // Build once highlights arrive (they come from their own endpoint and may be missing), then lay
  // out a slice at a time so the sky forms on screen instead of blocking it.
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const run = (hl: Set<string>) => {
      if (!alive) return;
      const g = buildConstellation({ items: lib.items, sources: lib.sources, topics: lib.topics, highlighted: hl });
      const sim = simulate(g);
      if (still) {
        sim.step(Infinity);
        setGraph(g);
        setSettled(true);
        live.current.dirty = true;
        return;
      }
      live.current.born = performance.now();
      setGraph(g);
      const tick = () => {
        if (!alive) return;
        const done = sim.step(6);
        live.current.dirty = true;
        if (done) setSettled(true);
        else timer = window.setTimeout(tick, 16);
      };
      timer = window.setTimeout(tick, 60);
    };
    lf.highlights().then((hs) => run(new Set(hs.map((h) => h.itemId))), () => run(new Set()));
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Avatars for the brighter people, through the app's own image proxy. Failures just draw a dot.
  useEffect(() => {
    if (!graph) return;
    for (const n of graph.nodes) {
      if (n.kind !== 'person' || !n.avatar || n.r < 7 || avatars.current.has(n.id)) continue;
      if (!/^(https?:|\/)/.test(n.avatar)) continue;
      const img = new Image();
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.onload = () => { live.current.dirty = true; };
      img.src = n.avatar;
      avatars.current.set(n.id, img);
    }
  }, [graph]);

  const visible = useCallback((i: number) => {
    const g = graphRef.current;
    return !!g && live.current.shown[g.nodes[i].kind];
  }, []);

  // Neighbours of a node, for dimming and for labels.
  const adjacency = useMemo(() => {
    const m = new Map<number, Set<number>>();
    if (!graph) return m;
    for (const l of graph.links) {
      if (!m.has(l.a)) m.set(l.a, new Set());
      if (!m.has(l.b)) m.set(l.b, new Set());
      m.get(l.a)!.add(l.b);
      m.get(l.b)!.add(l.a);
    }
    return m;
  }, [graph]);
  const adjRef = useRef(adjacency);
  adjRef.current = adjacency;

  const fitGoal = useCallback(() => {
    const g = graphRef.current;
    const { w, h } = live.current;
    if (!g || !w || !h) return null;
    const ns = g.nodes.filter((_, i) => visible(i));
    const b = bounds((ns.length ? ns : g.nodes).map((n) => ({ ...n, ...proj(n) })));
    const narrow = w < 640;
    const padX = narrow ? 18 : 64;
    const top = narrow ? 172 : 112;
    const bottom = narrow ? 40 : 64;
    const s = Math.max(0.25, Math.min(2.4, (w - padX * 2) / (b.x1 - b.x0 + 60), (h - top - bottom) / (b.y1 - b.y0 + 60)));
    return { s, x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 - (top - bottom) / 2 / s };
  }, [visible]);

  const fit = useCallback(() => {
    live.current.autoFit = true;
    live.current.goal = fitGoal();
    live.current.dirty = true;
  }, [fitGoal]);

  // On a tall screen the wide sky turns on its side, so it fills a phone instead of a strip.
  const proj = (n: { x: number; y: number }) => (live.current.rot ? { x: n.y, y: n.x } : { x: n.x, y: n.y });
  const toScreen = (x: number, y: number) => {
    const { cam, w, h } = live.current;
    return { x: (x - cam.x) * cam.s + w / 2, y: (y - cam.y) * cam.s + h / 2 };
  };
  const toWorld = (sx: number, sy: number) => {
    const { cam, w, h } = live.current;
    return { x: (sx - w / 2) / cam.s + cam.x, y: (sy - h / 2) / cam.s + cam.y };
  };

  // Drift: every star sways a little around its place, so the sky breathes.
  const drift = (n: CNode, i: number, t: number) => {
    const q = proj(n);
    if (still) return q;
    const amp = n.kind === 'person' ? 2.6 : 1.4;
    return { x: q.x + Math.sin(t / 5200 + i * 1.7) * amp, y: q.y + Math.cos(t / 6100 + i * 2.3) * amp };
  };

  const hitTest = useCallback((sx: number, sy: number): number => {
    const g = graphRef.current;
    if (!g) return -1;
    const t = performance.now();
    let best = -1;
    let bestD = Infinity;
    g.nodes.forEach((n, i) => {
      if (!live.current.shown[n.kind]) return;
      const p = drift(n, i, t);
      const s = toScreen(p.x, p.y);
      const d = Math.hypot(s.x - sx, s.y - sy);
      const reach = Math.max(14, n.r * live.current.cam.s + 6);
      if (d < reach && d < bestD) { bestD = d; best = i; }
    });
    return best;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme changes (the toggle, a new preset) recolour the sky.
  useEffect(() => {
    live.current.pal = readPalette();
    const mo = new MutationObserver(() => {
      live.current.pal = readPalette();
      live.current.dirty = true;
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
    return () => mo.disconnect();
  }, []);

  // Size the canvas to its box at device resolution.
  useEffect(() => {
    const el = skyRef.current;
    const cv = canvasRef.current;
    if (!el || !cv) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      live.current.w = w;
      live.current.h = h;
      live.current.rot = h > w * 1.2;
      if (live.current.autoFit) live.current.goal = fitGoal();
      live.current.dirty = true;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitGoal]);

  // The draw loop.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let lastPaint = 0;
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      const L = live.current;
      const g = graphRef.current;
      const pal = L.pal ?? (L.pal = readPalette());
      if (L.autoFit && g && !settledRef.current) L.goal = fitGoal();
      // Ease the camera toward its goal.
      if (L.goal) {
        const k = still ? 1 : 0.12;
        L.cam.x += (L.goal.x - L.cam.x) * k;
        L.cam.y += (L.goal.y - L.cam.y) * k;
        L.cam.s += (L.goal.s - L.cam.s) * k;
        if (Math.abs(L.goal.x - L.cam.x) < 0.05 && Math.abs(L.goal.y - L.cam.y) < 0.05 && Math.abs(L.goal.s - L.cam.s) < 0.0005) {
          L.cam = { ...L.goal };
          L.goal = null;
        }
        L.dirty = true;
      }
      // Idle drift runs at about 30 frames a second; interaction repaints at once.
      if (!L.dirty && (still || t - lastPaint < 32)) return;
      lastPaint = t;
      L.dirty = false;
      const dpr = cv.width / Math.max(1, L.w);
      const { w, h } = L;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintSky(ctx, w, h, t, pal, L.cam, still);
      if (!g) return;

      const active = L.hover >= 0 ? L.hover : L.focus;
      const near = active >= 0 ? adjRef.current.get(active) ?? new Set<number>() : null;
      const pos = g.nodes.map((n, i) => {
        const p = drift(n, i, t);
        return toScreen(p.x, p.y);
      });
      const shown = (i: number) => L.shown[g.nodes[i].kind];
      const lit = (i: number) => !near || i === active || near.has(i);
      const age = still ? 1 : Math.min(1, (t - L.born) / 900);

      // Links: faint arcs, bright around the active star.
      ctx.lineCap = 'round';
      for (const l of g.links) {
        if (!shown(l.a) || !shown(l.b)) continue;
        const a = pos[l.a];
        const b = pos[l.b];
        const on = active >= 0 && (l.a === active || l.b === active);
        const col = colorOf(g.nodes[l.b].kind === 'person' ? g.nodes[l.a] : g.nodes[l.b], pal);
        const base = pal.dark ? 0.24 : 0.26;
        ctx.strokeStyle = withAlpha(col, (on ? 0.75 : near ? 0.05 : base) * age);
        ctx.lineWidth = on ? 1.4 : Math.min(1.2, 0.5 + Math.log2(1 + l.w) * 0.18);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(mx - dy * 0.12, my + dx * 0.12, b.x, b.y);
        ctx.stroke();
      }

      // Stars, people first so sources and topics sit on top.
      const order = g.nodes.map((_, i) => i).sort((x, y) => (g.nodes[x].kind === 'person' ? 0 : 1) - (g.nodes[y].kind === 'person' ? 0 : 1) || g.nodes[x].r - g.nodes[y].r);
      for (const i of order) {
        if (!shown(i)) continue;
        const n = g.nodes[i];
        const p = pos[i];
        const rr = Math.max(1.6, n.r * L.cam.s) * (0.6 + 0.4 * age);
        if (p.x < -rr - 80 || p.y < -rr - 80 || p.x > w + rr + 80 || p.y > h + rr + 80) continue;
        const col = colorOf(n, pal);
        const dim = lit(i) ? 1 : 0.22;
        const tw = still ? 1 : 0.85 + 0.15 * Math.sin(t / 900 + i * 1.3);
        ctx.globalAlpha = dim * age;
        // Halo.
        const haloR = rr * (n.kind === 'person' ? 2.6 : n.kind === 'topic' ? 3.4 : 2.2) * (i === active ? 1.35 : 1);
        const halo = ctx.createRadialGradient(p.x, p.y, rr * 0.4, p.x, p.y, haloR);
        halo.addColorStop(0, withAlpha(col, (pal.dark ? (n.kind === 'source' ? 0.26 : 0.42) : n.kind === 'source' ? 0.16 : 0.28) * tw));
        halo.addColorStop(1, withAlpha(col, 0));
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(p.x, p.y, haloR, 0, Math.PI * 2);
        ctx.fill();

        if (n.kind === 'topic') {
          sparkle(ctx, p.x, p.y, rr * 1.25);
          ctx.fillStyle = col;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr * 0.22, 0, Math.PI * 2);
          ctx.fillStyle = pal.dark ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.85)';
          ctx.fill();
        } else if (n.kind === 'source') {
          // A small planet with a lit side and a faint orbit.
          const body = ctx.createRadialGradient(p.x - rr * 0.35, p.y - rr * 0.4, rr * 0.1, p.x, p.y, rr);
          body.addColorStop(0, withAlpha('#ffffff', pal.dark ? 0.55 : 0.7));
          body.addColorStop(0.3, col);
          body.addColorStop(1, withAlpha(col, pal.dark ? 0.7 : 0.9));
          ctx.fillStyle = body;
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = withAlpha(col, 0.45);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, rr * 1.75, rr * 0.55, -0.35, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          const img = avatars.current.get(n.id);
          if (img && img.complete && img.naturalWidth && rr >= 6) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
            ctx.clip();
            ctx.drawImage(img, p.x - rr, p.y - rr, rr * 2, rr * 2);
            ctx.restore();
            ctx.strokeStyle = withAlpha(col, 0.9);
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(p.x, p.y, rr + 1, 0, Math.PI * 2);
            ctx.stroke();
          } else {
            const core = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr);
            core.addColorStop(0, pal.dark ? '#ffffff' : withAlpha(col, 1));
            core.addColorStop(0.45, col);
            core.addColorStop(1, withAlpha(col, 0.55));
            ctx.fillStyle = core;
            ctx.beginPath();
            ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        // Focus ring: a slow dashed orbit in the lamp colour.
        if (i === L.focus) {
          ctx.globalAlpha = 1;
          ctx.save();
          ctx.strokeStyle = pal.lamp;
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]);
          ctx.lineDashOffset = still ? 0 : -t / 60;
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr * (n.kind === 'topic' ? 1.25 : 1) + 7, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }
      ctx.globalAlpha = 1;

      // Labels, most important first, skipping any that would collide.
      const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
      let activeLabelHalf = 0;
      const rank = (i: number) => (i === active ? 1e6 : 0) + (near?.has(i) ? 1e5 : 0) + (g.nodes[i].kind === 'person' ? 0 : 1e4) + g.nodes[i].r;
      const labelOrder = order.slice().sort((x, y) => rank(y) - rank(x));
      for (const i of labelOrder) {
        if (!shown(i)) continue;
        const n = g.nodes[i];
        const rr = Math.max(1.6, n.r * L.cam.s);
        const important = i === active || near?.has(i) || n.kind !== 'person' || rr >= 7.5;
        if (!important) continue;
        if (near && !lit(i)) continue;
        const p = pos[i];
        const text = n.label.length > 28 ? n.label.slice(0, 27) + '…' : n.label;
        const size = (n.kind === 'source' ? 12.5 : n.kind === 'topic' ? 12 : 11.5) * (w < 640 ? 0.86 : 1);
        const weight = n.kind === 'person' ? 500 : 600;
        ctx.font = `${weight} ${size}px ${pal.font}`;
        const label = n.kind === 'topic' ? text.toUpperCase() : text;
        if (n.kind === 'topic' && 'letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '1px';
        const tw = ctx.measureText(label).width;
        const lx = Math.max(6, Math.min(w - tw - 6, p.x - tw / 2));
        const reach = rr * (n.kind === 'topic' ? 1.25 : 1);
        const hits = (b: { x0: number; y0: number; x1: number; y1: number }) => placed.some((o) => !(b.x1 < o.x0 || b.x0 > o.x1 || b.y1 < o.y0 || b.y0 > o.y1));
        // Below the star first, then above it; skip the label if both collide.
        let ly = p.y + reach + (n.kind === 'source' ? 16 : 13);
        let box = { x0: lx - 3, y0: ly - size, x1: lx + tw + 3, y1: ly + 4 };
        if (i !== active && hits(box)) {
          ly = p.y - reach - (n.kind === 'source' ? 10 : 7);
          box = { x0: lx - 3, y0: ly - size, x1: lx + tw + 3, y1: ly + 4 };
          if (hits(box)) {
            if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px';
            continue;
          }
        }
        if (i === active) activeLabelHalf = tw / 2;
        placed.push(box);
        ctx.globalAlpha = age;
        // A soft shadow of the ground keeps labels readable over links and halos.
        ctx.lineJoin = 'round';
        ctx.lineWidth = 4;
        ctx.strokeStyle = withAlpha(pal.ground, 0.85);
        ctx.strokeText(label, lx, ly);
        ctx.fillStyle = n.kind === 'topic' ? pal.topic(n.hue) : n.kind === 'source' || i === active ? pal.ink : pal.ink2;
        ctx.fillText(label, lx, ly);
        if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px';
      }
      ctx.globalAlpha = 1;

      // Keep the card beside the active star.
      const card = cardRef.current;
      if (card && active >= 0 && pos[active] && !card.classList.contains('docked')) {
        const p = pos[active];
        const rr = g.nodes[active].r * L.cam.s;
        const cw = card.offsetWidth;
        const ch = card.offsetHeight;
        // Sit on the side with fewer neighbours, so the lit links stay visible.
        let lean = 0;
        for (const j of near ?? []) lean += Math.sign(pos[j].x - p.x);
        const gap = Math.max(rr + 18, activeLabelHalf + 14);
        const right = p.x + gap;
        const left = p.x - gap - cw;
        let x = lean > 0 && left > 12 ? left : right;
        if (x + cw > w - 12) x = left;
        let y = p.y - ch / 2;
        y = Math.max(76, Math.min(h - ch - 12, y));
        x = Math.max(12, x);
        card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const settledRef = useRef(settled);
  settledRef.current = settled;
  useEffect(() => {
    live.current.dirty = true;
  }, [focus, hover, shown, pinned]);
  useEffect(() => {
    if (settled) fit();
  }, [settled, fit]);
  useEffect(() => {
    fit();
  }, [shown, fit]);

  // Bring a keyboard-focused star into view.
  const reveal = useCallback((i: number) => {
    const g = graphRef.current;
    if (!g || i < 0) return;
    const q = proj(g.nodes[i]);
    const s = toScreen(q.x, q.y);
    const { w, h, cam } = live.current;
    const margin = 120;
    if (s.x < margin || s.y < margin + 40 || s.x > w - margin || s.y > h - margin) {
      live.current.autoFit = false;
      live.current.goal = { x: q.x, y: q.y, s: cam.s };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = useCallback((i: number) => {
    const g = graphRef.current;
    if (!g || i < 0) return;
    const n = g.nodes[i];
    if (n.kind === 'person') {
      const seed = lib.items.find((it) => it.id === n.lastItemId) as Item | undefined;
      if (!seed) return;
      close();
      openPerson(seed);
    } else if (n.kind === 'source') {
      close();
      r.setPageId(null);
      r.setSpec((s) => ({ ...s, sources: [n.ref], excludeSources: s.excludeSources.filter((x) => x !== n.ref) }), `show only ${n.label}`);
      r.toast(`Showing only ${n.label}`, { action: { label: 'Undo', run: () => void r.undo() } });
    } else {
      close();
      r.setPageId(null);
      r.setSpec((s) => ({ ...s, topics: [n.ref] }), `show only ${n.label}`);
      r.toast(`Showing only ${n.label}`, { action: { label: 'Undo', run: () => void r.undo() } });
    }
  }, [lib.items, close, r]);

  const describe = useCallback((n: CNode) => {
    const where = n.kind === 'person' ? (n.platform ? `, ${platformLabel(n.platform)}` : '') : n.kind === 'source' ? `, ${platformLabel(n.platform ?? 'web')}` : '';
    return `${n.label}, ${KIND_LABEL[n.kind].toLowerCase()}${where}. ${statsLine(n)}, ${plural(n.posts, 'post')} in ${graph?.days ?? 90} days.`;
  }, [graph]);

  const moveFocus = useCallback((i: number) => {
    const g = graphRef.current;
    if (!g || i < 0) return;
    setFocus(i);
    setHover(-1);
    reveal(i);
    setAnnounce(describe(g.nodes[i]));
  }, [reveal, describe]);

  // Keys, captured first so the feed underneath does not also act on them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      const g = graphRef.current;
      const onSky = t === skyRef.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (pinned) { setPinned(false); setFocus(-1); return; }
        close();
        return;
      }
      if (!g) return;
      const dirs: Record<string, 'left' | 'right' | 'up' | 'down'> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
      if (onSky && dirs[e.key]) {
        e.preventDefault();
        e.stopPropagation();
        const cur = live.current.focus;
        if (cur < 0) {
          const first = g.nodes.map((_, i) => i).filter(visible).sort((a, b) => g.nodes[b].weight - g.nodes[a].weight)[0];
          moveFocus(first ?? -1);
          return;
        }
        const next = neighbourIn(g.nodes.map(proj), cur, dirs[e.key], visible);
        if (next >= 0) moveFocus(next);
        return;
      }
      if (onSky && e.key === 'Enter' && live.current.focus >= 0) {
        e.preventDefault();
        e.stopPropagation();
        open(live.current.focus);
        return;
      }
      if (onSky && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_')) {
        e.preventDefault();
        e.stopPropagation();
        const k = e.key === '+' || e.key === '=' ? 1.25 : 0.8;
        const c = live.current.cam;
        live.current.autoFit = false;
        live.current.goal = { x: c.x, y: c.y, s: Math.max(0.25, Math.min(5, c.s * k)) };
        return;
      }
      if (onSky && e.key === '0') {
        e.preventDefault();
        e.stopPropagation();
        fit();
        return;
      }
      // Everything else stays inside: the feed's single-letter keys must not fire under the sky.
      if (e.key.length === 1) e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close, pinned, visible, moveFocus, open, fit]);

  // Pointer: drag to pan, wheel or pinch to zoom, hover to look, click (or tap) to open.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ moved: false, startX: 0, startY: 0, pinch: 0 });
  const local = (e: { clientX: number; clientY: number }) => {
    const b = skyRef.current!.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    skyRef.current?.setPointerCapture(e.pointerId);
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    gesture.current = { moved: false, startX: p.x, startY: p.y, pinch: 0 };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current.pinch = Math.hypot(a.x - b.x, a.y - b.y);
      gesture.current.moved = true;
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e);
    const prev = pointers.current.get(e.pointerId);
    if (!prev) {
      if (e.pointerType === 'mouse' && !pinned) {
        const i = hitTest(p.x, p.y);
        if (i !== live.current.hover) setHover(i);
        skyRef.current!.style.cursor = i >= 0 ? 'pointer' : 'grab';
      }
      return;
    }
    const L = live.current;
    if (pointers.current.size === 2) {
      pointers.current.set(e.pointerId, p);
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (gesture.current.pinch > 0) {
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        zoomAt(mid.x, mid.y, d / gesture.current.pinch);
      }
      gesture.current.pinch = d;
      return;
    }
    if (!gesture.current.moved && Math.hypot(p.x - gesture.current.startX, p.y - gesture.current.startY) < 5) return;
    gesture.current.moved = true;
    L.autoFit = false;
    L.goal = null;
    L.cam.x -= (p.x - prev.x) / L.cam.s;
    L.cam.y -= (p.y - prev.y) / L.cam.s;
    L.dirty = true;
    pointers.current.set(e.pointerId, p);
    skyRef.current!.style.cursor = 'grabbing';
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const had = pointers.current.delete(e.pointerId);
    if (!had || gesture.current.moved || pointers.current.size) {
      if (skyRef.current) skyRef.current.style.cursor = 'grab';
      return;
    }
    const p = local(e);
    const i = hitTest(p.x, p.y);
    if (e.pointerType === 'mouse') {
      if (i >= 0) open(i);
      return;
    }
    // Touch: a tap shows the card; its button opens.
    if (i >= 0) {
      setFocus(i);
      setPinned(true);
      setAnnounce(graphRef.current ? describe(graphRef.current.nodes[i]) : '');
    } else {
      setPinned(false);
      setFocus(-1);
    }
  };
  const zoomAt = (sx: number, sy: number, k: number) => {
    const L = live.current;
    const before = toWorld(sx, sy);
    L.autoFit = false;
    L.goal = null;
    L.cam.s = Math.max(0.25, Math.min(5, L.cam.s * k));
    const after = toWorld(sx, sy);
    L.cam.x += before.x - after.x;
    L.cam.y += before.y - after.y;
    L.dirty = true;
  };
  useEffect(() => {
    const el = skyRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = hover >= 0 ? hover : focus;
  const node = graph && active >= 0 ? graph.nodes[active] : null;
  const counts = useMemo(() => {
    const c: Record<NodeKind, number> = { person: 0, source: 0, topic: 0 };
    for (const n of graph?.nodes ?? []) c[n.kind]++;
    return c;
  }, [graph]);
  const sorted = useMemo(() => (graph ? graph.nodes.map((n, i) => ({ n, i })).sort((a, b) => b.n.weight - a.n.weight) : []), [graph]);
  const where = r.profile?.name ?? 'everything you follow';
  const empty = graph && graph.nodes.length < 3;

  return (
    <div ref={dlg} className="cst" role="dialog" aria-modal="true" aria-labelledby="cst-title">
      <div
        ref={skyRef}
        className={`cst-sky ${focus >= 0 ? 'has-focus' : ''}`}
        tabIndex={0}
        role="application"
        aria-roledescription="map"
        aria-label="Constellation map. Arrow keys move between stars, Enter opens one, plus and minus zoom, 0 fits the whole sky."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={(e) => pointers.current.delete(e.pointerId)}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse' && !pinned) setHover(-1); }}
      >
        <canvas ref={canvasRef} aria-hidden />
      </div>

      <header className="cst-head">
        <div className="cst-title">
          <p className="cst-kicker">Constellation</p>
          <h2 id="cst-title">Your reading sky</h2>
          <p className="cst-sub">
            {graph
              ? <>{graph.days} days<span className="cst-where"> in {where}</span> · {plural(counts.person, 'person', 'people')}, {plural(counts.source, 'source')}, {plural(counts.topic, 'topic')}</>
              : 'Charting your sky…'}
          </p>
        </div>
        <div className="cst-tools">
          <div className="cst-legend" role="group" aria-label="Show on the map">
            {(['person', 'source', 'topic'] as NodeKind[]).map((k) => (
              <button key={k} className={`cst-chip cst-chip-${k} ${shown[k] ? 'on' : ''}`} aria-pressed={shown[k]} onClick={() => setShown((s) => ({ ...s, [k]: !s[k] }))}>
                <span className="cst-glyph" aria-hidden />
                {KIND_PLURAL[k]}
              </button>
            ))}
          </div>
          <button className="icon-btn cst-btn" onClick={fit} aria-label="Fit the whole sky" data-tip="Fit  0"><Icon name="expand" /></button>
          <button className="icon-btn cst-btn" onClick={close} aria-label="Close Constellation"><Icon name="x" /></button>
        </div>
      </header>

      {empty && (
        <div className="cst-empty">
          <h3>Not much to map yet</h3>
          <p>Read, save and highlight for a few days, and the people and sources you care about will light up here.</p>
          <button className="btn primary" onClick={close}>Back to the feed</button>
        </div>
      )}

      {node && (
        <div ref={cardRef} className={`cst-card cst-card-${node.kind} ${pinned ? 'docked' : ''}`} style={{ ['--c' as string]: node.kind === 'topic' ? undefined : `var(--hue-${node.platform ?? 'web'}, var(--hue-web))` }}>
          <p className="cst-card-kind">
            {KIND_LABEL[node.kind]}
            {node.kind !== 'topic' && node.platform ? ` · ${platformLabel(node.platform)}` : ''}
          </p>
          <h3>{node.label}</h3>
          {node.kind === 'person' && node.sub && <p className="cst-card-sub">{node.sub}</p>}
          <p className="cst-card-stats"><strong>{statsLine(node)}</strong><span>{plural(node.posts, 'post')} in {graph!.days} days</span></p>
          {node.lastText && (
            <p className="cst-card-last">
              <span className="cst-card-quote">{node.lastText}</span>
              {node.lastAt && <span className="cst-card-when">{agoText(node.lastAt)}</span>}
            </p>
          )}
          <button className="btn primary cst-open" onClick={() => open(active)} tabIndex={pinned ? 0 : -1}>
            {node.kind === 'person' ? `Everything from ${node.label.split(' ')[0]}` : `Show only ${node.label}`}
            {!pinned && <kbd>Enter</kbd>}
          </button>
        </div>
      )}

      <p className="cst-hint" aria-hidden>
        <span><kbd>←</kbd><kbd>→</kbd> travel</span>
        <span><kbd>Enter</kbd> open</span>
        <span>Scroll to zoom, drag to pan</span>
      </p>
      {graph && !empty && (
        <p className="cst-total" aria-hidden>
          You did something with {graph.engaged.toLocaleString()} of {graph.posts.toLocaleString()} posts
        </p>
      )}

      {/* The same stars as a list, for screen readers. */}
      <ul className="sr-only" aria-label="Stars on the map, brightest first">
        {sorted.map(({ n, i }) => (
          <li key={n.id}>
            <button tabIndex={-1} onClick={() => open(i)}>{describe(n)}</button>
          </li>
        ))}
      </ul>
      <p className="sr-only" aria-live="polite">{announce}</p>
    </div>
  );
}

/** The ground: a deep gradient, slow aurora ribbons and a field of faint stars. */
function paintSky(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, pal: Palette, cam: { x: number; y: number; s: number }, still: boolean) {
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = pal.ground;
  ctx.fillRect(0, 0, w, h);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  if (pal.dark) {
    g.addColorStop(0, 'rgba(18, 22, 48, 0.55)');
    g.addColorStop(0.6, 'rgba(8, 10, 22, 0.2)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
  } else {
    g.addColorStop(0, 'rgba(255, 236, 222, 0.6)');
    g.addColorStop(0.7, 'rgba(236, 232, 255, 0.35)');
    g.addColorStop(1, 'rgba(255, 255, 255, 0)');
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Aurora ribbons: three soft blobs from the theme's lit gradient, drifting very slowly.
  const tt = still ? 0 : t / 1000;
  const blobs = [
    { c: pal.lit[0], x: 0.18 + Math.sin(tt / 23) * 0.06, y: 0.16 + Math.cos(tt / 29) * 0.04, r: 0.55 },
    { c: pal.lit[1], x: 0.62 + Math.cos(tt / 31) * 0.07, y: 0.1 + Math.sin(tt / 27) * 0.05, r: 0.5 },
    { c: pal.lit[2], x: 0.86 + Math.sin(tt / 37) * 0.05, y: 0.42 + Math.cos(tt / 33) * 0.06, r: 0.48 },
  ];
  ctx.globalCompositeOperation = pal.dark ? 'lighter' : 'multiply';
  for (const b of blobs) {
    const R = Math.max(w, h) * b.r;
    const rg = ctx.createRadialGradient(b.x * w, b.y * h, 0, b.x * w, b.y * h, R);
    rg.addColorStop(0, withAlpha(b.c, pal.dark ? 0.2 : 0.12));
    rg.addColorStop(1, withAlpha(b.c, 0));
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.globalCompositeOperation = 'source-over';

  // Background stars with a touch of parallax, so panning feels like looking around.
  const starCol = pal.dark ? '#ffffff' : pal.ink3;
  for (const s of STARS) {
    const px = (((s.x * w - cam.x * cam.s * s.depth * 0.08) % w) + w) % w;
    const py = (((s.y * h - cam.y * cam.s * s.depth * 0.08) % h) + h) % h;
    const a = (pal.dark ? 0.55 : 0.28) * s.depth * (still ? 1 : 0.6 + 0.4 * Math.sin(t / 1400 + s.ph));
    ctx.fillStyle = withAlpha(starCol.startsWith('#') ? starCol : '#868e9c', a);
    ctx.beginPath();
    ctx.arc(px, py, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
}
