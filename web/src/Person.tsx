// Person pages: everything one person posted across your sources, gathered by name and handle.
// Any author name or avatar opens it. Actions only change local filters and views.

import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_SPEC } from '../../core/filter.ts';
import type { Item } from '../../core/types.ts';
import { api } from './api.ts';
import { agoText, platformLabel, plural } from './format.ts';
import { Icon } from './icons.tsx';
import { PostMini } from './rich.tsx';
import type { Reader } from './state.ts';
import { useDialog } from './useDialog.ts';

// A tiny bus so any author link, wherever it is rendered, can open the sheet.
const listeners = new Set<(it: Item) => void>();
export function openPerson(it: Item) {
  for (const fn of listeners) fn(it);
}
export function usePersonOpener(): [Item | null, (it: Item | null) => void] {
  const [it, setIt] = useState<Item | null>(null);
  useEffect(() => {
    listeners.add(setIt);
    return () => void listeners.delete(setIt);
  }, []);
  return [it, setIt];
}

const norm = (s: string) => s.trim().replace(/^@/, '').toLowerCase();
/** The key the filter engine matches authors on. */
const authorKey = (it: Item) => (it.author.handle ?? it.author.name).toLowerCase();

/** Posts by the same person: same handle, or same display name, one hop out. */
export function gatherPerson(items: Item[], seed: Item): Item[] {
  const names = new Set([norm(seed.author.name)]);
  const handles = new Set(seed.author.handle ? [norm(seed.author.handle)] : []);
  const match = (it: Item) => names.has(norm(it.author.name)) || (!!it.author.handle && handles.has(norm(it.author.handle)));
  for (const it of items.filter(match)) {
    if (it.author.handle) handles.add(norm(it.author.handle));
    // Very short names ("Al", "news") would pull in strangers; only longer names link handles.
    if (it.author.name.trim().length >= 5) names.add(norm(it.author.name));
  }
  return items.filter(match).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

const WEEKS = 26;
function weekly(posts: Item[]): number[] {
  const out = new Array(WEEKS).fill(0);
  const now = Date.now();
  for (const p of posts) {
    const w = Math.floor((now - Date.parse(p.publishedAt)) / (7 * 86_400_000));
    if (w >= 0 && w < WEEKS) out[WEEKS - 1 - w]++;
  }
  return out;
}

function Spark({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  return (
    <svg className="person-spark" viewBox={`0 0 ${data.length * 6} 32`} preserveAspectRatio="none" role="img" aria-label={`Posts per week over the last ${data.length} weeks, at most ${max}`}>
      {data.map((v, i) => {
        const h = v ? Math.max(3, (v / max) * 30) : 1.5;
        return <rect key={i} x={i * 6 + 1} y={32 - h} width={4} height={h} rx={1.5} className={v ? 'on' : ''} />;
      })}
    </svg>
  );
}

export function PersonSheet({ r, seed, close, ask, openPost }: { r: Reader; seed: Item; close: () => void; ask: (text: string, send?: boolean) => void; openPost: (it: Item) => void }) {
  const dlg = useDialog<HTMLDivElement>();
  const lib = r.lib!;
  const posts = useMemo(() => gatherPerson(lib.items, seed), [lib.items, seed]);
  const keys = useMemo(() => [...new Set(posts.map(authorKey))], [posts]);
  const handles = useMemo(() => {
    const m = new Map<string, { handle: string; platform: Item['platform']; url?: string }>();
    for (const p of posts) if (p.author.handle && !m.has(p.platform + norm(p.author.handle))) m.set(p.platform + norm(p.author.handle), { handle: p.author.handle, platform: p.platform, url: p.author.url });
    return [...m.values()];
  }, [posts]);
  const sources = useMemo(() => {
    const c = new Map<string, number>();
    for (const p of posts) c.set(p.sourceId, (c.get(p.sourceId) ?? 0) + 1);
    return [...c].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ label: lib.sources.find((s) => s.id === id)?.label ?? 'Unknown source', n }));
  }, [posts, lib.sources]);
  const avatar = posts.find((p) => p.author.avatar)?.author.avatar;
  const name = seed.author.name;
  const saved = posts.filter((p) => p.state.saved).length;
  const first = posts[posts.length - 1]?.publishedAt;
  const last = posts[0]?.publishedAt;
  const profile = posts.find((p) => p.author.url)?.author.url;
  const [about, setAbout] = useState<string | null>(null);
  const [limit, setLimit] = useState(30);

  useEffect(() => {
    if (posts.length < 2) return;
    let live = true;
    api.personAbout(keys[0], posts.slice(0, 40).map((p) => p.id)).then((x) => live && setAbout(x.about || null)).catch(() => {});
    return () => {
      live = false;
    };
  }, [keys, posts]);

  const only = () => {
    r.setPageId(null);
    r.setSpec((s) => ({ ...s, authors: keys, excludeAuthors: s.excludeAuthors.filter((a) => !keys.includes(a.toLowerCase())) }), `only ${name}`);
    close();
  };
  const hide = () => {
    r.setSpec((s) => ({ ...s, excludeAuthors: [...new Set([...s.excludeAuthors, ...keys])], authors: s.authors.filter((a) => !keys.includes(a.toLowerCase())) }), `hide ${name}`);
    r.toast(`${name} is hidden. Undo from the rules pane.`);
    close();
  };
  const saveView = async () => {
    const v = await api.saveView({ name: name.slice(0, 60), spec: { ...DEFAULT_SPEC, authors: keys, archived: 'any' } });
    await r.reload();
    r.setPageId(null);
    r.setViewId(v.id);
    r.toast(`Saved “${v.name}” as a view`);
    close();
  };
  const muted = keys.some((k) => r.spec.excludeAuthors.some((a) => a.toLowerCase() === k));

  return (
    <div className="sheet-backdrop" onClick={close}>
      <div ref={dlg} className="sheet person-sheet" role="dialog" aria-modal="true" aria-label={`About ${name}`} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Person</h2>
          <button className="icon-btn" onClick={close} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="sheet-body">
          <header className="person-hero">
            {avatar ? <img className="person-av" src={avatar} alt="" referrerPolicy="no-referrer" /> : <span className="person-av blank" aria-hidden>{(name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()}</span>}
            <div className="person-id">
              <h3>{name}</h3>
              <p className="person-handles">
                {handles.map((h) => (
                  <span key={h.platform + h.handle} className="person-handle">@{h.handle.replace(/^@/, '')} <span className="dim">{platformLabel(h.platform)}</span></span>
                ))}
              </p>
            </div>
          </header>
          {about && <p className="person-about"><Icon name="sparkle" size={13} /> {about}</p>}
          <dl className="person-stats">
            <div><dt>Posts</dt><dd>{posts.length.toLocaleString()}</dd></div>
            <div><dt>Saved</dt><dd>{saved}</dd></div>
            <div><dt>First seen</dt><dd>{first ? agoText(first).replace(/^on /, '') : '–'}</dd></div>
            <div><dt>Latest</dt><dd>{last ? agoText(last).replace(/^on /, '') : '–'}</dd></div>
          </dl>
          <div className="person-activity">
            <Spark data={weekly(posts)} />
            <span className="dim">Last 6 months</span>
          </div>
          <p className="person-sources">From {sources.map((s) => `${s.label} (${s.n})`).join(' · ')}</p>
          <div className="person-actions">
            <button className="btn small primary" onClick={only}><Icon name="people" size={15} /> Only show them</button>
            <button className="btn small" onClick={() => void saveView()}><Icon name="layers" size={15} /> Save as view</button>
            <button className="btn small" onClick={() => { ask(`Tell me about ${name} from my library: what they post about lately, what I saved from them, and what is worth reading.`); close(); }}><Icon name="sparkle" size={15} /> Ask about them</button>
            {!muted && <button className="btn small ghost" onClick={hide}><Icon name="eyeOff" size={15} /> Hide them</button>}
            {profile && <a className="btn small ghost" href={profile} target="_blank" rel="noopener noreferrer"><Icon name="external" size={15} /> Profile</a>}
          </div>
          <h4 className="eyebrow person-list-head">{plural(posts.length, 'post')}, newest first</h4>
          <div className="person-posts">
            {posts.slice(0, limit).map((p) => <PostMini key={p.id} it={p} onOpen={(it) => { openPost(it); close(); }} />)}
          </div>
          {posts.length > limit && <button className="btn small ghost" onClick={() => setLimit((n) => n + 30)}>Show more</button>}
        </div>
      </div>
    </div>
  );
}
