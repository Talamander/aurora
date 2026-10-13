import { useMemo, useState } from 'react';
import { applyFilters, DEFAULT_SPEC } from '../../core/filter.ts';
import type { ContentType, FilterSpec, ItemKind, Platform } from '../../core/types.ts';
import { api } from './api.ts';
import { Icon } from './icons.tsx';
import { platformLabel, plural } from './format.ts';
import type { Reader } from './state.ts';
import { useDialog } from './useDialog.ts';

export interface Chip {
  key: string;
  label: string;
  negative?: boolean;
  clear: (s: FilterSpec) => FilterSpec;
}

const LANG_NAMES: Record<string, string> = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', ja: 'Japanese', pt: 'Portuguese', it: 'Italian', nl: 'Dutch' };
const langName = (l: string) => LANG_NAMES[l] ?? l.toUpperCase();

/** One removable chip per active clause value, so any single rule can be undone in one click. */
export function clauseChips(r: Reader): Chip[] {
  const s = r.spec;
  const lib = r.lib;
  const chips: Chip[] = [];
  const srcLabel = (id: string) => lib?.sources.find((x) => x.id === id)?.label ?? 'source';
  const topicName = (id: string) => lib?.topics.find((x) => x.id === id)?.name ?? 'topic';
  if (s.read !== 'any') chips.push({ key: 'read', label: s.read === 'unread' ? 'Unread' : 'Read', clear: (x) => ({ ...x, read: 'any' }) });
  if (s.saved !== 'any') chips.push({ key: 'saved', label: s.saved === 'saved' ? 'Saved' : 'Not saved', clear: (x) => ({ ...x, saved: 'any' }) });
  if (s.archived !== 'hide') chips.push({ key: 'archived', label: s.archived === 'only' ? 'Archive' : 'Including archived', clear: (x) => ({ ...x, archived: 'hide' }) });
  if (s.hideNoise) chips.push({ key: 'hideNoise', label: 'Noise set aside', clear: (x) => ({ ...x, hideNoise: false }) });
  if (!s.aiRules) chips.push({ key: 'aiRules', label: 'AI rules off', clear: (x) => ({ ...x, aiRules: true }) });
  if (!s.hideDuplicates) chips.push({ key: 'hideDuplicates', label: 'Showing duplicates', clear: (x) => ({ ...x, hideDuplicates: true }) });
  if (!s.showDemo) chips.push({ key: 'showDemo', label: 'Demo hidden', clear: (x) => ({ ...x, showDemo: true }) });
  if (s.collection) chips.push({ key: 'collection', label: `In ${s.collection}`, clear: (x) => ({ ...x, collection: null }) });
  for (const k of s.include) chips.push({ key: 'include', label: s.includeMode === 'all' && s.include.length > 1 ? `Has all: ${k}` : `Has “${k}”`, clear: (x) => ({ ...x, include: x.include.filter((v) => v !== k) }) });
  for (const k of s.exclude) chips.push({ key: 'exclude', negative: true, label: `Without “${k}”`, clear: (x) => ({ ...x, exclude: x.exclude.filter((v) => v !== k) }) });
  for (const id of s.sources) chips.push({ key: 'sources', label: srcLabel(id), clear: (x) => ({ ...x, sources: x.sources.filter((v) => v !== id) }) });
  for (const id of s.excludeSources) chips.push({ key: 'excludeSources', negative: true, label: `Not ${srcLabel(id)}`, clear: (x) => ({ ...x, excludeSources: x.excludeSources.filter((v) => v !== id) }) });
  for (const a of s.authors) chips.push({ key: 'authors', label: `From ${a}`, clear: (x) => ({ ...x, authors: x.authors.filter((v) => v !== a) }) });
  for (const a of s.excludeAuthors) chips.push({ key: 'excludeAuthors', negative: true, label: `Muted ${a}`, clear: (x) => ({ ...x, excludeAuthors: x.excludeAuthors.filter((v) => v !== a) }) });
  for (const p of s.platforms) chips.push({ key: 'platforms', label: platformLabel(p), clear: (x) => ({ ...x, platforms: x.platforms.filter((v) => v !== p) }) });
  for (const c of s.contentTypes) chips.push({ key: 'contentTypes', label: CONTENT_LABEL[c], clear: (x) => ({ ...x, contentTypes: x.contentTypes.filter((v) => v !== c) }) });
  for (const k of s.kinds) chips.push({ key: 'kinds', label: KIND_LABEL[k], clear: (x) => ({ ...x, kinds: x.kinds.filter((v) => v !== k) }) });
  for (const l of s.langs) chips.push({ key: 'langs', label: langName(l), clear: (x) => ({ ...x, langs: x.langs.filter((v) => v !== l) }) });
  for (const t of s.topics) chips.push({ key: 'topics', label: topicName(t), clear: (x) => ({ ...x, topics: x.topics.filter((v) => v !== t) }) });
  if (s.dateFrom) chips.push({ key: 'dateFrom', label: `From ${s.dateFrom}`, clear: (x) => ({ ...x, dateFrom: null }) });
  if (s.dateTo) chips.push({ key: 'dateTo', label: `Until ${s.dateTo}`, clear: (x) => ({ ...x, dateTo: null }) });
  return chips;
}

const CONTENT_LABEL: Record<ContentType, string> = { text: 'Text only', image: 'Images', video: 'Video', link: 'Links', article: 'Articles' };
const KIND_LABEL: Record<ItemKind, string> = { post: 'Posts', reply: 'Replies', repost: 'Reposts', thread: 'Threads', article: 'Articles', video: 'Videos' };

function toggle<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

function TermInput({ values, onChange, placeholder, label, negative }: { values: string[]; onChange: (v: string[]) => void; placeholder: string; label: string; negative?: boolean }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const parts = draft.split(',').map((x) => x.trim()).filter(Boolean);
    if (parts.length) onChange([...new Set([...values, ...parts])]);
    setDraft('');
  };
  return (
    <div className="term-input">
      <div className="term-chips">
        {values.map((v) => (
          <span key={v} className={`chip on ${negative ? 'neg' : ''}`}>
            {v}
            <button aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}><Icon name="x" size={13} /></button>
          </span>
        ))}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); add(); }} className="term-form">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={placeholder} aria-label={label} onBlur={add} />
      </form>
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  );
}

export function FilterSheet({ r, close }: { r: Reader; close: () => void }) {
  const dlg = useDialog<HTMLDivElement>();
  const lib = r.lib!;
  const s = r.spec;
  const set = (patch: Partial<FilterSpec>, label: string) => r.setSpec((x) => ({ ...x, ...patch }), label);
  const [authorQuery, setAuthorQuery] = useState('');
  const [topicDraft, setTopicDraft] = useState({ name: '', terms: '' });

  const authors = useMemo(() => {
    const m = new Map<string, { key: string; name: string; n: number }>();
    for (const it of lib.items) {
      const key = it.author.handle ?? it.author.name;
      const cur = m.get(key.toLowerCase());
      if (cur) cur.n++;
      else m.set(key.toLowerCase(), { key, name: it.author.name, n: 1 });
    }
    return [...m.values()].sort((a, b) => b.n - a.n);
  }, [lib.items]);
  const shownAuthors = authors.filter((a) => !authorQuery || (a.name + ' ' + a.key).toLowerCase().includes(authorQuery.toLowerCase())).slice(0, authorQuery ? 30 : 12);

  const langs = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of lib.items) if (it.lang) m.set(it.lang.slice(0, 2).toLowerCase(), (m.get(it.lang.slice(0, 2).toLowerCase()) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [lib.items]);
  const platforms = useMemo(() => [...new Set(lib.items.map((i) => i.platform))] as Platform[], [lib.items]);
  const unknownLang = lib.items.filter((i) => !i.lang).length;

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const count = r.result?.visible.length ?? 0;
  // Preview: what turning noise on would hide right now.
  const noiseCount = useMemo(() => (s.hideNoise ? null : applyFilters(lib.items, { ...s, hideNoise: true }, { topics: lib.topics, ai: { rules: lib.aiRules, labels: lib.labels } }).visible.length), [lib, s]);

  return (
    <div className="sheet-backdrop" onClick={close}>
      <div ref={dlg} className="sheet filters" role="dialog" aria-modal="true" aria-label="Filters" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Filters</h2>
          <button className="btn small ghost" onClick={() => void r.undo()}><Icon name="undo" size={15} /> Undo</button>
          <button className="icon-btn" onClick={close} aria-label="Close filters"><Icon name="x" /></button>
        </div>
        <div className="sheet-body">
          <section className="f-sec">
            <h3>Order</h3>
            <Seg label="Sort" value={s.sort} options={[['newest', 'Newest'], ['oldest', 'Oldest'], ['relevance', 'Best match'], ['source', 'Source']]} onChange={(v) => set({ sort: v }, 'change sort')} />
            {s.sort === 'relevance' && <p className="f-hint">Best match counts search hits, keywords and topics, then a small boost for saved and recent posts.</p>}
          </section>

          <section className="f-sec">
            <h3>Reading state</h3>
            <div className="f-grid">
              <span className="f-label">Read</span>
              <Seg label="Read state" value={s.read} options={[['any', 'All'], ['unread', 'Unread'], ['read', 'Read']]} onChange={(v) => set({ read: v }, 'read filter')} />
              <span className="f-label">Saved</span>
              <Seg label="Saved state" value={s.saved} options={[['any', 'All'], ['saved', 'Saved'], ['unsaved', 'Not saved']]} onChange={(v) => set({ saved: v }, 'saved filter')} />
              <span className="f-label">Archive</span>
              <Seg label="Archive" value={s.archived} options={[['hide', 'Hide'], ['any', 'Include'], ['only', 'Only']]} onChange={(v) => set({ archived: v }, 'archive filter')} />
            </div>
          </section>

          <section className="f-sec">
            <h3>Words</h3>
            <p className="f-hint">Whole words, any case. Separate with commas.</p>
            <div className="f-row-head">
              <span className="f-label">Must mention</span>
              {s.include.length > 1 && <Seg label="Keyword mode" value={s.includeMode} options={[['any', 'Any'], ['all', 'All']]} onChange={(v) => set({ includeMode: v }, 'keyword mode')} />}
            </div>
            <TermInput values={s.include} onChange={(v) => set({ include: v }, 'keywords')} placeholder="sqlite, typography" label="Keywords to include" />
            <span className="f-label">Mute words</span>
            <TermInput values={s.exclude} onChange={(v) => set({ exclude: v }, 'muted words')} placeholder="giveaway, crypto" label="Words to mute" negative />
          </section>

          <section className="f-sec">
            <h3>Noise and duplicates</h3>
            <label className="switch">
              <input type="checkbox" checked={s.hideNoise} onChange={(e) => set({ hideNoise: e.target.checked }, e.target.checked ? 'set noise aside' : 'show noise')} />
              <span>
                Set noise aside
                <small>Rule-based: engagement bait, promotions, very short posts, reposts without comment, hashtag stuffing. {noiseCount !== null && `Would hide ${count - noiseCount} of these ${count}.`} Every post shows which rule fired, and you can override it.</small>
              </span>
            </label>
            <label className="switch">
              <input type="checkbox" checked={s.hideDuplicates} onChange={(e) => set({ hideDuplicates: e.target.checked }, 'duplicates')} />
              <span>Hide duplicates<small>Same link or same text from several sources: keep the fullest copy.</small></span>
            </label>
            {lib.items.some((i) => i.isDemo) && (
              <label className="switch">
                <input type="checkbox" checked={s.showDemo} onChange={(e) => set({ showDemo: e.target.checked }, 'demo items')} />
                <span>Show demo items<small>Fictional sample posts, marked with a hatched spine.</small></span>
              </label>
            )}
          </section>

          {lib.sources.length > 0 && (
            <section className="f-sec">
              <h3>Sources</h3>
              <p className="f-hint">Tap once to show only, twice to mute, again to reset.</p>
              <div className="tri-list">
                {lib.sources.map((src) => {
                  const st = s.sources.includes(src.id) ? 'only' : s.excludeSources.includes(src.id) ? 'mute' : 'any';
                  return (
                    <button
                      key={src.id}
                      className={`tri ${st}`}
                      onClick={() => {
                        if (st === 'any') set({ sources: [...s.sources, src.id] }, `only ${src.label}`);
                        else if (st === 'only') set({ sources: s.sources.filter((x) => x !== src.id), excludeSources: [...s.excludeSources, src.id] }, `mute ${src.label}`);
                        else set({ excludeSources: s.excludeSources.filter((x) => x !== src.id) }, `reset ${src.label}`);
                      }}
                    >
                      <span className={`mark ${src.isDemo ? 'demo' : ''}`} style={{ background: src.isDemo ? undefined : `var(--hue-${src.platform})` }} />
                      <span className="tri-label">{src.label}</span>
                      <span className="tri-state">{st === 'only' ? 'Only' : st === 'mute' ? 'Muted' : ''}</span>
                    </button>
                  );
                })}
              </div>
              {platforms.length > 1 && (
                <>
                  <span className="f-label">Platforms</span>
                  <div className="pill-set">
                    {platforms.map((p) => (
                      <button key={p} className={`pill ${s.platforms.includes(p) ? 'on' : ''}`} aria-pressed={s.platforms.includes(p)} onClick={() => set({ platforms: toggle(s.platforms, p) }, `platform ${platformLabel(p)}`)}>
                        <span className="mark" style={{ background: `var(--hue-${p}, var(--hue-import))` }} /> {platformLabel(p)}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}

          <section className="f-sec">
            <h3>People</h3>
            <input className="f-input" value={authorQuery} onChange={(e) => setAuthorQuery(e.target.value)} placeholder={`Find among ${authors.length} authors`} aria-label="Find author" />
            <div className="tri-list">
              {shownAuthors.map((a) => {
                const st = s.authors.some((x) => x.toLowerCase() === a.key.toLowerCase()) ? 'only' : s.excludeAuthors.some((x) => x.toLowerCase() === a.key.toLowerCase()) ? 'mute' : 'any';
                return (
                  <button
                    key={a.key}
                    className={`tri ${st}`}
                    onClick={() => {
                      const lk = a.key.toLowerCase();
                      if (st === 'any') set({ authors: [...s.authors, a.key] }, `only ${a.name}`);
                      else if (st === 'only') set({ authors: s.authors.filter((x) => x.toLowerCase() !== lk), excludeAuthors: [...s.excludeAuthors, a.key] }, `mute ${a.name}`);
                      else set({ excludeAuthors: s.excludeAuthors.filter((x) => x.toLowerCase() !== lk) }, `reset ${a.name}`);
                    }}
                  >
                    <span className="tri-label">{a.name} <small>{a.key !== a.name ? a.key : ''}</small></span>
                    <span className="tri-n">{a.n}</span>
                    <span className="tri-state">{st === 'only' ? 'Only' : st === 'mute' ? 'Muted' : ''}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="f-sec">
            <h3>Shape</h3>
            <span className="f-label">Contains</span>
            <div className="pill-set">
              {(Object.keys(CONTENT_LABEL) as ContentType[]).map((c) => (
                <button key={c} className={`pill ${s.contentTypes.includes(c) ? 'on' : ''}`} aria-pressed={s.contentTypes.includes(c)} onClick={() => set({ contentTypes: toggle(s.contentTypes, c) }, `type ${CONTENT_LABEL[c]}`)}>{CONTENT_LABEL[c]}</button>
              ))}
            </div>
            <span className="f-label">Kind</span>
            <div className="pill-set">
              {(Object.keys(KIND_LABEL) as ItemKind[]).map((k) => (
                <button key={k} className={`pill ${s.kinds.includes(k) ? 'on' : ''}`} aria-pressed={s.kinds.includes(k)} onClick={() => set({ kinds: toggle(s.kinds, k) }, `kind ${KIND_LABEL[k]}`)}>{KIND_LABEL[k]}</button>
              ))}
            </div>
            {langs.length > 0 && (
              <>
                <span className="f-label">Language</span>
                <div className="pill-set">
                  {langs.map(([l, n]) => (
                    <button key={l} className={`pill ${s.langs.includes(l) ? 'on' : ''}`} aria-pressed={s.langs.includes(l)} onClick={() => set({ langs: toggle(s.langs, l) }, `language ${langName(l)}`)}>{langName(l)} <small>{n}</small></button>
                  ))}
                </div>
                {unknownLang > 0 && <p className="f-hint">{plural(unknownLang, 'post')} have no language from the source and were too short to guess, so they hide while a language is picked.</p>}
              </>
            )}
          </section>

          <section className="f-sec">
            <h3>Dates</h3>
            <div className="pill-set">
              {([['Today', 0], ['7 days', 7], ['30 days', 30], ['1 year', 365]] as [string, number][]).map(([l, n]) => (
                <button key={l} className={`pill ${s.dateFrom === daysAgo(n) && !s.dateTo ? 'on' : ''}`} onClick={() => set({ dateFrom: daysAgo(n), dateTo: null }, `last ${l}`)}>{l}</button>
              ))}
              {(s.dateFrom || s.dateTo) && <button className="pill ghost" onClick={() => set({ dateFrom: null, dateTo: null }, 'any date')}>Any date</button>}
            </div>
            <div className="date-row">
              <label>From <input type="date" value={s.dateFrom ?? ''} onChange={(e) => set({ dateFrom: e.target.value || null }, 'start date')} /></label>
              <label>Until <input type="date" value={s.dateTo ?? ''} onChange={(e) => set({ dateTo: e.target.value || null }, 'end date')} /></label>
            </div>
          </section>

          <section className="f-sec">
            <h3>Topics</h3>
            <p className="f-hint">A topic is your own word list. Posts show which word matched.</p>
            <div className="tri-list">
              {lib.topics.map((t) => (
                <div key={t.id} className="topic-row">
                  <button className={`tri ${s.topics.includes(t.id) ? 'only' : 'any'}`} onClick={() => set({ topics: toggle(s.topics, t.id) }, `topic ${t.name}`)}>
                    <span className="tri-label">{t.name} <small>{t.terms.slice(0, 6).join(', ')}{t.terms.length > 6 ? '…' : ''}</small></span>
                    <span className="tri-state">{s.topics.includes(t.id) ? 'On' : ''}</span>
                  </button>
                  <button className="mini-btn" aria-label={`Delete topic ${t.name}`} onClick={async () => { await api.deleteTopic(t.id); set({ topics: s.topics.filter((x) => x !== t.id) }, 'delete topic'); void r.reload(); }}><Icon name="x" size={14} /></button>
                </div>
              ))}
            </div>
            <form
              className="topic-form"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api.saveTopic({ name: topicDraft.name, terms: topicDraft.terms.split(',').map((x) => x.trim()).filter(Boolean) });
                  setTopicDraft({ name: '', terms: '' });
                  void r.reload();
                } catch (err) {
                  r.toast((err as Error).message, { tone: 'error' });
                }
              }}
            >
              <input value={topicDraft.name} onChange={(e) => setTopicDraft({ ...topicDraft, name: e.target.value })} placeholder="New topic" aria-label="Topic name" />
              <input value={topicDraft.terms} onChange={(e) => setTopicDraft({ ...topicDraft, terms: e.target.value })} placeholder="words, separated, by commas" aria-label="Topic words" />
              <button className="btn small" type="submit" disabled={!topicDraft.name.trim() || !topicDraft.terms.trim()}>Add</button>
            </form>
          </section>
        </div>
        <div className="sheet-foot">
          <button className="btn ghost" onClick={() => { r.setSpec({ ...DEFAULT_SPEC, sort: s.sort }, 'clear all filters'); r.setViewId('everything'); }}>Clear all</button>
          <button className="btn primary" onClick={close}>Show {plural(count, 'post')}</button>
        </div>
      </div>
    </div>
  );
}
