// Profiles in the UI: the switcher at the top of the rail, the "Make a profile" sheet with
// templates (which the AI can also fill), and the gentle schedule suggestion. A profile is a
// lens over the shared library plus its own views, rules, pages, theme and AI instructions.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ALL_PROFILE, PROFILE_COLORS, scheduleMatches } from '../../core/profiles.ts';
import { describeProfileSchedule, scheduledProfile } from '../../core/profileSchedule.ts';
import type { Profile, Source } from '../../core/types.ts';
import { api } from './api.ts';
import { Icon, PROFILE_ICONS } from './icons.tsx';
import type { Reader } from './state.ts';
import { THEME_PRESETS } from './themes.ts';
import { TodayRing, WeekStrip } from './TimeWell.tsx';
import { useTimeLog } from './timeWell.ts';
import { useDialog } from './useDialog.ts';

// Spoken names for the profile colours, so a screen reader does not read out hex codes.
const COLOR_NAMES: Record<string, string> = {
  '#7aa2f7': 'Blue', '#f7768e': 'Pink', '#9ece6a': 'Green', '#e0af68': 'Amber',
  '#bb9af7': 'Violet', '#7dcfff': 'Sky', '#ff9e64': 'Orange', '#73daca': 'Teal',
};
import './profiles.css';
import './profileHours.css';

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Alt+';
const DAY = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type Draft = Omit<Profile, 'id' | 'own' | 'position' | 'createdAt'> & { id?: string };

interface Template {
  key: string;
  name: string;
  icon: string;
  color: string;
  preset: string;
  instructions: string;
  /** Words that pick matching sources by label or platform. */
  match: RegExp;
  schedule?: Profile['schedule'];
  blurb: string;
}

export const TEMPLATES: Template[] = [
  { key: 'work', name: 'Work', icon: 'briefcase', color: '#7aa2f7', preset: 'tokyo-night', blurb: 'Industry news, tools, colleagues',
    instructions: 'Be terse. Focus on industry news, tools and the people I work with. Skip memes and politics.',
    match: /linkedin|hacker|github|dev|tech|work|industry|product|design|engineer|startup|verge|ars/i, schedule: { days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' } },
  { key: 'gaming', name: 'Gaming', icon: 'gamepad', color: '#bb9af7', preset: 'rose-pine', blurb: 'Streams, patch notes, releases',
    instructions: 'Lead with releases, patch notes and streams. Keep spoilers out of summaries.',
    match: /twitch|steam|game|gaming|pcgaming|nintendo|xbox|playstation|ign|polygon|kotaku|esports/i },
  { key: 'friends', name: 'Friends & family', icon: 'home', color: '#f7768e', preset: 'everforest', blurb: 'Life updates and photos',
    instructions: 'Warm and personal. Highlight life updates, photos and plans. Leave the news out.',
    match: /facebook|instagram|family|friends|whatsapp|bluesky/i, schedule: { days: [0, 6], from: '09:00', to: '21:00' } },
  { key: 'news', name: 'News', icon: 'news', color: '#e0af68', preset: 'gruvbox', blurb: 'The day, without the noise',
    instructions: 'Neutral and factual. Group stories, say when sources disagree, no hot takes.',
    match: /news|times|post|guardian|bbc|reuters|ap\b|npr|journal|economist|politic/i },
  { key: 'learning', name: 'Learning', icon: 'book', color: '#9ece6a', preset: 'nord', blurb: 'Ideas worth keeping',
    instructions: 'Pull out ideas worth remembering, each with one line on why it matters.',
    match: /youtube|substack|arxiv|blog|podcast|learn|course|science|research|essay|newsletter/i },
];

function emptyDraft(n: number): Draft {
  return { name: '', icon: 'star', color: PROFILE_COLORS[n % PROFILE_COLORS.length], look: null, instructions: '', sourceIds: [], inherit: false, edition: false, schedule: null, dailyMinutes: null };
}

/** A round avatar for a profile, in its colour, drawn with the app's icon set. */
export function ProfileAvatar({ p, size = 30, active }: { p: Pick<Profile, 'icon' | 'color' | 'name'> | null; size?: number; active?: boolean }) {
  const color = p?.color ?? 'var(--ink-2)';
  return (
    <span className={`prof-av ${active ? 'on' : ''} ${p ? '' : 'all'}`} style={{ width: size, height: size, ['--pc' as string]: color }} aria-hidden>
      <Icon name={p?.icon ?? 'layers'} size={Math.round(size * 0.52)} />
    </span>
  );
}

// ------------------------------------------------------------------ switcher

export function ProfileSwitcher({ r, onNew, onEdit, onTime, compact }: { r: Reader; onNew: () => void; onEdit: () => void; onTime?: () => void; compact?: boolean }) {
  const list: (Profile | null)[] = [null, ...r.profiles];
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const it of r.rawLib?.items ?? []) if (!it.state.read && !it.state.archived) m[it.sourceId] = (m[it.sourceId] ?? 0) + 1;
    return m;
  }, [r.rawLib?.items]);
  const unread = (p: Profile | null) => (p ? p.sourceIds.reduce((n, id) => n + (counts[id] ?? 0), 0) : 0);
  const cur = r.profile;
  // With no profiles yet the switcher is one quiet invitation, not an "All" chip that does nothing.
  if (!r.profiles.length) {
    return (
      <div className={`prof-switch none ${compact ? 'compact' : ''}`}>
        <button type="button" className="prof-invite" onClick={onNew} title="Profiles are lenses for Work, Gaming, Family…">
          <span className="prof-av add" aria-hidden><Icon name="plus" size={14} /></span>
          <span className="prof-invite-t">New profile</span>
          <span className="prof-invite-m">Work, Gaming, Family</span>
        </button>
      </div>
    );
  }
  return (
    <div className={`prof-switch ${compact ? 'compact' : ''}`} style={{ ['--pc' as string]: cur?.color ?? 'var(--lamp)' }}>
      <div className="prof-chips" role="radiogroup" aria-label="Profile">
        {list.map((p, i) => {
          const on = (p?.id ?? ALL_PROFILE) === r.profileId;
          const n = unread(p);
          return (
            <button
              key={p?.id ?? ALL_PROFILE}
              type="button"
              role="radio"
              aria-checked={on}
              className="prof-chip"
              title={`${p?.name ?? 'All'}${i < 9 ? ` · ${MOD}${i + 1}` : ''}`}
              aria-label={`${p?.name ?? 'All'}${n ? `, ${n} unread` : ''}`}
              onClick={() => (on && p ? onEdit() : r.switchProfile(p?.id ?? ALL_PROFILE))}
            >
              <ProfileAvatar p={p} active={on} />
              {n > 0 && !on && <span className="prof-dot" aria-hidden />}
            </button>
          );
        })}
        <button type="button" className="prof-chip prof-add" onClick={onNew} title="Make a profile" aria-label="Make a profile">
          <span className="prof-av add"><Icon name="plus" size={15} /></span>
        </button>
      </div>
      {!compact && (
        <div className="prof-now">
          <span className="prof-now-name">{cur?.name ?? 'All'}</span>
          <span className="prof-now-meta">{cur ? `${cur.sourceIds.length} source${cur.sourceIds.length === 1 ? '' : 's'}` : 'every source'}</span>
          {onTime && <TodayRing r={r} onOpen={onTime} />}
          {cur && <button type="button" className="mini-btn" onClick={onEdit} aria-label={`Edit ${cur.name}`}><Icon name="sliders" size={14} /></button>}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ schedule suggestion

/** Offers (never forces) a switch when a profile's suggested hours begin. Dismissed per day. */
export function ScheduleHint({ r }: { r: Reader }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem('sr.profileHint') ?? '[]');
    } catch {
      return [];
    }
  });
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const due = useMemo(
    () => r.profiles.find((p) => !p.schedule?.auto && scheduleMatches(p, now) && p.id !== r.profileId && !dismissed.includes(`${p.id}:${day}`)) ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [r.profiles, r.profileId, dismissed, tick],
  );
  if (!due) return null;
  const dismiss = () => {
    const next = [...dismissed, `${due.id}:${day}`];
    setDismissed(next);
    try {
      sessionStorage.setItem('sr.profileHint', JSON.stringify(next));
    } catch {
      /* storage blocked */
    }
  };
  return (
    <div className="prof-hint" role="status" style={{ ['--pc' as string]: due.color }}>
      <ProfileAvatar p={due} size={24} />
      <span className="prof-hint-t">{due.schedule!.from}–{due.schedule!.to} is usually <b>{due.name}</b> time.</span>
      <button type="button" className="btn small" onClick={() => { r.switchProfile(due.id); dismiss(); }}>Switch</button>
      <button type="button" className="icon-btn small" onClick={dismiss} aria-label="Not now"><Icon name="x" size={14} /></button>
    </div>
  );
}

// ------------------------------------------------------------------ profile hours

const HOURS_KEY = 'aurora.profileHours';
interface HoursState {
  /** The window last acted on ("id@start"), or null for "no window". */
  key?: string | null;
  /** The profile Aurora switched to for that window, while the user has not switched away. */
  switchedTo?: string | null;
  /** Where to go back to when the window ends. */
  returnTo?: string | null;
}
const loadHours = (): HoursState => {
  try {
    return JSON.parse(localStorage.getItem(HOURS_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
};
const saveHours = (s: HoursState) => {
  try {
    localStorage.setItem(HOURS_KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: the switch still happens, it may just happen again after a reload */
  }
};

/**
 * Switches profiles at the hours a profile asks for (schedule.auto), and back when they end. It
 * only acts when a window starts or ends, so a manual switch always wins until the next boundary,
 * and it switches back only if you are still where it put you. Renders nothing.
 */
export function ProfileHours({ r }: { r: Reader }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    const wake = () => document.visibilityState === 'visible' && setTick((n) => n + 1);
    document.addEventListener('visibilitychange', wake);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', wake);
    };
  }, []);
  const ref = useRef(r);
  ref.current = r;
  const ready = !!r.rawLib;
  useEffect(() => {
    const rd = ref.current;
    if (!ready) return;
    const cur = scheduledProfile(rd.profiles);
    const key = cur?.key ?? null;
    const st = loadHours();
    if (st.key === key) return;
    const nameOf = (id: string | null | undefined) => (!id || id === ALL_PROFILE ? 'All' : rd.profiles.find((p) => p.id === id)?.name ?? 'All');
    const stayed = !!st.switchedTo && rd.profileId === st.switchedTo;
    if (cur) {
      const p = cur.profile;
      if (rd.profileId === p.id) {
        saveHours({ key, switchedTo: stayed ? p.id : null, returnTo: stayed ? st.returnTo : null });
        return;
      }
      const returnTo = stayed ? st.returnTo ?? ALL_PROFILE : rd.profileId;
      saveHours({ key, switchedTo: p.id, returnTo });
      rd.switchProfile(p.id);
      rd.toast(`${p.name} hours: switched to ${p.name}.`, {
        undo: () => {
          saveHours({ key, switchedTo: null, returnTo: null });
          ref.current.switchProfile(returnTo);
        },
      });
      return;
    }
    saveHours({ key: null });
    if (stayed && st.returnTo && st.returnTo !== rd.profileId) {
      const from = st.switchedTo!;
      const back = st.returnTo;
      rd.switchProfile(back);
      rd.toast(`${nameOf(from)} hours are over: back to ${nameOf(back)}.`, { undo: () => ref.current.switchProfile(from) });
    }
  }, [tick, ready, r.profiles, r.profileId]);
  return null;
}

// ------------------------------------------------------------------ sheet

export function ProfileSheet({ r, editing, close, ask }: { r: Reader; editing: Profile | null; close: () => void; ask: (text: string, send?: boolean) => void }) {
  const dlg = useDialog<HTMLDivElement>();
  const sources = r.rawLib?.sources ?? [];
  const [d, setD] = useState<Draft>(() => (editing ? { ...editing } : emptyDraft(r.profiles.length)));
  const [tpl, setTpl] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [describe, setDescribe] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const applyTemplate = (t: Template) => {
    setTpl(t.key);
    const taken = new Set(r.profiles.map((p) => p.name.toLowerCase()));
    setD((x) => ({
      ...x,
      name: taken.has(t.name.toLowerCase()) ? `${t.name} 2` : t.name,
      icon: t.icon,
      color: t.color,
      look: { preset: t.preset, tokens: {} },
      instructions: t.instructions,
      schedule: t.schedule ?? null,
      sourceIds: sources.filter((s) => !s.isDemo && t.match.test(`${s.label} ${s.platform} ${String(s.config.url ?? '')}`)).map((s) => s.id),
    }));
  };

  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    const list = k ? sources.filter((s) => `${s.label} ${s.platform}`.toLowerCase().includes(k)) : sources;
    return [...list].sort((a, b) => Number(d.sourceIds.includes(b.id)) - Number(d.sourceIds.includes(a.id)) || a.label.localeCompare(b.label));
    // Keep the order stable while ticking boxes; re-sort only when the search changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, q]);
  const toggleSource = (s: Source) => set('sourceIds', d.sourceIds.includes(s.id) ? d.sourceIds.filter((x) => x !== s.id) : [...d.sourceIds, s.id]);

  const save = async () => {
    if (!d.name.trim()) {
      r.toast('Give the profile a name', { tone: 'error' });
      return;
    }
    setBusy(true);
    try {
      const body = { name: d.name, icon: d.icon, color: d.color, look: d.look, instructions: d.instructions, sourceIds: d.sourceIds, inherit: d.inherit, edition: d.edition, schedule: d.schedule, dailyMinutes: d.dailyMinutes ?? null };
      const p = editing ? await api.updateProfile(editing.id, body) : await api.createProfile(body);
      await r.reload();
      r.switchProfile(p.id);
      r.toast(editing ? `Saved ${p.name}` : `Made ${p.name}. New sources, views and rules you add now land here.`);
      close();
    } catch (e) {
      r.toast((e as Error).message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await api.deleteProfile(editing.id);
      r.switchProfile(ALL_PROFILE);
      await r.reload();
      r.toast(`Deleted ${editing.name}. Its views and rules are back in All; no posts or sources were removed.`);
      close();
    } catch (e) {
      r.toast((e as Error).message, { tone: 'error' });
    }
  };

  const fillWithAi = () => {
    const text = describe.trim();
    if (!text) return;
    close();
    ask(/profile/i.test(text) ? text : `Make me a profile: ${text}`, true);
  };

  const preset = d.look?.preset ?? '';
  const sched = d.schedule;
  const timeLog = useTimeLog();
  return (
    <div className="sheet-backdrop" onClick={close}>
      <div ref={dlg} className="sheet prof-sheet" role="dialog" aria-modal="true" aria-label={editing ? `Edit ${editing.name}` : 'Make a profile'} onClick={(e) => e.stopPropagation()} style={{ ['--pc' as string]: d.color }}>
        <div className="sheet-head">
          <h2>{editing ? `Edit ${editing.name}` : 'Make a profile'}</h2>
          <button className="icon-btn" onClick={close} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="sheet-body">
          {!editing && (
            <section className="f-sec">
              <p className="f-hint lead">A profile is a lens on your sources with its own views, rules, theme and AI manner. Posts are shared, never copied.</p>
              <div className="prof-tpls" role="radiogroup" aria-label="Start from a template">
                {TEMPLATES.map((t) => (
                  <button key={t.key} type="button" role="radio" aria-checked={tpl === t.key} className={`prof-tpl ${tpl === t.key ? 'on' : ''}`} style={{ ['--pc' as string]: t.color }} onClick={() => applyTemplate(t)}>
                    <ProfileAvatar p={t} size={32} active={tpl === t.key} />
                    <span className="prof-tpl-n">{t.name}</span>
                    <span className="prof-tpl-b">{t.blurb}</span>
                  </button>
                ))}
              </div>
              <form className="prof-ai" onSubmit={(e) => { e.preventDefault(); fillWithAi(); }}>
                <Icon name="sparkle" size={16} />
                <input value={describe} onChange={(e) => setDescribe(e.target.value)} placeholder="Or describe it: “a Gaming profile with my Twitch and r/pcgaming”" aria-label="Describe a profile for the AI to make" />
                <button type="submit" className="btn small" disabled={!describe.trim()}>Ask AI</button>
              </form>
            </section>
          )}

          <section className="f-sec">
            <div className="prof-name-row">
              <ProfileAvatar p={d} size={44} active />
              <input className="f-input prof-name" value={d.name} onChange={(e) => set('name', e.target.value.slice(0, 40))} placeholder="Name it: Work, Climbing, Family…" aria-label="Profile name" autoFocus={!editing} />
            </div>
            <span className="f-label">Icon</span>
            <div className="prof-icons" role="radiogroup" aria-label="Icon">
              {PROFILE_ICONS.map((ic) => (
                <button key={ic} type="button" role="radio" aria-checked={d.icon === ic} aria-label={ic} className={`prof-icon ${d.icon === ic ? 'on' : ''}`} onClick={() => set('icon', ic)}><Icon name={ic} size={17} /></button>
              ))}
            </div>
            <span className="f-label">Colour</span>
            <div className="prof-colors" role="radiogroup" aria-label="Colour">
              {PROFILE_COLORS.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={d.color === c} aria-label={COLOR_NAMES[c] ?? c} className={`prof-color ${d.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => set('color', c)} />
              ))}
              <label className="prof-color custom" title="Pick any colour">
                <input type="color" value={d.color} onChange={(e) => set('color', e.target.value)} aria-label="Custom colour" />
              </label>
            </div>
            <span className="f-label">Theme while this profile is on</span>
            <div className="prof-themes" role="radiogroup" aria-label="Theme">
              <button type="button" role="radio" aria-checked={!preset} className={`prof-theme ${!preset ? 'on' : ''}`} onClick={() => set('look', null)}>Same as All</button>
              {Object.entries(THEME_PRESETS).map(([id, t]) => (
                <button key={id} type="button" role="radio" aria-checked={preset === id} className={`prof-theme ${preset === id ? 'on' : ''}`} onClick={() => set('look', { preset: id, tokens: {} })}>
                  <span className="prof-theme-sw" style={{ background: t.dark.lamp ?? t.dark['glow-on'] ?? 'var(--lamp)' }} />{t.label}
                </button>
              ))}
            </div>
          </section>

          <section className="f-sec">
            <div className="f-row-head">
              <h3>Sources <span className="prof-count">{d.sourceIds.length} of {sources.length}</span></h3>
              <span>
                <button type="button" className="link-btn" onClick={() => set('sourceIds', sources.map((s) => s.id))}>All</button>{' · '}
                <button type="button" className="link-btn" onClick={() => set('sourceIds', [])}>None</button>
              </span>
            </div>
            <p className="f-hint">A source can be in many profiles. New sources you add while this profile is on join it.</p>
            {sources.length > 8 && <input className="f-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a source" aria-label="Find a source" />}
            <div className="prof-sources">
              {shown.map((s) => (
                <label key={s.id} className={`prof-src ${d.sourceIds.includes(s.id) ? 'on' : ''}`}>
                  <input type="checkbox" checked={d.sourceIds.includes(s.id)} onChange={() => toggleSource(s)} />
                  <span className="prof-src-l">{s.label}</span>
                  <span className="prof-src-m">{s.platform}{s.isDemo ? ' · demo' : ''} · {s.itemCount}</span>
                </label>
              ))}
              {!sources.length && <p className="f-hint">No sources yet. Add some from Sources &amp; imports, or ask the AI.</p>}
            </div>
          </section>

          <section className="f-sec">
            <h3>How the AI behaves here</h3>
            <textarea className="f-input prof-instr" rows={3} value={d.instructions ?? ''} onChange={(e) => set('instructions', e.target.value.slice(0, 1200))} placeholder="In Work, be terse and focus on industry news." aria-label="AI instructions for this profile" />
            <label className="switch">
              <input type="checkbox" checked={!!d.edition} onChange={(e) => set('edition', e.target.checked)} />
              <span>Its own morning edition<small>A daily page written only from this profile's sources, in its manner.</small></span>
            </label>
            <label className="switch">
              <input type="checkbox" checked={!!d.inherit} onChange={(e) => set('inherit', e.target.checked)} />
              <span>Also use All's views and rules<small>Otherwise this profile starts clean and keeps its own.</small></span>
            </label>
          </section>

          <section className="f-sec">
            <label className="switch">
              <input type="checkbox" checked={!!sched} onChange={(e) => set('schedule', e.target.checked ? { days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00', auto: true } : null)} />
              <span>Use it at set times<small>Work 9 to 5, Gaming in the evening. A switch you make yourself always wins.</small></span>
            </label>
            {sched && (
              <div className="prof-sched">
                <div className="prof-hours-row">
                  <div className="seg" role="radiogroup" aria-label="At those times">
                    <button type="button" role="radio" aria-checked={!!sched.auto} className={sched.auto ? 'on' : ''} onClick={() => set('schedule', { ...sched, auto: true })}>Switch by itself</button>
                    <button type="button" role="radio" aria-checked={!sched.auto} className={!sched.auto ? 'on' : ''} onClick={() => set('schedule', { ...sched, auto: false })}>Only suggest</button>
                  </div>
                </div>
                <div className="prof-days" role="group" aria-label="Days">
                  {DAY.map((l, i) => (
                    <button key={i} type="button" aria-pressed={sched.days.includes(i)} aria-label={DAY_NAME[i]} className={`prof-day ${sched.days.includes(i) ? 'on' : ''}`} onClick={() => set('schedule', { ...sched, days: sched.days.includes(i) ? sched.days.filter((x) => x !== i) : [...sched.days, i].sort() })}>{l}</button>
                  ))}
                </div>
                <div className="prof-times">
                  <input type="time" className="f-input" value={sched.from} onChange={(e) => set('schedule', { ...sched, from: e.target.value })} aria-label="From" />
                  <span>to</span>
                  <input type="time" className="f-input" value={sched.to} onChange={(e) => set('schedule', { ...sched, to: e.target.value })} aria-label="To" />
                </div>
                <p className="prof-hours-readback" aria-live="polite">{sched.days.length ? describeProfileSchedule(sched, d.name) : 'Pick at least one day.'}</p>
              </div>
            )}
          </section>

          <section className="f-sec">
            <label className="switch">
              <input type="checkbox" checked={!!d.dailyMinutes} onChange={(e) => set('dailyMinutes', e.target.checked ? 30 : null)} />
              <span>A gentle daily limit<small>When today's time here reaches it, the feed ends with a card. It never blocks; Keep going always works.</small></span>
            </label>
            {!!d.dailyMinutes && (
              <div className="prof-limit">
                <input type="number" className="f-input" min={5} max={720} step={5} value={d.dailyMinutes} onChange={(e) => set('dailyMinutes', Math.min(720, Math.max(1, Number(e.target.value) || 5)))} aria-label="Minutes a day" />
                <span>minutes a day</span>
              </div>
            )}
            {editing && <WeekStrip log={timeLog} profile={editing.id} color={d.color} limit={d.dailyMinutes} />}
          </section>
        </div>
        <div className="sheet-foot">
          {editing ? (
            <button type="button" className={`btn ${confirmDelete ? 'danger' : 'ghost'}`} onClick={() => void remove()}>
              {confirmDelete ? `Delete ${editing.name}?` : <><Icon name="trash" size={15} /> Delete</>}
            </button>
          ) : <span />}
          <button type="button" className="btn primary prof-save" disabled={busy || !d.name.trim()} onClick={() => void save()}>
            {busy ? 'Saving…' : editing ? 'Save' : `Make ${d.name.trim() || 'profile'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
