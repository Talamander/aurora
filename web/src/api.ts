import type { AgentEvent, AgentThread, Item, ItemState, Library, Page, Profile, SavedView, Source, Topic, FilterSpec } from '../../core/types.ts';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export type AlertDef = import('../../core/alerts.ts').Alert;
export interface AlertHitView {
  id: string;
  alertId: string;
  itemId: string;
  reason: string;
  at: string;
  seen: boolean;
  alertName: string;
  item: { author: string; avatar?: string; text: string; platform: string; url: string; publishedAt: string; media?: string } | null;
}
export type RoutineDef = import('../../core/routines.ts').Routine;
export type RoutineRunView = import('../../core/routines.ts').RoutineRun;
export type RoutineView = RoutineDef & { when: string; nextRunAt: string | null; running: boolean; queued: boolean; monthSpent: number; lastRun: RoutineRunView | null; runs: RoutineRunView[] };
export interface RoutinesSummary {
  routines: RoutineView[];
  aiReady: boolean;
  aiReason: string | null;
}
export interface RoutineEdit {
  text?: string;
  name?: string;
  prompt?: string;
  schedule?: import('../../core/routines.ts').Schedule | string;
  profile?: string | null;
  runCapUsd?: number;
  monthCapUsd?: number;
  enabled?: boolean;
}

export interface AlertsSummary {
  alerts: AlertDef[];
  hits: AlertHitView[];
  unseen: number;
  quiet: { from: string; to: string } | null;
  quietNow: boolean;
  aiReady: boolean;
}

export interface SyncResult {
  added?: number;
  updated?: number;
  skipped?: number;
  errors?: string[];
  blocked?: string;
  error?: string;
  alreadyRunning?: boolean;
}

export interface TasteSuggestion {
  id: string;
  kind: 'rule' | 'view';
  title: string;
  why: string;
  rule?: { name: string; prompt: string; action: 'hide' | 'only' | 'tag' };
  view?: { name: string; spec: Partial<FilterSpec> };
}
export interface TasteState {
  suggestions: TasteSuggestion[];
  at: string | null;
  building: boolean;
  canSuggest: boolean;
}

export type FollowTargetView = import('../../core/follows.ts').FollowTarget;
export type FollowJobView = import('../../server/follows.ts').FollowJob;
export type FollowPlanView = {
  items: { key: string; lane: import('../../server/follows.ts').Lane }[];
  platforms: import('../../server/follows.ts').PlatformPlan[];
  cost: { min: number; max: number; median: number; samples: number; builds: number; low: number; high: number };
  aiReady: boolean;
};

export const api = {
  search: (q: string, limit = 20, profile?: string) =>
    call<import('../../core/search.ts').SearchResult>('GET', `/api/search?q=${encodeURIComponent(q)}&limit=${limit}${profile ? `&profile=${encodeURIComponent(profile)}` : ''}`),
  related: (id: string, limit = 10, profile?: string) =>
    call<{ id: string; results: import('../../core/search.ts').RelatedHit[] }>('GET', `/api/items/${encodeURIComponent(id)}/related?limit=${limit}${profile ? `&profile=${encodeURIComponent(profile)}` : ''}`),
  library: () => call<Library>('GET', '/api/library'),
  setState: (ids: string[], patch: Partial<ItemState>) => call<{ items: Item[] }>('POST', '/api/items/state', { ids, patch }),
  addSource: (connector: string, config: Record<string, unknown>) => call<{ source: Source; result: SyncResult }>('POST', '/api/sources', { connector, config }),
  updateSource: (id: string, patch: { label?: string; enabled?: boolean }) => call<Source>('PATCH', `/api/sources/${id}`, patch),
  deleteSource: (id: string) => call('DELETE', `/api/sources/${id}`),
  syncSource: (id: string) => call<SyncResult>('POST', `/api/sources/${id}/sync`, {}),
  syncAll: () => call('POST', '/api/sync', {}),
  importFile: (fileName: string, text: string) => call<{ source?: Source; feedsAdded?: number; added: number; updated: number; skipped: number; errors: string[] }>('POST', '/api/import', { fileName, text }),
  loadDemo: () => call<{ source: Source; added: number }>('POST', '/api/demo', {}),
  saveView: (v: { id?: string; name: string; spec: FilterSpec }) => call<SavedView>('POST', '/api/views', v),
  deleteView: (id: string) => call('DELETE', `/api/views/${id}`),
  saveTopic: (t: { id?: string; name: string; terms: string[] }) => call<Topic>('POST', '/api/topics', t),
  deleteTopic: (id: string) => call('DELETE', `/api/topics/${id}`),
  addCollection: (name: string) => call<{ collections: string[] }>('POST', '/api/collections', { name }),
  deleteCollection: (name: string) => call<{ collections: string[] }>('DELETE', `/api/collections/${encodeURIComponent(name)}`),
  getSetting: <T,>(key: string) => call<{ value: T | null }>('GET', `/api/settings/${key}`),
  putSetting: (key: string, value: unknown) => call('PUT', `/api/settings/${key}`, { value }),
  followsPlan: (targets: FollowTargetView[]) => call<FollowPlanView>('POST', '/api/follows/plan', { targets }),
  followsBluesky: (handle: string) => call<{ targets: FollowTargetView[] }>('POST', '/api/follows/bluesky', { handle }),
  followsStart: (targets: FollowTargetView[], profiles: Record<string, string>) => call<{ job: FollowJobView }>('POST', '/api/follows/start', { targets, profiles }),
  followsJob: () => call<{ job: FollowJobView | null; running: boolean }>('GET', '/api/follows/job'),
  followsCancel: () => call<{ job: FollowJobView | null }>('POST', '/api/follows/cancel', {}),
  followsClear: () => call('POST', '/api/follows/clear', {}),
  timeLog: () => call<{ log: import('../../core/timeSpent.ts').TimeLog }>('GET', '/api/time'),
  /** Reports active reading seconds. keepalive lets the last report finish while the page closes. */
  timeTick: (day: string, profile: string, seconds: number, keepalive = false) =>
    fetch('/api/time/tick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ day, profile, seconds }), keepalive, credentials: 'same-origin' }).then((r) => r.ok),
  routines: () => call<RoutinesSummary>('GET', '/api/routines'),
  createRoutine: (r: RoutineEdit) => call<RoutineView>('POST', '/api/routines', r),
  updateRoutine: (id: string, patch: RoutineEdit) => call<RoutineView>('PATCH', `/api/routines/${encodeURIComponent(id)}`, patch),
  deleteRoutine: (id: string) => call('DELETE', `/api/routines/${encodeURIComponent(id)}`),
  planRoutine: (id: string) => call<RoutineView>('POST', `/api/routines/${encodeURIComponent(id)}/plan`, {}),
  runRoutine: (id: string) => call<{ queued: boolean }>('POST', `/api/routines/${encodeURIComponent(id)}/run`, {}),
  alerts: () => call<AlertsSummary>('GET', '/api/alerts'),
  createAlert: (a: Partial<AlertDef>) => call<AlertDef>('POST', '/api/alerts', a),
  updateAlert: (id: string, patch: Partial<AlertDef>) => call<AlertDef>('PATCH', `/api/alerts/${encodeURIComponent(id)}`, patch),
  deleteAlert: (id: string) => call('DELETE', `/api/alerts/${encodeURIComponent(id)}`),
  previewAlert: (id: string) => call<{ checked: number; ai: boolean; total: number; matches: AlertHitView[] }>('POST', `/api/alerts/${encodeURIComponent(id)}/preview`, {}),
  alertsSeen: (ids?: string[]) => call('POST', '/api/alerts/seen', { ids }),
  setQuietHours: (quiet: { from: string; to: string } | null) => call<{ quiet: { from: string; to: string } | null; quietNow: boolean }>('PUT', '/api/alerts/quiet', { quiet }),
  desktopTheme: () => call<{ theme: import('./themes.ts').DesktopTheme | null }>('GET', '/api/desktop-theme'),
  agentStatus: () => call<AgentStatus>('GET', '/api/agent/status'),
  threads: (kind?: string) => call<AgentThread[]>('GET', `/api/agent/threads${kind ? `?kind=${kind}` : ''}`),
  newThread: () => call<AgentThread>('POST', '/api/agent/threads', {}),
  thread: (id: string, after = 0) => call<{ thread: AgentThread; events: AgentEvent[]; jobs: AgentThread[]; running: boolean }>('GET', `/api/agent/threads/${id}?after=${after}`),
  say: (id: string, text: string, context: unknown) => call<{ ok: true }>('POST', `/api/agent/threads/${id}/messages`, { text, context }),
  stop: (id: string) => call('POST', `/api/agent/threads/${id}/stop`, {}),
  undoChange: (id: string) => call<{ text: string }>('POST', `/api/agent/changes/${id}/undo`, {}),
  savePage: (p: { id?: string; name: string; icon?: string | null; blocks: Page['blocks'] }) => call<Page>('POST', '/api/pages', p),
  deletePage: (id: string) => call('DELETE', `/api/pages/${id}`),
  patchAiRule: (id: string, patch: { enabled: boolean }) => call('PATCH', `/api/ai-rules/${id}`, patch),
  catchUp: (since: string, ids?: string[], profile?: string) => call<{ text: string; postIds: string[]; count: number; since: string }>('POST', '/api/catchup', { since, ids, profile }),
  personAbout: (key: string, ids: string[]) => call<{ about: string }>('POST', '/api/person/about', { key, ids }),
  taste: () => call<TasteState>('GET', '/api/taste'),
  refreshTaste: (muted: string[], excluded: string[]) => call<TasteState>('POST', '/api/taste/refresh', { muted, excluded }),
  dismissTaste: (id: string) => call<TasteState>('POST', `/api/taste/${id}/dismiss`, {}),
  acceptTaste: (id: string) => call<TasteState & { created: { kind: 'rule' | 'view'; id: string; name: string; spec?: FilterSpec } }>('POST', `/api/taste/${id}/accept`, {}),
  buildEdition: (profile?: string) => call<{ ok: boolean; message: string; pageId?: string }>('POST', '/api/edition', { profile }),
  profiles: () => call<{ profiles: Profile[]; active: string }>('GET', '/api/profiles'),
  createProfile: (p: Partial<Profile>) => call<Profile>('POST', '/api/profiles', p),
  updateProfile: (id: string, patch: Partial<Profile>) => call<Profile>('PATCH', `/api/profiles/${encodeURIComponent(id)}`, patch),
  deleteProfile: (id: string) => call('DELETE', `/api/profiles/${encodeURIComponent(id)}`),
  setActiveProfile: (id: string) => call<{ active: string }>('PUT', '/api/profiles/active', { id }),
  orderProfiles: (ids: string[]) => call('PUT', '/api/profiles/order', { ids }),
  profileSources: (id: string, change: { add?: string[]; remove?: string[] }) => call<Profile>('POST', `/api/profiles/${encodeURIComponent(id)}/sources`, change),
  moveToProfile: (kind: 'view' | 'page' | 'aiRule', id: string, to: string) => call('POST', '/api/profiles/move', { kind, id, to }),
  deleteAiRule: (id: string) => call('DELETE', `/api/ai-rules/${id}`),
  xStatus: () => call<{ configured: boolean; connected: boolean; redirectUri?: string }>('GET', '/api/x/status'),
};

export interface AgentStatus {
  ready: boolean;
  provider: 'claude' | 'openai';
  model: string;
  builderModel: string;
  via?: string;
  reason?: string;
  hasKey: boolean;
  config: { provider: string; model: string; builderModel: string; baseUrl: string | null };
}
