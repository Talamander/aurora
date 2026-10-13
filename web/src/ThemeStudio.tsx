// Theme studio: make a theme from a picture, a mood sentence or by hand. Everything previews
// live (the app behind the sheet and a dark/light pair of real posts), every palette is checked
// against WCAG AA and nudged where needed, and themes save as presets or travel as small files.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Item } from '../../core/types.ts';
import { ALL_PROFILE } from '../../core/profiles.ts';
import { Icon } from './icons.tsx';
import { previewText } from './format.ts';
import type { Reader } from './state.ts';
import { THEME_PRESETS, type Look } from './themes.ts';
import { useDialog } from './useDialog.ts';
import {
  contrastRatio, derive, DEFAULT_SEED, FONT_STACKS, newThemeId, normalizeSeed, parseThemeFile, seedFromPixels, seedFromTokens,
  themeFile, THEME_FILE_MAX, type SavedTheme, type StudioFont, type ThemeSeed,
} from './themeStudio.ts';
import { MAX_SAVED } from './studioThemes.ts';

type Tab = 'picture' | 'mood' | 'hand';
type Mode = 'dark' | 'light';

export interface StudioProps {
  r: Reader;
  theme: Mode;
  setTheme: (m: Mode) => void;
  /** The look actually in force (profile look or app-wide look). */
  activeLook: Look;
  /** Paint a draft over the app while the studio is open; null shows the real look again. */
  preview: (look: Look) => void;
  assign: (preset: string, target: string) => Promise<void>;
  saved: SavedTheme[];
  saveList: (list: SavedTheme[]) => Promise<unknown>;
  setDensity: (d: 'comfortable' | 'compact') => void;
  ask: (text: string, send?: boolean) => void;
  close: () => void;
}

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

function feedPictures(items: Item[]): { src: string; who: string }[] {
  const out: { src: string; who: string }[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const m = it.media.find((x) => x.type === 'image' && (x.thumb || x.url));
    const src = m?.thumb ?? m?.url;
    if (!src || seen.has(src)) continue;
    seen.add(src);
    out.push({ src, who: it.author.name });
    if (out.length >= 12) break;
  }
  return out;
}

/** Reads a picture into a tiny canvas. Files are decoded straight from memory (never uploaded, never a blob: URL). */
async function pixelsOf(src: string | Blob): Promise<Uint8ClampedArray> {
  let pic: CanvasImageSource;
  if (typeof src === 'string') {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    await img.decode();
    pic = img;
  } else {
    pic = await createImageBitmap(src);
  }
  const c = document.createElement('canvas');
  c.width = 72;
  c.height = 72;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('This browser cannot read pictures.');
  g.drawImage(pic, 0, 0, 72, 72);
  if ('close' in pic) pic.close();
  return g.getImageData(0, 0, 72, 72).data;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'theme';
const vars = (tokens: Record<string, string>) => Object.fromEntries(Object.entries(tokens).map(([k, v]) => [`--${k}`, v])) as React.CSSProperties;
const deg = (h: number) => `${Math.round(h)}°`;

export function ThemeStudio(p: StudioProps) {
  const { r, theme } = p;
  const dlg = useDialog<HTMLDivElement>();
  const activeId = p.activeLook?.preset?.startsWith('studio-') ? p.activeLook.preset : null;
  const start = p.saved.find((t) => t.id === activeId);
  const [tab, setTab] = useState<Tab>('picture');
  const [seed, setSeedRaw] = useState<ThemeSeed>(() => start?.seed ?? DEFAULT_SEED);
  const [savedId, setSavedId] = useState<string | null>(start?.id ?? null);
  const [dirty, setDirty] = useState(false);
  const [swatches, setSwatches] = useState<string[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; tone?: 'error' } | null>(null);
  const [mood, setMood] = useState('');
  const [moodState, setMoodState] = useState<'idle' | 'asked' | 'done'>('idle');
  const [target, setTarget] = useState<string>(r.profile?.id ?? ALL_PROFILE);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const askedAt = useRef<Look | undefined>(undefined);

  const setSeed = (next: ThemeSeed, touched = true) => {
    setSeedRaw(normalizeSeed(next));
    if (touched) setDirty(true);
  };
  const tune = (patch: Partial<ThemeSeed>) => setSeed({ ...seed, ...patch });

  const dark = useMemo(() => derive(seed, 'dark'), [seed]);
  const light = useMemo(() => derive(seed, 'light'), [seed]);

  // The draft paints the whole app while the studio is open, once something was changed.
  useEffect(() => {
    if (dirty) p.preview({ tokens: (theme === 'dark' ? dark : light).tokens });
  }, [dirty, dark, light, theme]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => p.preview(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Mood: the agent's set_theme lands as a new active look. Pull it back into the dials.
  useEffect(() => {
    if (moodState !== 'asked' || p.activeLook === askedAt.current) return;
    const look = p.activeLook;
    const base = look?.preset ? THEME_PRESETS[look.preset] : undefined;
    const palette = { ...(base ? (theme === 'light' ? base.light ?? base.dark : base.dark) : {}), ...(look?.tokens ?? {}) };
    const s = seedFromTokens(palette, mood.trim().slice(0, 40) || 'From a mood');
    setMoodState('done');
    if (s) setSeed({ ...s, radius: seed.radius, font: seed.font, density: seed.density, glass: seed.glass }, false);
    setNote({ text: 'The AI set this theme and it is live now. Tune it by hand, or save it as yours.' });
  }, [p.activeLook, moodState]); // eslint-disable-line react-hooks/exhaustive-deps

  const fromPicture = async (src: string | Blob, name: string, key: string) => {
    setPicked(key);
    setNote(null);
    try {
      const px = await pixelsOf(src);
      const got = seedFromPixels(px, name);
      setSwatches(got.swatches);
      setSeed({ ...got.seed, radius: seed.radius, font: seed.font, density: seed.density, glass: seed.glass });
      setSavedId(null);
      if (got.mode !== theme) setNote({ text: `This picture reads as ${got.mode}. Both modes are ready; switch any time.` });
    } catch (e) {
      const blocked = (e as Error).name === 'SecurityError';
      setNote({ tone: 'error', text: blocked ? 'That picture’s host does not let the browser read its colours. Turn on the image proxy in settings, or drop the file here instead.' : 'Could not read that picture.' });
    }
  };

  const onFile = async (f: File) => {
    if (/\.json$/i.test(f.name) || f.type === 'application/json') return importFile(f);
    if (!f.type.startsWith('image/')) return setNote({ tone: 'error', text: 'Drop a picture or an .aurora-theme.json file.' });
    if (f.size > MAX_IMAGE_BYTES) return setNote({ tone: 'error', text: 'That picture is too big to read here.' });
    await fromPicture(f, f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 40) || 'From a picture', `file:${f.name}`);
  };

  const importFile = async (f: File) => {
    if (f.size > THEME_FILE_MAX) return setNote({ tone: 'error', text: 'That file is too big to be an Aurora theme.' });
    try {
      const { seed: s, ignored } = parseThemeFile(await f.text());
      setSeed(s);
      setSavedId(null);
      setTab('hand');
      setNote({ text: `Imported “${s.name}”.${ignored ? ` Ignored ${ignored} unknown ${ignored === 1 ? 'field' : 'fields'}.` : ''} Save it to keep it.` });
    } catch (e) {
      setNote({ tone: 'error', text: (e as Error).message });
    }
  };

  const exportFile = () => {
    const blob = new Blob([themeFile(seed)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slug(seed.name)}.aurora-theme.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const save = async (): Promise<string> => {
    const id = savedId ?? newThemeId();
    const rest = p.saved.filter((t) => t.id !== id);
    const list = [{ id, seed }, ...rest].slice(0, MAX_SAVED);
    await p.saveList(list);
    setSavedId(id);
    return id;
  };

  const onSave = async () => {
    await save();
    setNote({ text: `Saved “${seed.name}”. It is in the theme list now.` });
  };

  const onApply = async () => {
    const id = await save();
    await p.assign(id, target);
    p.setDensity(seed.density);
    setDirty(false);
    p.preview(null);
    const who = target === ALL_PROFILE ? 'everywhere' : `for ${r.profiles.find((x) => x.id === target)?.name ?? 'this profile'}`;
    const shadowed = target === ALL_PROFILE && r.profile?.look ? ` ${r.profile.name} keeps its own theme while it is on.` : '';
    setNote({ text: `Applied “${seed.name}” ${who}.${shadowed}` });
  };

  const removeSaved = async (id: string) => {
    await p.saveList(p.saved.filter((t) => t.id !== id));
    if (savedId === id) setSavedId(null);
  };

  const askMood = () => {
    const text = mood.trim();
    if (!text) return;
    askedAt.current = p.activeLook;
    setMoodState('asked');
    setDirty(false);
    p.preview(null);
    setNote(null);
    p.ask(`Make the theme feel like ${text.slice(0, 200)}`, true);
  };

  const pictures = useMemo(() => feedPictures(r.lib?.items ?? []), [r.lib?.items]);
  const posts = useMemo(() => (r.result?.visible ?? []).slice(0, 6).map((e) => e.item).filter((it) => it.text || it.title).slice(0, 2), [r.result]);
  const nudges = [...dark.nudges, ...light.nudges];
  const quiet = (d: { tokens: Record<string, string> }) => Math.min(contrastRatio(d.tokens['ink-3'], d.tokens.surface), contrastRatio(d.tokens['ink-3'], d.tokens.ground));
  const body = (d: { tokens: Record<string, string> }) => contrastRatio(d.tokens.ink, d.tokens.surface);

  return (
    <div className="sheet-backdrop" onClick={p.close}>
      <div
        ref={dlg}
        className={`sheet studio-sheet ${dragging ? 'dragging' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Theme studio"
        onClick={(e) => e.stopPropagation()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
        onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) void onFile(f); }}
      >
        <div className="sheet-head">
          <h2>Theme studio</h2>
          <div className="seg" role="radiogroup" aria-label="Preview mode">
            <button role="radio" aria-checked={theme === 'dark'} className={theme === 'dark' ? 'on' : ''} onClick={() => p.setTheme('dark')}><Icon name="moon" size={15} /> Dark</button>
            <button role="radio" aria-checked={theme === 'light'} className={theme === 'light' ? 'on' : ''} onClick={() => p.setTheme('light')}><Icon name="sun" size={15} /> Light</button>
          </div>
          <button className="icon-btn" onClick={p.close} aria-label="Close"><Icon name="x" /></button>
        </div>

        <div className="studio">
          <section className="studio-stage" aria-label="Preview">
            <div className="studio-pair">
              <Preview mode="dark" tokens={dark.tokens} seed={seed} posts={posts} current={theme === 'dark'} />
              <Preview mode="light" tokens={light.tokens} seed={seed} posts={posts} current={theme === 'light'} />
            </div>
            <div className="studio-check" role="status">
              <span className="studio-aa"><Icon name="check" size={14} /> AA</span>
              <span>
                Contrast checked in both modes. Body text {body(dark).toFixed(1)}:1 dark, {body(light).toFixed(1)}:1 light; quiet text {quiet(dark).toFixed(1)}:1 and {quiet(light).toFixed(1)}:1.
                {nudges.length > 0 && <> Nudged for you: {nudges.map((n) => n.replace(/^(Dark|Light): /, (_m, w: string) => `${w.toLowerCase()}, `)).join('; ')}.</>}
              </span>
            </div>
          </section>

          <section className="studio-controls">
            <div className="studio-tabs" role="tablist" aria-label="Make a theme from">
              {(['picture', 'mood', 'hand'] as Tab[]).map((t) => (
                <button key={t} role="tab" id={`st-${t}`} aria-selected={tab === t} aria-controls={`sp-${t}`} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                  <Icon name={t === 'picture' ? 'image' : t === 'mood' ? 'sparkle' : 'sliders'} size={16} />
                  {t === 'picture' ? 'A picture' : t === 'mood' ? 'A mood' : 'By hand'}
                </button>
              ))}
            </div>

            {tab === 'picture' && (
              <div className="studio-panel" role="tabpanel" id="sp-picture" aria-labelledby="st-picture">
                <button className="studio-drop" onClick={() => fileRef.current?.click()}>
                  <Icon name="upload" size={20} />
                  <b>Drop a picture here, or choose one</b>
                  <small>Colours are read on this device. The picture is never uploaded.</small>
                </button>
                <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ''; }} />
                {pictures.length > 0 && (
                  <>
                    <p className="studio-label">Or one from your feed</p>
                    <div className="studio-pics">
                      {pictures.map((pic) => (
                        <button key={pic.src} className={`studio-pic ${picked === pic.src ? 'on' : ''}`} onClick={() => void fromPicture(pic.src, `${pic.who}’s picture`.slice(0, 40), pic.src)} aria-label={`Use the colours of ${pic.who}’s picture`} aria-pressed={picked === pic.src}>
                          <img src={pic.src} alt="" loading="lazy" decoding="async" />
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {swatches.length > 0 && (
                  <div className="studio-swatches" aria-label="Colours found in the picture">
                    {swatches.map((c) => <span key={c} style={{ background: c }} title={c} />)}
                    <small>key {deg(seed.hue)} · accents {seed.accents.map(deg).join(' ')}</small>
                  </div>
                )}
              </div>
            )}

            {tab === 'mood' && (
              <div className="studio-panel" role="tabpanel" id="sp-mood" aria-labelledby="st-mood">
                <form className="studio-mood" onSubmit={(e) => { e.preventDefault(); askMood(); }}>
                  <label className="studio-label" htmlFor="studio-mood">Describe how it should feel</label>
                  <input id="studio-mood" value={mood} onChange={(e) => setMood(e.target.value)} placeholder="a rainy harbour at dawn" maxLength={200} autoComplete="off" />
                  <button className="btn primary" type="submit" disabled={!mood.trim() || moodState === 'asked'}>
                    <Icon name="sparkle" size={16} /> {moodState === 'asked' ? 'The AI is picking colours…' : 'Ask the AI'}
                  </button>
                </form>
                <p className="f-hint">The AI uses its theme tool and the result goes live straight away. Bring it back here to tune or save it.</p>
                <div className="studio-moods">
                  {['late summer evening', 'a quiet library', 'neon in the rain', 'paper and ink'].map((m) => (
                    <button key={m} className="chip" onClick={() => setMood(m)}>{m}</button>
                  ))}
                </div>
                {moodState === 'done' && <button className="btn small" onClick={() => { setTab('hand'); setDirty(true); }}><Icon name="sliders" size={15} /> Tune it by hand</button>}
              </div>
            )}

            {tab === 'hand' && (
              <div className="studio-panel studio-dials" role="tabpanel" id="sp-hand" aria-labelledby="st-hand">
                <Dial label="Hue" value={seed.hue} min={0} max={359} step={1} show={deg(seed.hue)} track="hue" onChange={(v) => tune({ hue: v, accents: seed.accents.map((a) => (a + v - seed.hue + 360) % 360) as ThemeSeed['accents'] })} />
                <Dial label="Colour" value={seed.chroma} min={0} max={1} step={0.01} show={seed.chroma < 0.25 ? 'muted' : seed.chroma > 0.75 ? 'vivid' : 'balanced'} onChange={(v) => tune({ chroma: v })} />
                <Dial label="Warmth" value={seed.warmth} min={-1} max={1} step={0.01} show={seed.warmth < -0.2 ? 'cool' : seed.warmth > 0.2 ? 'warm' : 'neutral'} track="warmth" onChange={(v) => tune({ warmth: v })} />
                <Dial label="Contrast" value={seed.contrast} min={0} max={1} step={0.01} show={seed.contrast < 0.33 ? 'soft' : seed.contrast > 0.66 ? 'crisp' : 'even'} onChange={(v) => tune({ contrast: v })} />
                <Dial label="Glass" value={seed.glass} min={0} max={1} step={0.01} show={seed.glass < 0.33 ? 'solid' : seed.glass > 0.66 ? 'clear' : 'frosted'} onChange={(v) => tune({ glass: v })} />
                <Dial label="Corners" value={seed.radius} min={4} max={34} step={1} show={`${seed.radius}px`} onChange={(v) => tune({ radius: v })} />
                <div className="studio-row">
                  <span className="studio-label">Density</span>
                  <div className="seg" role="radiogroup" aria-label="Density">
                    {(['comfortable', 'compact'] as const).map((d) => (
                      <button key={d} role="radio" aria-checked={seed.density === d} className={seed.density === d ? 'on' : ''} onClick={() => tune({ density: d })}>{d === 'compact' ? 'Compact' : 'Comfortable'}</button>
                    ))}
                  </div>
                </div>
                <div className="studio-row">
                  <span className="studio-label">Headings</span>
                  <div className="studio-fonts" role="radiogroup" aria-label="Heading font">
                    {(Object.keys(FONT_STACKS) as StudioFont[]).map((f) => (
                      <button key={f} role="radio" aria-checked={seed.font === f} className={seed.font === f ? 'on' : ''} onClick={() => tune({ font: f })}>
                        <span style={{ fontFamily: FONT_STACKS[f].stack }}>Ag</span>
                        <small>{FONT_STACKS[f].label}</small>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {note && <p className={`studio-note ${note.tone ?? ''}`} role={note.tone === 'error' ? 'alert' : 'status'}>{note.text}</p>}

            {p.saved.length > 0 && (
              <div className="studio-saved">
                <p className="studio-label">Your themes</p>
                <div className="studio-saved-list">
                  {p.saved.map((t) => {
                    const d = derive(t.seed, theme).tokens;
                    return (
                      <span key={t.id} className={`studio-saved-item ${savedId === t.id ? 'on' : ''}`}>
                        <button onClick={() => { setSeed(t.seed); setSavedId(t.id); setTab('hand'); }} aria-pressed={savedId === t.id}>
                          <i style={{ background: d.lit }} aria-hidden />
                          {t.seed.name}
                        </button>
                        <button className="studio-x" onClick={() => void removeSaved(t.id)} aria-label={`Delete ${t.seed.name}`}><Icon name="x" size={13} /></button>
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        </div>

        <div className="sheet-foot studio-foot">
          <input className="studio-name" value={seed.name} onChange={(e) => setSeed({ ...seed, name: e.target.value }, dirty)} aria-label="Theme name" maxLength={40} />
          <div className="studio-foot-row">
            <button className="btn small ghost" onClick={exportFile} title="Download as .aurora-theme.json"><Icon name="arrowUp" size={15} /> Export</button>
            <button className="btn small ghost" onClick={() => importRef.current?.click()} title="Open an .aurora-theme.json file"><Icon name="upload" size={15} /> Import</button>
            <input ref={importRef} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }} />
            <button className="btn small" onClick={() => void onSave()}>Save</button>
            {r.profiles.length > 0 && (
              <select className="studio-target" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Apply to">
                <option value={ALL_PROFILE}>Everywhere</option>
                {r.profiles.map((x) => <option key={x.id} value={x.id}>{x.name} only</option>)}
              </select>
            )}
            <button className="btn primary" onClick={() => void onApply()}>Apply</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Dial({ label, value, min, max, step, show, track, onChange }: { label: string; value: number; min: number; max: number; step: number; show: string; track?: 'hue' | 'warmth'; onChange: (v: number) => void }) {
  const id = `dial-${label.toLowerCase()}`;
  return (
    <div className="studio-dial">
      <label htmlFor={id} className="studio-label">{label}</label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className={track ? `track-${track}` : ''} aria-valuetext={show} />
      <output htmlFor={id}>{show}</output>
    </div>
  );
}

function Preview({ mode, tokens, seed, posts, current }: { mode: Mode; tokens: Record<string, string>; seed: ThemeSeed; posts: Item[]; current: boolean }) {
  const shown = posts.length ? posts : [{ id: 'x', author: { name: 'Aurora' }, title: 'Your feed, in this light', text: 'Real posts from your library appear here once it has some.', media: [] } as unknown as Item];
  return (
    <figure className={`sp-frame ${seed.density === 'compact' ? 'compact' : ''} ${current ? 'current' : ''}`} style={vars(tokens)} data-mode={mode}>
      <span className="sp-aura" aria-hidden />
      <figcaption className="sp-cap">{mode === 'dark' ? 'Dark' : 'Light'}{current && <em> · showing</em>}</figcaption>
      <div className="sp-lenses" aria-hidden>
        <span className="sp-lens on">Worth reading</span>
        <span className="sp-lens">Saved</span>
      </div>
      {shown.map((it, i) => {
        const pic = i === 0 ? it.media.find((m) => m.type === 'image')?.thumb : undefined;
        return (
          <div className="sp-card" key={it.id}>
            <div className="sp-who"><span className="sp-av">{it.author.name.slice(0, 1).toUpperCase()}</span><b>{it.author.name}</b><small>2h</small></div>
            {it.title && <p className="sp-title">{it.title}</p>}
            {(!it.title || seed.density !== 'compact') && <p className="sp-text">{previewText(it.text).slice(0, 120)}</p>}
            {pic && seed.density !== 'compact' && <img className="sp-pic" src={pic} alt="" loading="lazy" />}
            <div className="sp-acts"><span className="sp-save"><Icon name="bookmarkFill" size={12} /> Saved</span><span className="sp-lit">Because you follow</span></div>
          </div>
        );
      })}
      <span className="sp-button" aria-hidden>Read now</span>
    </figure>
  );
}
