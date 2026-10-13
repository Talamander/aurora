// X API v2 bookmarks (read-only) via OAuth 2.0 Authorization Code + PKCE.
//
// Only these endpoints are ever called:
//   POST https://api.x.com/2/oauth2/token   (code exchange / refresh)
//   GET  https://api.x.com/2/users/me
//   GET  https://api.x.com/2/users/:id/bookmarks
// No write endpoint is used. Tokens are kept in the SecretStore and never logged.
// These are fixed official hosts, so plain global fetch is used (not safeFetch).

import crypto from 'node:crypto';
import type { Author, ConnectorInfo, ItemKind, Media } from '../../core/types.ts';
import { decodeEntities, safeHttpUrl } from '../../core/normalize.ts';
import type { FeedConnector, ItemDraft, SecretStore } from './types.ts';
import { asArray, isObj, num, pushMedia, str, toIso, truncateText, uniq } from './util.ts';

export const X_CONNECTOR_ID = 'x-bookmarks';
export const X_CONNECTOR_VERSION = 1;
export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
export const X_API = 'https://api.x.com/2';
export const X_SCOPES = ['tweet.read', 'users.read', 'bookmark.read', 'offline.access'];
const MAX_PAGES = 8;
const REQUEST_TIMEOUT_MS = 20_000;

export const X_SECRET_KEYS = {
  accessToken: 'x.access_token',
  refreshToken: 'x.refresh_token',
  expiresAt: 'x.expires_at',
  userId: 'x.user_id',
} as const;

type Obj = Record<string, unknown>;

export function xInfo(): ConnectorInfo {
  const hasClient = !!process.env.X_CLIENT_ID;
  return {
    id: X_CONNECTOR_ID,
    version: X_CONNECTOR_VERSION,
    name: 'X bookmarks (official API)',
    platform: 'x',
    kind: 'api',
    available: hasClient,
    blockedReason: hasClient
      ? null
      : 'Needs your own X developer app. Create one at developer.x.com (OAuth 2.0, type Native App, callback http://127.0.0.1:<port>/api/x/auth/callback), then start the server with X_CLIENT_ID set (and X_CLIENT_SECRET for a confidential Web App). Bookmark reads are billed by X under pay-per-use (about $0.001 per bookmark returned as of Oct 2026).',
    needs: ['X_CLIENT_ID environment variable', 'Sign in with X (read-only scopes: tweet.read users.read bookmark.read offline.access)'],
    description: 'Reads your X bookmarks through the official API. Read-only: never likes, posts, or removes bookmarks.',
  };
}

// ---------- OAuth helpers ----------

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE verifier (43 chars of base64url from 32 random bytes) and its S256 challenge. */
export function makePkce(): { verifier: string; challenge: string; method: 'S256' } {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

/** Random opaque state value for CSRF protection. */
export function makeState(): string {
  return b64url(crypto.randomBytes(24));
}

export function buildAuthUrl(p: { clientId: string; redirectUri: string; state: string; codeChallenge: string; scopes?: string[] }): string {
  const u = new URL(X_AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('scope', (p.scopes ?? X_SCOPES).join(' '));
  u.searchParams.set('state', p.state);
  u.searchParams.set('code_challenge', p.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export interface XTokens {
  accessToken: string;
  refreshToken: string | null;
  /** ISO time the access token expires. */
  expiresAt: string;
  scope: string;
}

async function tokenRequest(form: Record<string, string>, clientId: string, clientSecret?: string): Promise<XTokens> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  const body = new URLSearchParams(form);
  if (clientSecret) {
    headers.authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64');
  } else {
    body.set('client_id', clientId);
  }
  const res = await fetch(X_TOKEN_URL, { method: 'POST', headers, body: body.toString(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error' });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // ignore
  }
  if (!res.ok || !isObj(json) || typeof json.access_token !== 'string') {
    // Only surface the error code/description, never request or response tokens.
    const code = isObj(json) ? str(json.error) ?? '' : '';
    const desc = isObj(json) ? str(json.error_description) ?? '' : '';
    throw new Error(`X token request failed (HTTP ${res.status}${code ? `, ${code}` : ''}${desc ? `: ${desc.slice(0, 200)}` : ''})`);
  }
  const expiresIn = num(json.expires_in) ?? 7200;
  return {
    accessToken: json.access_token,
    refreshToken: str(json.refresh_token) ?? null,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    scope: str(json.scope) ?? '',
  };
}

export function exchangeCode(p: { code: string; codeVerifier: string; redirectUri: string; clientId: string; clientSecret?: string }): Promise<XTokens> {
  return tokenRequest(
    { grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, code_verifier: p.codeVerifier },
    p.clientId,
    p.clientSecret,
  );
}

export function refreshToken(p: { refreshToken: string; clientId: string; clientSecret?: string }): Promise<XTokens> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: p.refreshToken }, p.clientId, p.clientSecret);
}

async function apiGet(path: string, accessToken: string): Promise<{ status: number; json: unknown; headers: Headers }> {
  const res = await fetch(`${X_API}${path}`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: 'error',
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // ignore
  }
  return { status: res.status, json, headers: res.headers };
}

/** GET /2/users/me. Returns the authenticated user's id and username. */
export async function fetchMe(accessToken: string): Promise<{ id: string; username: string; name: string }> {
  const r = await apiGet('/users/me', accessToken);
  const data = isObj(r.json) && isObj(r.json.data) ? r.json.data : null;
  if (r.status !== 200 || !data || !str(data.id)) throw new Error(`Could not read X account (HTTP ${r.status})`);
  return { id: str(data.id)!, username: str(data.username) ?? '', name: str(data.name) ?? '' };
}

export function storeTokens(secrets: SecretStore, t: XTokens, userId?: string): void {
  secrets.set(X_SECRET_KEYS.accessToken, t.accessToken);
  if (t.refreshToken) secrets.set(X_SECRET_KEYS.refreshToken, t.refreshToken);
  secrets.set(X_SECRET_KEYS.expiresAt, t.expiresAt);
  if (userId) secrets.set(X_SECRET_KEYS.userId, userId);
}

export function clearTokens(secrets: SecretStore): void {
  for (const k of Object.values(X_SECRET_KEYS)) secrets.set(k, null);
}

/**
 * Callback-route helper: exchanges the code, looks up the user and stores
 * everything in the SecretStore. Returns non-secret account info for the label.
 */
export async function completeAuthorization(p: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  secrets: SecretStore;
  clientId?: string;
  clientSecret?: string;
}): Promise<{ userId: string; username: string; name: string }> {
  const clientId = p.clientId ?? process.env.X_CLIENT_ID;
  if (!clientId) throw new Error('X_CLIENT_ID is not set');
  const tokens = await exchangeCode({
    code: p.code,
    codeVerifier: p.codeVerifier,
    redirectUri: p.redirectUri,
    clientId,
    clientSecret: p.clientSecret ?? (process.env.X_CLIENT_SECRET || undefined),
  });
  const me = await fetchMe(tokens.accessToken);
  storeTokens(p.secrets, tokens, me.id);
  return { userId: me.id, username: me.username, name: me.name };
}

function expiryMs(v: string | null): number {
  if (!v) return 0;
  if (/^\d+$/.test(v)) return Number(v) < 1e11 ? Number(v) * 1000 : Number(v);
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

// ---------- Mapping ----------

interface XUrlEntity {
  url?: string;
  expanded_url?: string;
  unwound_url?: string;
  media_key?: string;
  start?: number;
}

function expandText(text: string, urls: XUrlEntity[], mediaUrls: Set<string>, selfId: string): { text: string; links: string[] } {
  const links: string[] = [];
  let out = text;
  for (const u of urls) {
    if (!u.url) continue;
    const expanded = safeHttpUrl(u.unwound_url) ?? safeHttpUrl(u.expanded_url);
    const isMedia = !!u.media_key || mediaUrls.has(u.url) || (expanded ? new RegExp(`/status/${selfId}/(photo|video)/`).test(expanded) : false);
    if (isMedia) {
      out = out.split(u.url).join('');
      continue;
    }
    if (expanded) {
      out = out.split(u.url).join(expanded);
      if (!links.includes(expanded)) links.push(expanded);
    }
  }
  return { text: decodeEntities(out).trim(), links };
}

function mapUser(u: Obj | undefined, fallbackId?: string): Author {
  if (!u) return { name: fallbackId ? `X user ${fallbackId}` : 'Unknown author' };
  const username = str(u.username);
  const author: Author = { name: (str(u.name) || username || 'Unknown author').slice(0, 200) };
  if (username) {
    author.handle = username;
    author.url = `https://x.com/${encodeURIComponent(username)}`;
  }
  const avatar = safeHttpUrl(u.profile_image_url);
  if (avatar) author.avatar = avatar;
  return author;
}

function tweetText(t: Obj): { raw: string; urls: XUrlEntity[] } {
  const note = isObj(t.note_tweet) ? t.note_tweet : null;
  if (note && str(note.text)) {
    const ents = isObj(note.entities) ? note.entities : {};
    return { raw: str(note.text)!, urls: asArray<XUrlEntity>(ents.urls).filter(isObj) };
  }
  const ents = isObj(t.entities) ? t.entities : {};
  return { raw: str(t.text) ?? '', urls: asArray<XUrlEntity>(ents.urls).filter(isObj) };
}

/** Pure mapper for a GET /2/users/:id/bookmarks response page. */
export function mapBookmarksResponse(json: unknown): { items: ItemDraft[]; errors: string[]; nextToken: string | null } {
  const root = isObj(json) ? json : {};
  const includes = isObj(root.includes) ? root.includes : {};
  const users = new Map<string, Obj>();
  for (const u of asArray<Obj>(includes.users)) if (isObj(u) && str(u.id)) users.set(str(u.id)!, u);
  const mediaByKey = new Map<string, Obj>();
  for (const m of asArray<Obj>(includes.media)) if (isObj(m) && str(m.media_key)) mediaByKey.set(str(m.media_key)!, m);
  const tweets = new Map<string, Obj>();
  for (const t of asArray<Obj>(includes.tweets)) if (isObj(t) && str(t.id)) tweets.set(str(t.id)!, t);

  const errors: string[] = [];
  for (const e of asArray<Obj>(root.errors)) {
    if (!isObj(e) || errors.length >= 20) continue;
    const detail = str(e.detail) ?? str(e.title) ?? 'unknown error';
    errors.push(`X API: ${detail.slice(0, 200)}`);
  }

  const items: ItemDraft[] = [];
  for (const t of asArray<Obj>(root.data)) {
    if (!isObj(t)) continue;
    const id = str(t.id);
    if (!id || !/^\d+$/.test(id)) continue;
    const refs = asArray<Obj>(t.referenced_tweets).filter(isObj);
    let kind: ItemKind = 'post';
    if (refs.some((r) => r.type === 'retweeted')) kind = 'repost';
    else if (refs.some((r) => r.type === 'replied_to')) kind = 'reply';
    const parent = kind === 'reply' ? str(refs.find((r) => r.type === 'replied_to')?.id) : undefined;

    const media: Media[] = [];
    const mediaUrls = new Set<string>();
    const attachments = isObj(t.attachments) ? t.attachments : {};
    for (const key of asArray<string>(attachments.media_keys)) {
      const m = typeof key === 'string' ? mediaByKey.get(key) : undefined;
      if (!m) continue;
      const type = str(m.type);
      const alt = str(m.alt_text)?.trim() || undefined;
      if (type === 'photo') pushMedia(media, { type: 'image', url: str(m.url) ?? '', alt });
      else if (type === 'video' || type === 'animated_gif') {
        const preview = str(m.preview_image_url);
        pushMedia(media, { type: 'video', url: str(m.url) ?? `https://x.com/i/web/status/${id}`, thumb: preview, alt });
      }
    }

    const { raw, urls } = tweetText(t);
    const expanded = expandText(raw, urls, mediaUrls, id);

    let quoted: ItemDraft['quoted'] = null;
    const qref = refs.find((r) => r.type === 'quoted');
    if (qref && str(qref.id)) {
      const qt = tweets.get(str(qref.id)!);
      const qid = str(qref.id)!;
      if (qt) {
        const q = tweetText(qt);
        quoted = {
          author: mapUser(users.get(str(qt.author_id) ?? ''), str(qt.author_id)),
          text: truncateText(expandText(q.raw, q.urls, new Set(), qid).text, 5000),
          url: `https://x.com/i/web/status/${qid}`,
        };
      } else {
        quoted = { author: { name: 'Unavailable post' }, text: '(quoted post not included)', url: `https://x.com/i/web/status/${qid}` };
      }
    }
    const links = uniq(expanded.links.filter((l) => !/^https:\/\/(x|twitter)\.com\/[^/]+\/status\/\d+\/(photo|video)\//.test(l)));
    const pm = isObj(t.public_metrics) ? t.public_metrics : {};
    const author = mapUser(users.get(str(t.author_id) ?? ''), str(t.author_id));
    const url = author.handle ? `https://x.com/${encodeURIComponent(author.handle)}/status/${id}` : `https://x.com/i/web/status/${id}`;
    items.push({
      platform: 'x',
      externalId: id,
      url,
      author,
      text: truncateText(expanded.text),
      links,
      media,
      quoted,
      lang: str(t.lang) && t.lang !== 'und' && t.lang !== 'zxx' ? str(t.lang)! : null,
      kind,
      replyTo: parent && /^\d+$/.test(parent) ? parent : null,
      publishedAt: toIso(str(t.created_at)) ?? new Date().toISOString(),
      provenance: { connector: X_CONNECTOR_ID, connectorVersion: X_CONNECTOR_VERSION, via: 'api' },
      metrics: { likes: num(pm.like_count), reposts: num(pm.retweet_count), replies: num(pm.reply_count) },
    });
  }
  const meta = isObj(root.meta) ? root.meta : {};
  return { items, errors, nextToken: str(meta.next_token) ?? null };
}

const BOOKMARK_PARAMS = new URLSearchParams({
  max_results: '100',
  'tweet.fields': 'created_at,lang,entities,attachments,public_metrics,referenced_tweets,note_tweet,author_id',
  expansions: 'author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id',
  'user.fields': 'name,username,profile_image_url',
  'media.fields': 'url,preview_image_url,type,alt_text',
});

export const xBookmarksConnector: FeedConnector = {
  get info() {
    return xInfo();
  },
  async prepareConfig(_input, _fetch) {
    if (!process.env.X_CLIENT_ID) throw new Error(xInfo().blockedReason ?? 'X connector unavailable');
    // Authorization happens through the OAuth routes; the source only records that it exists.
    return { config: {}, label: 'X bookmarks' };
  },
  async sync(ctx) {
    const clientId = process.env.X_CLIENT_ID;
    if (!clientId) return { items: [], errors: [], blocked: xInfo().blockedReason };
    const s = ctx.secrets;
    let access = s.get(X_SECRET_KEYS.accessToken);
    const refresh = s.get(X_SECRET_KEYS.refreshToken);
    let userId = s.get(X_SECRET_KEYS.userId);
    if (!access && !refresh) return { items: [], errors: [], blocked: 'Not connected to X. Use "Connect X account" to sign in (read-only).' };

    const clientSecret = process.env.X_CLIENT_SECRET || undefined;
    const doRefresh = async (): Promise<boolean> => {
      const rt = s.get(X_SECRET_KEYS.refreshToken);
      if (!rt) return false;
      const t = await refreshToken({ refreshToken: rt, clientId, clientSecret });
      storeTokens(s, t);
      access = t.accessToken;
      return true;
    };

    try {
      if (!access || expiryMs(s.get(X_SECRET_KEYS.expiresAt)) < ctx.now().getTime() + 60_000) {
        if (!(await doRefresh())) return { items: [], errors: [], blocked: 'X session expired. Reconnect your X account.' };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Only a rejected refresh token needs the user; network blips and 5xx retry next sync.
      if (/HTTP 40[01]|invalid_grant/i.test(msg)) return { items: [], errors: [], blocked: `X session could not be refreshed; reconnect your X account. (${msg})` };
      return { items: [], errors: [`Could not refresh the X session; will retry. (${msg})`] };
    }

    if (!userId) {
      try {
        const me = await fetchMe(access!);
        userId = me.id;
        s.set(X_SECRET_KEYS.userId, userId);
      } catch (e) {
        return { items: [], errors: [e instanceof Error ? e.message : String(e)] };
      }
    }

    // Bookmark reads are billed per post, so stop at the first page that reaches posts seen last time.
    const known = new Set((ctx.cursor ?? '').split(',').filter(Boolean));
    const items: ItemDraft[] = [];
    const errors: string[] = [];
    let token: string | null = null;
    let refreshed = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams(BOOKMARK_PARAMS);
      if (token) params.set('pagination_token', token);
      const r = await apiGet(`/users/${encodeURIComponent(userId)}/bookmarks?${params}`, access!);
      if (r.status === 401 && !refreshed) {
        refreshed = true;
        try {
          if (await doRefresh()) {
            page--;
            continue;
          }
        } catch {
          // fall through to blocked
        }
        return { items, errors, blocked: 'X rejected the saved token. Reconnect your X account.' };
      }
      if (r.status === 401) return { items, errors, blocked: 'X rejected the saved token. Reconnect your X account.' };
      if (r.status === 403) {
        const detail = isObj(r.json) ? str(r.json.detail) ?? str(r.json.title) ?? '' : '';
        return { items, errors, blocked: `X refused access (HTTP 403${detail ? `: ${detail.slice(0, 200)}` : ''}). Check your app's access level and credits.` };
      }
      if (r.status === 402) return { items, errors, blocked: 'X API credits exhausted (HTTP 402). Add credits in the X Developer Console.' };
      if (r.status === 429) {
        const reset = Number(r.headers.get('x-rate-limit-reset'));
        const when = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString()}` : '';
        errors.push(`X rate limit reached${when}; fetched ${items.length} bookmarks so far.`);
        break;
      }
      if (r.status !== 200) {
        errors.push(`X bookmarks request failed (HTTP ${r.status})`);
        break;
      }
      const mapped = mapBookmarksResponse(r.json);
      items.push(...mapped.items);
      errors.push(...mapped.errors);
      token = mapped.nextToken;
      if (!token || mapped.items.some((i) => known.has(i.externalId))) break;
    }
    const cursor = items.length ? items.slice(0, 100).map((i) => i.externalId).join(',') : (ctx.cursor ?? null);
    return { items, errors: errors.slice(0, 50), cursor };
  },
};
