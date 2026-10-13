// Pages: screens the AI composes from blocks (feeds, galleries, people, stats, notes, digests)
// and bespoke widgets that run sandboxed with no network.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { applyFilters, normalizeSpec, type Evaluation } from '../../core/filter.ts';
import type { FilterSpec, Item, Page, PageBlock } from '../../core/types.ts';
import { api } from './api.ts';
import { Icon } from './icons.tsx';
import { PostMini, RichText } from './rich.tsx';
import type { Reader } from './state.ts';
import { platformLabel, agoText } from './format.ts';
import { canListen, pageParts, speaker, useSpeaker, type ListenPart } from './Listen.tsx';
import { listen, pageEntry } from './listenQueue.ts';

export const PAGE_ICONS = new Set(['star', 'image', 'chart', 'people', 'news', 'video', 'music', 'map', 'code', 'heart', 'bolt', 'page']);
export const pageIcon = (p: Page) => (p.icon && PAGE_ICONS.has(p.icon) ? p.icon : 'page');

function useBlockItems(r: Reader, spec: Partial<FilterSpec> | undefined) {
  const lib = r.lib!;
  return useMemo(() => applyFilters(lib.items, normalizeSpec(spec ?? {}), { topics: lib.topics, sourceLabels: r.sourceLabels, ai: { rules: lib.aiRules, labels: lib.labels } }), [lib, r.sourceLabels, spec]);
}

export function PageView({
  r, page, renderPost, onAsk, onOpenPost, phone,
}: {
  r: Reader; page: Page; renderPost: (ev: Evaluation, compact: boolean) => ReactNode; onAsk: (text: string) => void; onOpenPost: (it: Item) => void; phone: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  const sp = useSpeaker();
  const parts = useMemo(() => pageParts(page.blocks), [page.blocks]);
  const listenable = canListen && page.blocks.some((b) => b.type === 'digest');
  useEffect(() => () => speaker.stop(), [page.id]);
  return (
    <main className="feed page-view" aria-label={page.name}>
      <header className="feed-bar">
        <div className="feed-bar-in">
          <h1 className="feed-title"><Icon name={pageIcon(page)} size={18} /> <span>{page.name}</span></h1>
          <div className="page-tools">
            {listenable && <ListenButton parts={parts} scope={`page:${page.id}`} label="Listen" />}
            {listenable && <button className="btn small ghost" onClick={() => listen.add(pageEntry(page))} title="Add this page to the listen queue"><Icon name="headphones" size={15} /> Queue</button>}
            {page.id.startsWith('morning-edition') && <RefreshEdition r={r} />}
            <button className="btn small ghost" onClick={() => onAsk(`On the page “${page.name}”, `)}><Icon name="sparkle" size={15} /> Change with AI</button>
            {confirm ? (
              <button className="btn small danger" onClick={async () => { await api.deletePage(page.id); r.setPageId(null); await r.reload(); r.toast(`Deleted page “${page.name}”`); }}>Delete page?</button>
            ) : (
              <button className="icon-btn" aria-label="Delete page" title="Delete page" onClick={() => setConfirm(true)}><Icon name="trash" size={17} /></button>
            )}
          </div>
        </div>
      </header>
      <div className="page-col">
        {sp.status !== 'idle' && sp.scope?.startsWith(`page:${page.id}`) && (
          <div className="listen-bar" role="status">
            <span className={`listen-wave ${sp.status}`} aria-hidden><i /><i /><i /><i /></span>
            <span className="listen-now">{sp.status === 'paused' ? 'Paused' : 'Reading'} <strong>{sp.label}</strong></span>
            <button className="btn small ghost" onClick={() => (sp.status === 'paused' ? speaker.resume() : speaker.pause())}><Icon name={sp.status === 'paused' ? 'play' : 'pause'} size={14} /> {sp.status === 'paused' ? 'Resume' : 'Pause'}</button>
            <button className="btn small ghost" onClick={() => speaker.stop()}><Icon name="x" size={14} /> Stop</button>
          </div>
        )}
        {page.blocks.length === 0 && <div className="empty"><p className="empty-title">This page is empty.</p><p>Ask the AI to fill it.</p></div>}
        {page.blocks.map((b, i) => (
          <Block key={`${page.id}-${i}-${b.type}`} r={r} page={page} idx={i} block={b} renderPost={renderPost} onOpenPost={onOpenPost} phone={phone} reading={sp.status !== 'idle' && !!sp.scope?.startsWith(`page:${page.id}`) && sp.key === String(i)} />
        ))}
        <p className="page-foot">Built {agoText(page.createdAt)}{page.updatedAt !== page.createdAt ? ` · changed ${agoText(page.updatedAt)}` : ''} · ask the AI to change anything here</p>
      </div>
    </main>
  );
}

function RefreshEdition({ r }: { r: Reader }) {
  const [busy, setBusy] = useState(false);
  return (
    <button className="btn small ghost" disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const out = await api.buildEdition(r.profileId);
        await r.reload();
        r.toast(out.message);
      } catch (e) {
        r.toast((e as Error).message, { tone: 'error' });
      } finally {
        setBusy(false);
      }
    }}>
      {busy ? <span className="spin" aria-hidden /> : <Icon name="sync" size={15} />} {busy ? 'Writing…' : 'Fresh edition'}
    </button>
  );
}

/** Listen / Pause / Resume for one reading scope (a whole page, or one digest block). */
function ListenButton({ parts, scope, label }: { parts: ListenPart[]; scope: string; label: string }) {
  const sp = useSpeaker();
  const mine = sp.status !== 'idle' && sp.scope === scope;
  if (!canListen || !parts.length) return null;
  return (
    <button
      className={`btn small ghost listen-btn ${mine ? 'on' : ''}`}
      aria-pressed={mine}
      onClick={() => (!mine ? speaker.play(parts, scope) : sp.status === 'paused' ? speaker.resume() : speaker.pause())}
      title={mine ? undefined : 'Read it aloud with your browser\'s voice'}
    >
      <Icon name={mine && sp.status === 'playing' ? 'pause' : 'play'} size={14} /> {mine ? (sp.status === 'paused' ? 'Resume' : 'Pause') : label}
    </button>
  );
}

function Block({ r, page, idx, block, renderPost, onOpenPost, phone, reading }: { r: Reader; page: Page; idx: number; block: PageBlock; renderPost: (ev: Evaluation, compact: boolean) => ReactNode; onOpenPost: (it: Item) => void; phone: boolean; reading?: boolean }) {
  switch (block.type) {
    case 'hero':
      return (
        <section className={`pb hero-block ${reading ? 'reading' : ''}`}>
          <h2 className="pb-hero">{block.title}</h2>
          {block.subtitle && <p className="pb-sub">{block.subtitle}</p>}
        </section>
      );
    case 'note':
      return (
        <section className="pb card-block note-block">
          {block.title && <h3 className="pb-title">{block.title}</h3>}
          <div className="rich"><RichText text={block.text ?? ''} /></div>
        </section>
      );
    case 'digest':
      return <DigestBlock r={r} block={block} onOpenPost={onOpenPost} scope={`page:${page.id}:${idx}`} idx={idx} reading={reading} />;
    case 'feed':
      return <FeedBlock r={r} block={block} renderPost={renderPost} />;
    case 'gallery':
      return <GalleryBlock r={r} block={block} />;
    case 'people':
      return <PeopleBlock r={r} block={block} />;
    case 'stats':
      return <StatsBlock r={r} block={block} />;
    case 'widget':
      return <WidgetBlock r={r} page={page} idx={idx} block={block} phone={phone} />;
    default:
      return null;
  }
}

function FeedBlock({ r, block, renderPost }: { r: Reader; block: Extract<PageBlock, { type: 'feed' }>; renderPost: (ev: Evaluation, compact: boolean) => ReactNode }) {
  const res = useBlockItems(r, block.spec);
  const [more, setMore] = useState(false);
  const limit = Math.max(1, Math.min(block.limit ?? 20, 200));
  const list = res.visible.slice(0, more ? limit * 3 : limit);
  return (
    <section className={`pb feed-block layout-${block.layout ?? 'timeline'}`}>
      {block.title && <h3 className="pb-title">{block.title} <small>{res.visible.length.toLocaleString()}</small></h3>}
      {list.length === 0 ? (
        <p className="pb-empty">No posts match yet.</p>
      ) : block.layout === 'grid' ? (
        <div className="pb-grid">
          {list.map((ev) => <GridCard key={ev.item.id} it={ev.item} />)}
        </div>
      ) : (
        <div className="posts">{list.map((ev) => renderPost(ev, block.layout === 'compact'))}</div>
      )}
      {res.visible.length > list.length && !more && <button className="btn small ghost pb-more" onClick={() => setMore(true)}>Show more</button>}
    </section>
  );
}

function GridCard({ it }: { it: Item }) {
  const img = it.media.find((m) => m.type === 'image') ?? it.media.find((m) => m.thumb);
  return (
    <a className="grid-card" href={it.url} target="_blank" rel="noopener noreferrer" style={{ '--av': `var(--hue-${it.platform}, var(--hue-import))` } as React.CSSProperties}>
      {img ? <img src={img.thumb ?? img.url} alt={img.alt ?? ''} loading="lazy" referrerPolicy="no-referrer" /> : <span className="grid-noimg" />}
      <span className="grid-meta">
        <b>{it.title ?? it.author.name}</b>
        <small>{(it.title ? it.author.name : it.text.replace(/\s+/g, ' ')).slice(0, 90)}</small>
      </span>
    </a>
  );
}

function GalleryBlock({ r, block }: { r: Reader; block: Extract<PageBlock, { type: 'gallery' }> }) {
  const res = useBlockItems(r, block.spec);
  const tiles = useMemo(() => {
    const out: { key: string; src: string; href: string; alt: string; video: boolean; who: string }[] = [];
    for (const ev of res.visible) {
      for (const m of ev.item.media) {
        const src = m.type === 'image' ? m.thumb ?? m.url : m.thumb;
        if (!src || !/^https:\/\//.test(src)) continue;
        out.push({ key: `${ev.item.id}-${src}`, src, href: m.type === 'video' ? ev.item.url : m.url, alt: m.alt ?? '', video: m.type === 'video', who: ev.item.author.name });
        if (out.length >= (block.limit ?? 60)) return out;
      }
    }
    return out;
  }, [res.visible, block.limit]);
  return (
    <section className="pb gallery-block">
      {block.title && <h3 className="pb-title">{block.title} <small>{tiles.length}</small></h3>}
      {tiles.length === 0 ? <p className="pb-empty">No pictures match yet.</p> : (
        <div className="mosaic">
          {tiles.map((t) => (
            <a key={t.key} className="tile" href={/^https:\/\//.test(t.href) ? t.href : undefined} target="_blank" rel="noopener noreferrer" title={t.who}>
              <img src={t.src} alt={t.alt} loading="lazy" referrerPolicy="no-referrer" onError={(e) => ((e.currentTarget.parentElement as HTMLElement).style.display = 'none')} />
              {t.video && <span className="tile-play"><Icon name="play" size={14} /></span>}
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

function PeopleBlock({ r, block }: { r: Reader; block: Extract<PageBlock, { type: 'people' }> }) {
  const res = useBlockItems(r, block.spec);
  const people = useMemo(() => {
    const m = new Map<string, { it: Item; n: number; unread: number }>();
    for (const ev of res.visible) {
      const k = (ev.item.author.handle ?? ev.item.author.name).toLowerCase();
      const cur = m.get(k);
      if (cur) {
        cur.n++;
        if (!ev.item.state.read) cur.unread++;
        if (!cur.it.author.avatar && ev.item.author.avatar) cur.it = ev.item;
      } else m.set(k, { it: ev.item, n: 1, unread: ev.item.state.read ? 0 : 1 });
    }
    return [...m.values()].sort((a, b) => b.n - a.n).slice(0, block.limit ?? 24);
  }, [res.visible, block.limit]);
  return (
    <section className="pb people-block">
      {block.title && <h3 className="pb-title">{block.title}</h3>}
      {people.length === 0 ? <p className="pb-empty">Nobody here yet.</p> : (
        <div className="pb-people">
          {people.map(({ it, n, unread }) => (
            <button key={it.author.handle ?? it.author.name} className="pb-person" onClick={() => r.setSpec((s) => ({ ...s, authors: [it.author.handle ?? it.author.name] }), `only ${it.author.name}`)} style={{ '--av': `var(--hue-${it.platform}, var(--hue-import))` } as React.CSSProperties}>
              {it.author.avatar ? <img src={it.author.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="pp-init">{it.author.name.slice(0, 1).toUpperCase()}</span>}
              <b>{it.author.name}</b>
              <small>{n} {n === 1 ? 'post' : 'posts'}{unread ? ` · ${unread} new` : ''} · {platformLabel(it.platform)}</small>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function StatsBlock({ r, block }: { r: Reader; block: Extract<PageBlock, { type: 'stats' }> }) {
  const res = useBlockItems(r, block.spec);
  const rows = useMemo(() => {
    const m = new Map<string, number>();
    const add = (k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    if (block.metric === 'per_day') {
      const days: [string, number][] = [];
      const now = new Date();
      for (let i = 13; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        days.push([d.toISOString().slice(0, 10), 0]);
      }
      const idx = new Map(days.map(([d], i) => [d, i]));
      for (const ev of res.visible) {
        const d = new Date(ev.item.publishedAt);
        const key = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString().slice(0, 10);
        const i = idx.get(key);
        if (i !== undefined) days[i][1]++;
      }
      return days.map(([d, n]) => ({ label: new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }), n }));
    }
    for (const ev of res.visible) {
      const it = ev.item;
      if (block.metric === 'by_source') add(r.sourceLabels[it.sourceId] ?? platformLabel(it.platform));
      else if (block.metric === 'by_platform') add(platformLabel(it.platform));
      else if (block.metric === 'by_author') add(it.author.name);
      else if (block.metric === 'by_topic') for (const t of ev.topics) add(t.topicName);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, n]) => ({ label, n }));
  }, [res.visible, block.metric, r.sourceLabels]);
  const max = Math.max(1, ...rows.map((x) => x.n));
  return (
    <section className="pb card-block stats-block">
      {block.title && <h3 className="pb-title">{block.title}</h3>}
      {block.metric === 'per_day' ? (
        <div className="days">
          {rows.map((x, i) => (
            <div key={i} className="day" title={`${x.label}: ${x.n}`}>
              <span className="day-bar" style={{ height: `${Math.max(3, (x.n / max) * 100)}%` }} />
              <small>{x.label.split(' ')[0].slice(0, 2)}</small>
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? <p className="pb-empty">Nothing to count yet.</p> : (
        <div className="bars">
          {rows.map((x) => (
            <div key={x.label} className="bar-row">
              <span className="bar-label">{x.label}</span>
              <span className="bar-track"><span className="bar-fill" style={{ width: `${(x.n / max) * 100}%` }} /></span>
              <span className="bar-n">{x.n}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function DigestBlock({ r, block, onOpenPost, scope, idx, reading }: { r: Reader; block: Extract<PageBlock, { type: 'digest' }>; onOpenPost: (it: Item) => void; scope: string; idx: number; reading?: boolean }) {
  const byId = useMemo(() => new Map(r.lib!.items.map((i) => [i.id, i])), [r.lib]);
  const ids = [...new Set([...(block.postIds ?? []), ...[...(block.text ?? '').matchAll(/\[\[post:([^\]\s]+)\]\]/g)].map((m) => m[1])])].filter((id) => byId.has(id));
  return (
    <section className={`pb card-block digest-block ${reading ? 'reading' : ''}`}>
      <div className="digest-head">
        {block.title && <h3 className="pb-title"><Icon name="sparkle" size={15} /> {block.title}</h3>}
        <ListenButton parts={[{ key: String(idx), label: block.title ?? 'Summary', text: [block.title, block.text].filter(Boolean).join('. ') }]} scope={scope} label="Listen" />
      </div>
      <div className="rich">
        <RichText text={block.text ?? ''} cite={(id, n) => <button className="cite" onClick={() => { const it = byId.get(id); if (it) onOpenPost(it); }}>{n}</button>} />
      </div>
      {ids.length > 0 && <div className="cites">{ids.slice(0, 8).map((id, i) => <PostMini key={id} it={byId.get(id)} n={i + 1} onOpen={onOpenPost} />)}</div>}
      {block.generatedAt && <p className="pb-note">Written {agoText(block.generatedAt)}</p>}
    </section>
  );
}

/** The posts a widget receives. Plain data only; the widget cannot reach the network. */
function widgetPosts(r: Reader, items: Evaluation[]) {
  return items.slice(0, 400).map(({ item: it, topics }) => ({
    id: it.id, url: it.url, platform: it.platform, source: r.sourceLabels[it.sourceId] ?? null,
    author: { name: it.author.name, handle: it.author.handle ?? null, avatar: it.author.avatar ?? null },
    title: it.title ?? null, text: it.text.slice(0, 2000), publishedAt: it.publishedAt, kind: it.kind,
    media: it.media.slice(0, 6).map((m) => ({ type: m.type, url: m.url, thumb: m.thumb ?? null, alt: m.alt ?? null })),
    saved: it.state.saved, read: it.state.read, topics: topics.map((t) => t.topicName), lang: it.lang ?? null,
  }));
}

function themeTokens() {
  const cs = getComputedStyle(document.documentElement);
  const keys = ['ground', 'surface', 'raised', 'line', 'ink', 'ink-2', 'ink-3', 'lamp', 'lit', 'lit-soft', 'glow-on', 'card', 'card-line'];
  return { mode: document.documentElement.dataset.theme ?? 'dark', tokens: Object.fromEntries(keys.map((k) => [k, cs.getPropertyValue(`--${k}`).trim()])) };
}

function WidgetBlock({ r, page, idx, block, phone }: { r: Reader; page: Page; idx: number; block: Extract<PageBlock, { type: 'widget' }>; phone: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const res = useBlockItems(r, block.spec ?? {});
  const [h, setH] = useState(block.height ?? 360);
  const [loaded, setLoaded] = useState(0);
  const src = `/widget/${encodeURIComponent(page.id)}/${idx}?v=${encodeURIComponent(page.updatedAt)}`;

  // sr.open only opens links the widget was given: otherwise a widget could smuggle the posts it
  // was shown out to any site in a URL the moment you click inside it.
  const openable = useRef(new Set<string>());
  useEffect(() => {
    if (!loaded) return;
    const posts = widgetPosts(r, res.visible);
    openable.current = new Set(posts.flatMap((p) => [p.url, ...p.media.map((m) => m.url)]).filter((u): u is string => typeof u === 'string'));
    frame.current?.contentWindow?.postMessage({ type: 'sr-data', posts, theme: themeTokens(), page: { id: page.id, name: page.name } }, '*');
  }, [loaded, res.visible, r, page.id, page.name]);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || !e.data || typeof e.data !== 'object') return;
      if (e.data.type === 'sr-size' && !block.height) setH(Math.max(120, Math.min(2400, Number(e.data.h) || 0)));
      if (e.data.type === 'sr-open' && typeof e.data.url === 'string' && /^https:\/\//.test(e.data.url) && openable.current.has(e.data.url)) window.open(e.data.url, '_blank', 'noopener,noreferrer');
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [block.height]);

  return (
    <section className="pb widget-block">
      {block.title && <h3 className="pb-title">{block.title}</h3>}
      <div className="widget-frame">
        <iframe
          ref={frame}
          src={src}
          title={block.title ?? 'Widget'}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
          style={{ height: phone ? Math.min(h, 640) : h }}
          onLoad={() => setLoaded((n) => n + 1)}
        />
      </div>
    </section>
  );
}
