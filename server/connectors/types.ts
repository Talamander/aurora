// Versioned connector interface. A connector turns an external source into
// ItemDrafts; the ingest pipeline (server/ingest.ts) assigns ids, dedupe keys
// and local state. Connectors never write to the source platform.

import type { ConnectorInfo, Item } from '../../core/types.ts';

export const CONNECTOR_API_VERSION = 1;

/** What a connector produces. Text must be plain text (use htmlToText for HTML). */
export type ItemDraft = Omit<Item, 'id' | 'sourceId' | 'state' | 'ingestedAt' | 'dedupeKey' | 'isDemo'>;

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
}

export interface SafeFetchResult {
  status: number;
  url: string; // final URL after redirects
  headers: Record<string, string>;
  text: string;
}

/** fetch() that refuses private/loopback addresses, non-http schemes, huge bodies and slow hosts. */
export type SafeFetch = (url: string, opts?: SafeFetchOptions) => Promise<SafeFetchResult>;

export interface SecretStore {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

export interface SyncContext {
  sourceId: string;
  config: Record<string, unknown>;
  fetch: SafeFetch;
  secrets: SecretStore;
  now: () => Date;
  /** Cursor persisted between syncs (e.g. newest id seen). */
  cursor: string | null;
}

export interface SyncOutput {
  items: ItemDraft[];
  errors: string[];
  cursor?: string | null;
  /** Set when the connector cannot run without the user (missing auth, revoked token). */
  blocked?: string | null;
}

export interface FeedConnector {
  info: ConnectorInfo;
  /** Validate and normalise user-entered config before a source is created. Throw Error with a user-facing message. */
  prepareConfig(input: Record<string, unknown>, fetch: SafeFetch): Promise<{ config: Record<string, unknown>; label: string }>;
  sync(ctx: SyncContext): Promise<SyncOutput>;
}

export interface ImportOutput {
  items: ItemDraft[];
  errors: string[];
  /** Human label for the created source, e.g. "X archive: likes". */
  label: string;
  platform: Item['platform'];
}

export interface ImportParser {
  info: ConnectorInfo;
  /** Cheap check on the file name and first few KB. */
  detect(fileName: string, head: string): boolean;
  parse(fileName: string, text: string): ImportOutput;
}
