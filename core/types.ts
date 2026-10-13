// Shared domain model for Aurora.
// Pure TypeScript with no runtime dependencies, so the same module can run in
// the Node server, the web client and a future React Native app.

export type KnownPlatform =
  | 'x'
  | 'bluesky'
  | 'mastodon'
  | 'reddit'
  | 'youtube'
  | 'instagram'
  | 'facebook'
  | 'threads'
  | 'tiktok'
  | 'linkedin'
  | 'telegram'
  | 'hackernews'
  | 'rss'
  | 'web'
  | 'import'
  | 'demo';

/** Known platforms get labels and colours; AI-built actors may name any other platform. */
export type Platform = KnownPlatform | (string & {});

export type ItemKind = 'post' | 'reply' | 'repost' | 'thread' | 'article' | 'video';

export type MediaType = 'image' | 'video' | 'link';

export interface Media {
  type: MediaType;
  url: string;
  alt?: string;
  thumb?: string;
}

export interface Author {
  name: string;
  handle?: string;
  url?: string;
  avatar?: string;
}

/** Where an item came from and how. Shown in the reader so nothing is anonymous. */
export interface Provenance {
  connector: string; // connector id, e.g. "rss", "x-archive"
  connectorVersion: number;
  via: 'api' | 'feed' | 'import' | 'demo' | 'friend';
  fileName?: string;
  feedUrl?: string;
}

/** Local-only reading state. Never written back to the source platform. */
export interface ItemState {
  read: boolean;
  saved: boolean;
  archived: boolean;
  collections: string[];
  /** User override for the noise classifier: true = never noise, false = always noise. */
  noiseOverride?: boolean | null;
  readAt?: string | null;
  savedAt?: string | null;
}

export interface Item {
  id: string; // `${platform}:${externalId}`
  sourceId: string;
  platform: Platform;
  externalId: string;
  url: string; // original link, always preserved
  author: Author;
  title?: string;
  text: string; // plain text only, never HTML
  links: string[];
  media: Media[];
  quoted?: { author: Author; text: string; url?: string } | null;
  lang?: string | null;
  /** True when `lang` was guessed locally because the source gave none. */
  langGuessed?: boolean;
  kind: ItemKind;
  /** External id of the post this one replies to, on the same platform, when the source says. */
  replyTo?: string | null;
  publishedAt: string; // ISO
  ingestedAt: string; // ISO
  provenance: Provenance;
  metrics?: { likes?: number; reposts?: number; replies?: number } | null;
  /** Canonical key used for cross-source dedupe (canonical URL or text hash). */
  dedupeKey: string;
  isDemo: boolean;
  state: ItemState;
}

export type SourceStatus = 'ok' | 'error' | 'blocked' | 'syncing' | 'never';

export interface Source {
  id: string;
  connector: string;
  label: string;
  platform: Platform;
  /** Non-secret configuration only (feed URL, handle, file name). */
  config: Record<string, unknown>;
  status: SourceStatus;
  statusDetail?: string | null;
  lastSyncAt?: string | null;
  itemCount: number;
  enabled: boolean;
  isDemo: boolean;
  createdAt: string;
}

export interface SyncRun {
  id: string;
  sourceId: string;
  startedAt: string;
  finishedAt?: string | null;
  ok: boolean;
  added: number;
  updated: number;
  skipped: number;
  errors: string[];
}

/** A user-defined topic: a named keyword list. Matching is explained per item. */
export interface Topic {
  id: string;
  name: string;
  terms: string[];
}

export type ReadFilter = 'any' | 'unread' | 'read';
export type SavedFilter = 'any' | 'saved' | 'unsaved';
export type ArchivedFilter = 'hide' | 'only' | 'any';
export type ContentType = 'text' | 'image' | 'video' | 'link' | 'article';
export type SortKey = 'newest' | 'oldest' | 'relevance' | 'source';

export interface FilterSpec {
  query: string;
  include: string[];
  includeMode: 'any' | 'all';
  exclude: string[];
  sources: string[];
  excludeSources: string[];
  authors: string[];
  excludeAuthors: string[];
  platforms: Platform[];
  contentTypes: ContentType[];
  kinds: ItemKind[];
  langs: string[];
  topics: string[];
  dateFrom: string | null; // yyyy-mm-dd inclusive
  dateTo: string | null; // yyyy-mm-dd inclusive
  read: ReadFilter;
  saved: SavedFilter;
  archived: ArchivedFilter;
  collection: string | null;
  hideNoise: boolean;
  hideDuplicates: boolean;
  showDemo: boolean;
  /** Apply the plain-English AI rules (hide, only, tag). */
  aiRules: boolean;
  sort: SortKey;
}

export interface SavedView {
  id: string;
  name: string;
  spec: FilterSpec;
  createdAt: string;
}

export interface Library {
  items: Item[];
  sources: Source[];
  views: SavedView[];
  topics: Topic[];
  collections: string[];
  syncRuns: SyncRun[];
  connectors: ConnectorInfo[];
  pages?: Page[];
  aiRules?: AiRule[];
  /** ruleId -> itemId -> label, for plain-English rules the AI has classified. */
  labels?: Record<string, Record<string, { match: boolean; reason: string | null }>>;
  /** Classifier progress per rule id. */
  aiProgress?: Record<string, { done: number; total: number }>;
  /** User-defined profiles (Work, Gaming, Family...). The built-in "All" profile is implied. */
  profiles?: Profile[];
  /** The profile the server treats as active (agent tools, new objects). */
  activeProfile?: string;
  /** Profile id to friend fingerprint prefixes: circles mapped to a profile route their members' shares there. */
  friendRouting?: Record<string, string[]>;
  /** Only while the web app is still fetching older posts: how many the whole library holds. */
  itemsTotal?: number;
}

/**
 * A profile is a lens over the shared library plus its own settings. Items are never copied:
 * a profile lists the sources it includes and owns the views, pages and AI rules made in it.
 * Anything no profile owns belongs to the built-in "All" profile, so dropping profiles is safe.
 */
export interface Profile {
  id: string;
  name: string;
  /** An icon name from the app's icon set. */
  icon: string;
  /** Accent colour, #rrggbb. */
  color: string;
  /** Optional theme while this profile is active (same shape as the ui.look setting). */
  look?: { preset?: string; mode?: 'dark' | 'light'; tokens?: Record<string, string> } | null;
  /** Optional instructions for the AI while this profile is active. */
  instructions?: string;
  sourceIds: string[];
  own: { views: string[]; pages: string[]; aiRules: string[] };
  /** Also use the views, pages and AI rules of "All" in this profile. */
  inherit?: boolean;
  /** Write a morning edition for this profile too. */
  edition?: boolean;
  /**
   * Hours for this profile, in local time; days are the days a window starts on (0 is Sunday). With
   * `auto` the app switches to the profile when a window starts and back when it ends (a manual
   * switch always wins until the next boundary); without it the app only offers the switch.
   */
  schedule?: { days: number[]; from: string; to: string; auto?: boolean } | null;
  /** Optional soft daily reading limit in minutes (core/timeSpent.ts). Never blocks; it only says so. */
  dailyMinutes?: number | null;
  position: number;
  createdAt: string;
}

/** A page the user (or their AI) composed from blocks. The AI writes this JSON, never UI code. */
export interface Page {
  id: string;
  name: string;
  icon?: string | null;
  blocks: PageBlock[];
  createdAt: string;
  updatedAt: string;
}

export type PageBlock =
  | { type: 'hero'; title: string; subtitle?: string }
  | { type: 'feed'; title?: string; spec: Partial<FilterSpec>; layout?: 'timeline' | 'grid' | 'compact'; limit?: number }
  | { type: 'gallery'; title?: string; spec: Partial<FilterSpec>; limit?: number }
  | { type: 'people'; title?: string; spec: Partial<FilterSpec>; limit?: number }
  | { type: 'stats'; title?: string; spec: Partial<FilterSpec>; metric: 'per_day' | 'by_source' | 'by_platform' | 'by_topic' | 'by_author' }
  | { type: 'note'; title?: string; text: string }
  | { type: 'digest'; title?: string; text: string; generatedAt?: string; postIds?: string[] }
  | { type: 'widget'; title?: string; html: string; height?: number; spec?: Partial<FilterSpec> };

/** A rule written in plain English and applied by the AI, post by post. */
export interface AiRule {
  id: string;
  name: string;
  prompt: string;
  action: 'hide' | 'only' | 'tag';
  enabled: boolean;
  createdAt: string;
}

export interface AgentThread {
  id: string;
  kind: 'chat' | 'build' | 'repair' | 'task';
  title: string | null;
  status: 'idle' | 'running' | 'done' | 'error' | 'waiting';
  parentId: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentEvent {
  id: number;
  threadId: string;
  at: string;
  type: string;
  data: any;
}

/** Static description of a connector, exposed to the UI for honest setup screens. */
export interface ConnectorInfo {
  id: string;
  version: number;
  name: string;
  platform: Platform;
  kind: 'feed' | 'api' | 'import';
  available: boolean;
  /** Why it is unavailable, and what the user must do. */
  blockedReason?: string | null;
  needs?: string[];
  description: string;
}
