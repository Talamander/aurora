// Profiles: user-defined contexts (Work, Gaming, Family...) over one shared library. They live in
// one settings row, so the feature is reversible: with no profiles every object belongs to the
// built-in "All" profile and the app behaves exactly as before. Items are never copied.
//
// The server keeps one active profile. New sources, views, pages and AI rules join it (through
// Store.onCreate), and the AI's tools see the library through it.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { ALL_PROFILE, findProfile, PROFILE_COLORS, slug, type OwnedKind } from '../core/profiles.ts';
import type { Profile } from '../core/types.ts';
import { cleanLimit } from '../core/timeSpent.ts';
import type { Store } from './db.ts';

type RouteFn = (
  method: string,
  path: string,
  handler: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, body: any, url: URL) => unknown,
) => void;

const KEY = 'profiles';
const ACTIVE = 'profile.active';
const MAX_PROFILES = 24;
const ICON_RE = /^[a-z][a-z0-9-]{0,23}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export class ProfileError extends Error {}

export type Profiles = ReturnType<typeof createProfiles>;

const strs = (v: unknown, max = 2000) => (Array.isArray(v) ? [...new Set(v.map(String).filter((x) => x && x.length <= 200))].slice(0, max) : []);

function cleanLook(v: any): Profile['look'] {
  if (!v || typeof v !== 'object') return null;
  const tokens: Record<string, string> = {};
  for (const [k, val] of Object.entries(v.tokens ?? {})) {
    if (!/^[a-z0-9-]{1,24}$/.test(k)) continue;
    const s = String(val).slice(0, 200);
    if (/[;{}<>]|url\s*\(|expression|@import/i.test(s)) continue;
    tokens[k] = s;
  }
  const preset = typeof v.preset === 'string' && /^[a-z0-9-]{1,40}$/.test(v.preset) ? v.preset : undefined;
  const mode = v.mode === 'dark' || v.mode === 'light' ? v.mode : undefined;
  if (!preset && !mode && !Object.keys(tokens).length) return null;
  return { preset, mode, tokens };
}

function cleanSchedule(v: any): Profile['schedule'] {
  if (!v || typeof v !== 'object') return null;
  const days = Array.isArray(v.days) ? [...new Set(v.days.map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() as number[] : [];
  if (!days.length || !TIME_RE.test(String(v.from)) || !TIME_RE.test(String(v.to))) return null;
  return { days, from: String(v.from), to: String(v.to), ...(v.auto === true ? { auto: true } : {}) };
}

export function createProfiles(store: Store) {
  function list(): Profile[] {
    const raw = store.getSetting<Profile[]>(KEY);
    return Array.isArray(raw) ? [...raw].sort((a, b) => a.position - b.position) : [];
  }
  function write(next: Profile[]) {
    store.setSetting(KEY, next.length ? next.map((p, i) => ({ ...p, position: i })) : null);
  }
  function get(key: string | null | undefined): Profile | null {
    return findProfile(list(), key);
  }
  function active(): string {
    const id = store.getSetting<string>(ACTIVE);
    return id && list().some((p) => p.id === id) ? id : ALL_PROFILE;
  }
  function setActive(key: string | null | undefined) {
    const p = key && key !== ALL_PROFILE ? get(key) : null;
    if (key && key !== ALL_PROFILE && !p) throw new ProfileError('No such profile');
    store.setSetting(ACTIVE, p ? p.id : null);
    return p?.id ?? ALL_PROFILE;
  }

  /** Create (no id) or update a profile. Unknown fields are ignored; every field is checked. */
  function save(input: Record<string, any>): Profile {
    const all = list();
    const prev = input.id ? all.find((p) => p.id === input.id) : undefined;
    if (input.id && !prev) throw new ProfileError('No such profile');
    const name = String(input.name ?? prev?.name ?? '').trim().slice(0, 40);
    if (!name) throw new ProfileError('A profile needs a name');
    if (name.toLowerCase() === 'all') throw new ProfileError('"All" is the built-in profile; pick another name');
    if (all.some((p) => p.id !== prev?.id && p.name.toLowerCase() === name.toLowerCase())) throw new ProfileError(`There is already a profile called ${name}`);
    if (!prev && all.length >= MAX_PROFILES) throw new ProfileError(`At most ${MAX_PROFILES} profiles`);
    const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
    let id = prev?.id;
    if (!id) {
      const base = slug(name).slice(0, 24) || 'profile';
      id = base === ALL_PROFILE || all.some((p) => p.id === base) ? `${base}-${randomBytes(2).toString('hex')}` : base;
    }
    const p: Profile = {
      id,
      name,
      icon: has('icon') && ICON_RE.test(String(input.icon)) ? String(input.icon) : prev?.icon ?? 'star',
      color: has('color') && COLOR_RE.test(String(input.color)) ? String(input.color) : prev?.color ?? PROFILE_COLORS[all.length % PROFILE_COLORS.length],
      look: has('look') ? cleanLook(input.look) : prev?.look ?? null,
      instructions: has('instructions') ? String(input.instructions ?? '').trim().slice(0, 1200) : prev?.instructions ?? '',
      sourceIds: has('sourceIds') ? strs(input.sourceIds) : prev?.sourceIds ?? [],
      own: prev?.own ?? { views: [], pages: [], aiRules: [] },
      inherit: has('inherit') ? Boolean(input.inherit) : prev?.inherit ?? false,
      edition: has('edition') ? Boolean(input.edition) : prev?.edition ?? false,
      schedule: has('schedule') ? cleanSchedule(input.schedule) : prev?.schedule ?? null,
      dailyMinutes: has('dailyMinutes') ? cleanLimit(input.dailyMinutes) : prev?.dailyMinutes ?? null,
      position: prev?.position ?? all.length,
      createdAt: prev?.createdAt ?? new Date().toISOString(),
    };
    write(prev ? all.map((x) => (x.id === p.id ? p : x)) : [...all, p]);
    return p;
  }

  /** Delete a profile. Its views, pages and rules go back to "All"; no posts or sources are touched. */
  function remove(id: string) {
    const all = list();
    if (!all.some((p) => p.id === id)) throw new ProfileError('No such profile');
    write(all.filter((p) => p.id !== id));
    if (store.getSetting<string>(ACTIVE) === id) store.setSetting(ACTIVE, null);
  }

  function reorder(ids: string[]) {
    const all = list();
    const rank = new Map(ids.map((id, i) => [id, i]));
    write([...all].sort((a, b) => (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99)));
  }

  function sources(id: string, change: { add?: string[]; remove?: string[] }) {
    const p = list().find((x) => x.id === id);
    if (!p) throw new ProfileError('No such profile');
    const drop = new Set(change.remove ?? []);
    const next = [...new Set([...p.sourceIds, ...(change.add ?? [])])].filter((s) => !drop.has(s));
    return save({ id, sourceIds: next });
  }

  /** Give a view, page or AI rule to a profile ("all" makes it unowned again). */
  function move(kind: OwnedKind, objectId: string, to: string) {
    const all = list();
    if (to !== ALL_PROFILE && !all.some((p) => p.id === to)) throw new ProfileError('No such profile');
    write(all.map((p) => {
      const rest = p.own[kind].filter((x) => x !== objectId);
      return { ...p, own: { ...p.own, [kind]: p.id === to ? [...rest, objectId] : rest } };
    }));
  }

  /** Store.onCreate: new things join the active profile. The edition places its own pages. */
  function adopt(kind: 'source' | 'view' | 'page' | 'aiRule', id: string) {
    const pid = active();
    if (pid === ALL_PROFILE) return;
    if (kind === 'page' && id.startsWith('morning-edition')) return;
    if (kind === 'source') {
      sources(pid, { add: [id] });
      return;
    }
    move(kind === 'view' ? 'views' : kind === 'page' ? 'pages' : 'aiRules', id, pid);
  }

  return { list, get, active, setActive, save, remove, reorder, sources, move, adopt };
}

export function registerProfileRoutes(
  route: RouteFn,
  deps: { profiles: Profiles; HttpError: new (status: number, message: string) => Error; changed: (reason: string) => void },
) {
  const { profiles, HttpError, changed } = deps;
  const guard = <T>(fn: () => T): T => {
    try {
      const out = fn();
      changed('profile');
      return out;
    } catch (e) {
      if (e instanceof ProfileError) throw new HttpError(400, e.message);
      throw e;
    }
  };
  const kinds: Record<string, OwnedKind> = { view: 'views', views: 'views', page: 'pages', pages: 'pages', aiRule: 'aiRules', aiRules: 'aiRules', rule: 'aiRules' };

  route('GET', '/api/profiles', () => ({ profiles: profiles.list(), active: profiles.active() }));
  route('POST', '/api/profiles', (_q, _s, _p, body) => guard(() => profiles.save({ ...(body ?? {}), id: undefined })));
  route('PUT', '/api/profiles/active', (_q, _s, _p, body) => guard(() => ({ active: profiles.setActive(body?.id ? String(body.id) : null) })));
  route('PUT', '/api/profiles/order', (_q, _s, _p, body) => guard(() => (profiles.reorder(strs(body?.ids, MAX_PROFILES)), { profiles: profiles.list() })));
  route('POST', '/api/profiles/move', (_q, _s, _p, body) => {
    const kind = kinds[String(body?.kind)];
    if (!kind) throw new HttpError(400, 'kind must be view, page or aiRule');
    return guard(() => (profiles.move(kind, String(body?.id ?? ''), String(body?.to ?? ALL_PROFILE)), { ok: true }));
  });
  route('PATCH', '/api/profiles/:id', (_q, _s, p, body) => guard(() => profiles.save({ ...(body ?? {}), id: p.id })));
  route('POST', '/api/profiles/:id/sources', (_q, _s, p, body) => guard(() => profiles.sources(p.id, { add: strs(body?.add), remove: strs(body?.remove) })));
  route('DELETE', '/api/profiles/:id', (_q, _s, p) => guard(() => (profiles.remove(p.id), { ok: true })));
}
