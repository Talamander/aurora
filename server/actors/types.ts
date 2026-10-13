// Actor (AI-built connector) types. See PLAN.md "Actors" and server/actors/README.md.

export type ActorRuntime = 'python' | 'node';
export type ActorTier = 'api' | 'http' | 'browser' | 'session';

export interface ActorManifest {
  id: string;
  name: string;
  version: number;
  runtime: ActorRuntime;
  entry: 'main.py' | 'main.ts';
  /** Platform label for produced items (e.g. "instagram"). Any string. */
  platform: string;
  description?: string;
  tier: ActorTier;
  /** Hostnames the actor may reach. "*.example.com" matches subdomains (not example.com itself). */
  hosts: string[];
  /**
   * Input field names whose value names a site (URL, hostname or `@user@host`). Each run also
   * allows that host, its bare domain and their subdomains. For actors that serve any instance
   * or custom domain (Mastodon servers, Substack custom domains, a generic site reader).
   */
  hostsFromInput?: string[];
  /** JSON Schema for the input object. */
  input?: Record<string, unknown>;
  python?: { requires?: string[] };
  createdBy?: 'agent' | 'user' | string;
  createdAt: string;
  updatedAt: string;
  notes?: string;
}

/** What an actor emits; the host maps it to an ItemDraft (server/actors/map.ts). */
export interface RawPost {
  id: string;
  url: string;
  author?: { name?: string; handle?: string; url?: string; avatar?: string };
  text?: string;
  html?: string;
  title?: string;
  /** ISO string, or unix seconds / milliseconds. */
  publishedAt?: string | number;
  media?: { type: 'image' | 'video'; url: string; thumb?: string; alt?: string }[];
  links?: string[];
  kind?: 'post' | 'reply' | 'repost' | 'thread' | 'article' | 'video';
  quoted?: { author?: { name?: string; handle?: string; url?: string }; text?: string; url?: string } | null;
  metrics?: { likes?: number; reposts?: number; replies?: number; views?: number };
  lang?: string;
}

/** One request seen by the egress proxy. */
export interface ProxyLogEntry {
  t: string;
  method: string;
  host: string;
  port: number;
  path?: string;
  status?: number;
  bytesIn?: number;
  bytesOut?: number;
  ms?: number;
  blocked?: boolean;
  reason?: string;
}

export interface ActorRunResult {
  ok: boolean;
  items: RawPost[];
  state: unknown;
  logs: string[];
  error?: string;
  requests: ProxyLogEntry[];
  durationMs: number;
  isolation: 'bwrap' | 'seatbelt' | 'none';
  exitCode?: number | null;
  truncated?: boolean;
}

export interface ActorRunOptions {
  input?: Record<string, unknown>;
  state?: unknown;
  /** Default 120000, max 600000. */
  timeoutMs?: number;
  /** Default 300. */
  maxItems?: number;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
}
