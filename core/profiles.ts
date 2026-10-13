// Profiles as pure functions: which part of the shared library a profile sees. Shared by the
// server (agent tools, feeds, MCP, edition) and the web app, which scopes client-side so that
// switching profiles is instant. core/filter.ts stays unaware of profiles.

import { windowAt } from './profileSchedule.ts';
import type { Item, Library, Profile } from './types.ts';

export const ALL_PROFILE = 'all';
export type OwnedKind = 'views' | 'pages' | 'aiRules';

export const PROFILE_COLORS = ['#7aa2f7', '#f7768e', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff', '#ff9e64', '#73daca'];

/** The id of the profile that owns an object; "all" when no profile does. */
export function ownerOf(profiles: Profile[] | undefined, kind: OwnedKind, id: string): string {
  for (const p of profiles ?? []) if (p.own[kind].includes(id)) return p.id;
  return ALL_PROFILE;
}

export interface Lens {
  id: string;
  profile: Profile | null;
  /** Whether posts from this source show in the profile. */
  source: (sourceId: string) => boolean;
  /** Whether a view, page or AI rule belongs to the profile. */
  owns: (kind: OwnedKind, id: string) => boolean;
  /** Whether a post shows in the profile: by its source, or for a friend's share, by circle routing. */
  item: (item: Pick<Item, 'sourceId' | 'externalId' | 'provenance'>) => boolean;
}

/** Profile id to friend fingerprint prefixes (16 hex), from circles mapped to profiles. */
export type FriendRouting = Record<string, string[]>;

/** Posts from Aurora friends carry the sender's fingerprint prefix as the start of their external id. */
export const isFriendItem = (i: Pick<Item, 'provenance'>) => i.provenance?.connector === 'friends';

export function makeLens(profiles: Profile[] | undefined, id: string | null | undefined, routing?: FriendRouting): Lens {
  const list = profiles ?? [];
  const profile = id && id !== ALL_PROFILE ? list.find((p) => p.id === id) ?? null : null;
  const owner: Record<OwnedKind, Map<string, string>> = { views: new Map(), pages: new Map(), aiRules: new Map() };
  for (const p of list) for (const k of ['views', 'pages', 'aiRules'] as const) for (const x of p.own[k]) if (!owner[k].has(x)) owner[k].set(x, p.id);
  if (!profile) return { id: ALL_PROFILE, profile: null, source: () => true, owns: (k, x) => !owner[k].has(x), item: () => true };
  const sources = new Set(profile.sourceIds);
  // When circles are mapped to this profile, friends' shares follow the circles: only members'
  // shares show here, whether or not the Friends source is in the profile. Otherwise the Friends
  // source behaves like any other source.
  const routed = routing?.[profile.id]?.length ? new Set(routing[profile.id]) : null;
  return {
    id: profile.id,
    profile,
    source: (s) => sources.has(s),
    item: (i) => (routed && isFriendItem(i) ? routed.has(i.externalId.slice(0, 16)) : sources.has(i.sourceId)),
    owns: (k, x) => {
      const o = owner[k].get(x);
      return o === profile.id || (!o && !!profile.inherit);
    },
  };
}

/** The library as one profile sees it. "All" sees every post but only the objects no profile owns. */
export function scopeLibrary(lib: Library, id: string | null | undefined): Library {
  if (!lib.profiles?.length) return lib;
  const lens = makeLens(lib.profiles, id, lib.friendRouting);
  const p = lens.profile;
  const routed = Boolean(p && lib.friendRouting?.[p.id]?.length);
  return {
    ...lib,
    items: p ? lib.items.filter((i) => lens.item(i)) : lib.items,
    sources: p ? lib.sources.filter((s) => lens.source(s.id) || (routed && s.connector === 'friends')) : lib.sources,
    syncRuns: p ? lib.syncRuns.filter((r) => lens.source(r.sourceId)) : lib.syncRuns,
    views: lib.views.filter((v) => lens.owns('views', v.id)),
    pages: lib.pages?.filter((pg) => lens.owns('pages', pg.id)),
    aiRules: lib.aiRules?.filter((r) => lens.owns('aiRules', r.id)),
  };
}

export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Find a profile by id or by name (case-insensitive), for ?p= links and the agent. */
export function findProfile(profiles: Profile[] | undefined, key: string | null | undefined): Profile | null {
  if (!key) return null;
  const k = key.trim().toLowerCase();
  return (profiles ?? []).find((p) => p.id === key || p.name.toLowerCase() === k || slug(p.name) === k) ?? null;
}

/** Whether a profile's schedule covers this moment (see core/profileSchedule.ts). */
export function scheduleMatches(p: Profile, at = new Date()): boolean {
  return windowAt(p.schedule, at) !== null;
}

/** The morning edition's page id for a profile. */
export function editionId(profileId: string | null | undefined): string {
  return !profileId || profileId === ALL_PROFILE ? 'morning-edition' : `morning-edition--${profileId}`;
}
