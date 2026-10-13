// Command palette (⌘K / Ctrl+K): one box to jump anywhere or do anything. Views, pages, sources,
// people, topics, AI rules, actions, themes and posts are matched with a small fuzzy scorer; the
// last row always hands the text to the agent. Everything here is local navigation.

import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_SPEC } from '../../core/filter.ts';
import type { Item } from '../../core/types.ts';
import { Icon } from './icons.tsx';
import { LOGIN_URLS } from './Login.tsx';
import { BUILTIN_VIEWS, type Reader } from './state.ts';
import { THEME_PRESETS } from './themes.ts';
import { useDialog } from './useDialog.ts';
import { openWeek } from './week.ts';
import { openAmbient } from './ambient.ts';
import { useFullText } from './Search.tsx';
import { listen } from './listenQueue.ts';
import { openQuickLook } from './quickBus.ts';
import { openConstellation } from './ConstellationEntry.tsx';
import { openFrontPage } from './FrontPageEntry.tsx';

export interface PaletteActions {
  openPanel: (p: 'sources' | 'workshop' | 'ai' | 'look' | 'help' | 'filters' | 'follows' | 'whatsnew' | 'routines' | 'onthisday' | 'report' | 'alerts' | 'triage' | 'time') => void;
  toggleTheme: () => void;
  theme: 'dark' | 'light';
  toggleDensity: () => void;
  pickLook: (preset: string) => void;
  openPost: (it: Item) => void;
  openPerson: (it: Item) => void;
  ask: (text: string, send?: boolean) => void;
  signIn: (profile: string, url: string) => void;
  syncAll: () => void;
  edition: () => void;
  toggleColumns: () => void;
  columnsOn: boolean;
  newProfile: () => void;
  editProfile: () => void;
}

interface Row {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: string;
  keywords?: string;
  run: () => void;
  avatar?: string | null;
}

/** Subsequence score: 0 when not all letters appear in order. Rewards prefixes and word starts. */
export function fuzzy(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx === 0) return 100 - Math.min(t.length, 40) / 4;
  if (idx > 0) return (/[\s\-_/@.]/.test(t[idx - 1]) ? 80 : 60) - Math.min(t.length, 40) / 4;
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return 0;
    run = at === ti ? run + 1 : 0;
    score += 1 + run * 2 + (at === 0 || /[\s\-_/@.]/.test(t[at - 1]) ? 4 : 0);
    ti = at + 1;
  }
  // Best case (every letter starts a word or continues a run) lands near 50; scattered letters stay low.
  return Math.min(50, (score / (q.length * 7)) * 50);
}

const GROUP_ORDER = ['Actions', 'Profiles', 'Views', 'Pages', 'Sources', 'People', 'Topics', 'AI rules', 'Themes', 'Sign in', 'Posts'];

export function Palette({ r, close, a }: { r: Reader; close: () => void; a: PaletteActions }) {
  const dlg = useDialog<HTMLDivElement>();
  const [q, setQ] = useState('');
  const [cur, setCur] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const lib = r.lib;
  // Ranked full-text matches from the server; the local scan below fills in until they arrive.
  const fts = useFullText(q, { limit: 8, delay: 90, profile: r.profileId });
  const done = (fn: () => void) => () => {
    close();
    fn();
  };

  const base = useMemo<Row[]>(() => {
    if (!lib) return [];
    const rows: Row[] = [];
    const act = (id: string, label: string, icon: string, run: () => void, keywords = '', hint?: string) => rows.push({ id: `a:${id}`, group: 'Actions', label, icon, run, keywords, hint });
    act('listen', 'Listen to Read later', 'headphones', () => void listen.playReadLater(), 'audio speak aloud podcast tts queue play', 'p');
    act('sync', 'Sync all sources', 'sync', a.syncAll, 'refresh update fetch');
    act('workshop', 'Open the Workshop', 'wrench', () => a.openPanel('workshop'), 'connectors actors build');
    act('ai', 'AI settings', 'sparkle', () => a.openPanel('ai'), 'provider model key edition archive feeds mcp');
    act('look', 'Look & themes', 'star', () => a.openPanel('look'), 'theme colours colors appearance');
    act('sources', 'Sources & imports', 'layers', () => a.openPanel('sources'), 'add feed import follow', 'g');
    act('report', 'Source report cards', 'chart', () => a.openPanel('report'), 'sources stats drop unfollow noise report card which sources earn');
    act('follows', 'Bring your follows', 'people', () => a.openPanel('follows'), 'import follows subscriptions following youtube instagram tiktok mastodon reddit substack bluesky takeout export');
    act('filters', 'All filters', 'sliders', () => a.openPanel('filters'), 'rules mute keywords', 'f');
    act('mode', a.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode', a.theme === 'dark' ? 'sun' : 'moon', a.toggleTheme, 'theme dark light');
    act('density', 'Toggle compact feed', 'ul', a.toggleDensity, 'density dense comfortable', 'd');
    act('edition', 'Morning edition', 'news', a.edition, 'digest daily newspaper summary');
    act('columns', a.columnsOn ? 'Back to one feed' : 'Columns', 'columns', a.toggleColumns, 'columns tiling deck tweetdeck side by side multi column split hyprland', 'c');
    act('quick', 'Quick look', 'bolt', openQuickLook, 'spotlight raycast popup mini small window glance top posts shortcut');
    act('ambient', 'Ambient', 'image', () => openAmbient({ fullscreen: true }), 'lean back full screen slideshow screensaver tv second monitor display photos');
    act('front', 'Front page', 'page', openFrontPage, 'newspaper front page today best stories headlines paper edition digest');
    act('constellation', 'Constellation', 'constellation', openConstellation, 'map graph sky stars people network who do i read most universe galaxy');
    act('week', 'Your week', 'play', () => openWeek(), 'weekly recap wrapped stats summary how was my week');
    act('rule', 'New rule in plain English', 'sparkle', () => a.ask('Hide posts that are ', false), 'ai rule filter hide mute');
    act('ask', 'Ask your feed', 'sparkle', () => a.ask('', false), 'agent chat ai', '.');
    act('hidden', r.showHidden ? 'Back to the feed' : 'Show what is set aside', 'eyeOff', () => r.setShowHidden(!r.showHidden), 'hidden noise why', 'h');
    act('undo', 'Undo last change', 'undo', () => void r.undo(), '', 'z');
    act('triage', 'Triage new posts', 'inbox', () => a.openPanel('triage'), 'clear inbox zero deck swipe tinder sort keep hide later quick review', 't');
    act('routines', 'Routines', 'sync', () => a.openPanel('routines'), 'schedule every morning daily weekly automation jobs brief');
    act('alerts', 'Alerts', 'bell', () => a.openPanel('alerts'), 'tell me when notify watch keyword quiet hours');
    act('time', 'Time well spent', 'clock', () => a.openPanel('time'), 'time spent reading minutes today week limit screen time usage profile hours');
    act('onthisday', 'On this day', 'clock', () => a.openPanel('onthisday'), 'memories anniversary year ago month ago saved highlights look back');
    act('whatsnew', "What's new", 'sparkle', () => a.openPanel('whatsnew'), 'new features tour changelog overnight');
    act('help', 'Keyboard shortcuts', 'keyboard', () => a.openPanel('help'), 'keys help', '?');

    // Profiles: switch, make a new one, edit the current one.
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Alt+';
    [{ id: 'all', name: 'All', icon: 'layers' }, ...r.profiles].forEach((p, i) => {
      if (p.id === r.profileId) return;
      rows.push({ id: `pr:${p.id}`, group: 'Profiles', label: `Switch to ${p.name}`, hint: i < 9 ? `${mod}${i + 1}` : 'profile', icon: p.icon, keywords: 'profile context switch', run: () => r.switchProfile(p.id) });
    });
    rows.push({ id: 'pr:new', group: 'Profiles', label: 'Make a profile', icon: 'plus', keywords: 'profile new create context work gaming family', run: a.newProfile });
    if (r.profile) rows.push({ id: 'pr:edit', group: 'Profiles', label: `Edit ${r.profile.name}`, icon: 'sliders', keywords: 'profile settings sources theme', run: a.editProfile });

    for (const v of [...BUILTIN_VIEWS, ...lib.views]) rows.push({ id: `v:${v.id}`, group: 'Views', label: v.name, icon: 'filter', run: () => r.openView(v.id, v.spec, v.name) });
    for (const c of lib.collections) rows.push({ id: `c:${c}`, group: 'Views', label: c, hint: 'collection', icon: 'folder', run: () => r.openView(`col:${c}`, { ...DEFAULT_SPEC, collection: c, archived: 'any' }, c) });
    for (const p of lib.pages ?? []) rows.push({ id: `p:${p.id}`, group: 'Pages', label: p.name, icon: 'page', run: () => r.setPageId(p.id) });
    for (const s of lib.sources) {
      rows.push({
        id: `s:${s.id}`, group: 'Sources', label: s.label, hint: s.platform, icon: 'layers', keywords: s.platform,
        run: () => { r.setPageId(null); r.setSpec((x) => ({ ...x, sources: [s.id] }), `only ${s.label}`); },
      });
    }
    // People: one row per author key, most prolific first.
    const people = new Map<string, { it: Item; n: number }>();
    for (const it of lib.items) {
      const k = (it.author.handle ?? it.author.name).toLowerCase();
      const got = people.get(k);
      if (got) got.n++;
      else people.set(k, { it, n: 1 });
    }
    for (const { it, n } of [...people.values()].sort((x, y) => y.n - x.n).slice(0, 400)) {
      rows.push({
        id: `u:${(it.author.handle ?? it.author.name).toLowerCase()}`, group: 'People', label: it.author.name,
        hint: `${it.author.handle ? `@${it.author.handle.replace(/^@/, '')} · ` : ''}${n} post${n === 1 ? '' : 's'}`,
        keywords: it.author.handle ?? '', icon: 'people', avatar: it.author.avatar, run: () => a.openPerson(it),
      });
    }
    for (const t of lib.topics) rows.push({ id: `t:${t.id}`, group: 'Topics', label: t.name, icon: 'tag', keywords: t.terms.join(' '), run: () => { r.setPageId(null); r.setSpec((x) => ({ ...x, topics: [t.id] }), `topic ${t.name}`); } });
    for (const rule of lib.aiRules ?? []) rows.push({ id: `r:${rule.id}`, group: 'AI rules', label: rule.name, hint: rule.enabled ? rule.action : 'off', icon: 'sparkle', keywords: rule.prompt, run: () => a.openPanel('filters') });
    for (const [id, t] of Object.entries(THEME_PRESETS)) rows.push({ id: `th:${id}`, group: 'Themes', label: t.label, hint: 'theme', icon: 'star', keywords: 'theme colours', run: () => a.pickLook(id) });
    for (const [k, url] of Object.entries(LOGIN_URLS)) rows.push({ id: `l:${k}`, group: 'Sign in', label: `Sign in to ${k}`, icon: 'link', keywords: 'login account session', run: () => a.signIn(k, url) });
    return rows;
  }, [lib, a, r]);

  const rows = useMemo<Row[]>(() => {
    const query = q.trim().toLowerCase();
    if (!query) {
      // A calm start: the everyday actions, views and pages.
      return base.filter((x) => x.group === 'Views' || x.group === 'Pages' || (x.group === 'Profiles' && x.id !== 'pr:new') || ['a:sync', 'a:edition', 'a:rule', 'a:look', 'a:workshop', 'a:mode'].includes(x.id));
    }
    const LIMIT: Record<string, number> = { People: 6, Sources: 6, Themes: 4, 'Sign in': 3 };
    const scored = base
      .map((x) => ({ x, s: Math.max(fuzzy(query, x.label), x.keywords ? fuzzy(query, x.keywords) * 0.4 : 0, x.hint ? fuzzy(query, x.hint) * 0.5 : 0) }))
      .filter((o) => o.s >= 30);
    const byGroup = new Map<string, { x: Row; s: number }[]>();
    for (const o of scored) byGroup.set(o.x.group, [...(byGroup.get(o.x.group) ?? []), o]);
    const groups = [...byGroup.entries()]
      .map(([g, list]) => ({ g, list: list.sort((m, n) => n.s - m.s).slice(0, LIMIT[g] ?? 5) }))
      .sort((m, n) => n.list[0].s - m.list[0].s || GROUP_ORDER.indexOf(m.g) - GROUP_ORDER.indexOf(n.g));
    const out = groups.flatMap((g) => g.list.map((o) => o.x));
    // Posts: ranked full-text matches when the server has answered for this text.
    const ftsHits = fts && !fts.unsupported && fts.query.trim().toLowerCase() === query ? fts.results.map((h) => ({ h, it: lib?.items.find((x) => x.id === h.id) })).filter((x) => x.it) : null;
    if (lib && ftsHits?.length) {
      for (const { h, it } of ftsHits) {
        out.push({
          id: `post:${it!.id}`, group: 'Posts', label: (it!.title ?? h.snippet.text).replace(/\s+/g, ' ').slice(0, 110) || '(no text)',
          hint: it!.title ? `${it!.author.name} · ${h.snippet.text.slice(0, 80)}` : it!.author.name, icon: 'page', avatar: it!.author.avatar, run: () => a.openPost(it!),
        });
      }
    } else if (lib && query.length >= 2) {
      // Posts: plain substring search over title, text and author, newest first.
      // Each word must start a word in the post ("mar" finds "Mario", not "supermarket").
      const res = query.split(/\s+/).filter(Boolean).map((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u'));
      const hits = lib.items
        .filter((it) => {
          const hay = `${it.title ?? ''} ${it.text} ${it.author.name} ${it.author.handle ?? ''}`.toLowerCase();
          return res.every((re) => re.test(hay));
        })
        .map((it) => ({ it, inTitle: res.every((re) => re.test(`${it.title ?? ''} ${it.author.name}`.toLowerCase())) }))
        .sort((m, n) => Number(n.inTitle) - Number(m.inTitle) || Date.parse(n.it.publishedAt) - Date.parse(m.it.publishedAt))
        .map((o) => o.it)
        .slice(0, 8);
      for (const it of hits) {
        out.push({
          id: `post:${it.id}`, group: 'Posts', label: (it.title ?? it.text).replace(/\s+/g, ' ').slice(0, 110) || '(no text)',
          hint: it.author.name, icon: 'page', avatar: it.author.avatar, run: () => a.openPost(it),
        });
      }
    }
    out.push({ id: 'ask', group: 'Ask', label: `Ask your feed: ${q.trim()}`, icon: 'sparkle', run: () => a.ask(q.trim(), true) });
    return out;
  }, [q, base, lib, a, fts]);

  useEffect(() => setCur(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${cur}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cur]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCur((c) => Math.min(rows.length - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCur((c) => Math.max(0, c - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const row = rows[cur]; if (row) done(row.run)(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };

  let lastGroup = '';
  return (
    <div className="palette-backdrop" onClick={close}>
      <div ref={dlg} className="palette" role="dialog" aria-modal="true" aria-label="Search everything" onClick={(e) => e.stopPropagation()}>
        <label className="palette-input">
          <Icon name="search" size={18} />
          <input
            autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
            placeholder="Jump to a view, person, source or post, or ask…" aria-label="Search everything"
            role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={rows[cur] ? `pal-${cur}` : undefined}
            spellCheck={false} autoComplete="off"
          />
          <kbd>esc</kbd>
        </label>
        <ul id="palette-list" ref={listRef} className="palette-list" role="listbox" aria-label="Results">
          {rows.map((row, i) => {
            const head = row.group !== lastGroup && row.group !== 'Ask' ? row.group : null;
            lastGroup = row.group;
            return (
              <li key={row.id} role="presentation">
                {head && <p className="palette-group" role="presentation">{head}</p>}
                <button
                  id={`pal-${i}`} data-i={i} role="option" aria-selected={i === cur}
                  className={`palette-row ${i === cur ? 'on' : ''} ${row.group === 'Ask' ? 'ask' : ''}`}
                  onMouseMove={() => i !== cur && setCur(i)} onClick={done(row.run)} tabIndex={-1}
                >
                  {row.avatar ? <img className="palette-av" src={row.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" /> : row.group === 'Ask' ? <span className="agent-orb small" aria-hidden /> : <span className="palette-ic" aria-hidden><Icon name={row.icon} size={15} /></span>}
                  <span className="palette-label">{row.label}</span>
                  {row.hint && <span className="palette-hint">{row.hint.length <= 2 ? <kbd>{row.hint}</kbd> : row.hint}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        <p className="palette-foot"><kbd>↑</kbd><kbd>↓</kbd> move <kbd>↵</kbd> open <span className="palette-foot-r">Everything stays on this computer</span></p>
      </div>
    </div>
  );
}
