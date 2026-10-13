// X (Twitter) OAuth 2.0 Authorization Code + PKCE, read-only scopes.
// Runs only when the user supplies their own X developer app via X_CLIENT_ID.
// Tokens are stored in the local SQLite secrets table and never logged.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './db.ts';
import { buildAuthUrl, clearTokens, completeAuthorization, makePkce, makeState } from './connectors/xApi.ts';

const PENDING_TTL_MS = 10 * 60_000;

export function registerXAuthRoutes(deps: {
  route: (m: string, p: string, h: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, body: any, url: URL) => unknown) => void;
  store: Store;
  port: number;
  HttpError: new (status: number, message: string) => Error;
  syncSource: (id: string) => Promise<unknown>;
}) {
  const { route, store, port, HttpError, syncSource } = deps;
  const redirectUri = process.env.X_REDIRECT_URI ?? `http://127.0.0.1:${port}/api/x/auth/callback`;
  const pending = new Map<string, { verifier: string; at: number }>();
  const secrets = { get: (k: string) => store.getSecret(k), set: (k: string, v: string | null) => store.setSecret(k, v) };

  const redirect = (res: ServerResponse, to: string) => {
    res.writeHead(302, { location: to, 'cache-control': 'no-store' });
    res.end();
  };

  route('GET', '/api/x/status', () => ({
    configured: Boolean(process.env.X_CLIENT_ID),
    connected: Boolean(store.getSecret('x.access_token')),
    redirectUri,
  }));

  route('GET', '/api/x/auth/start', (_req, res) => {
    const clientId = process.env.X_CLIENT_ID;
    if (!clientId) throw new HttpError(409, 'Set X_CLIENT_ID (your own X developer app) and restart Aurora first.');
    const now = Date.now();
    for (const [k, v] of pending) if (now - v.at > PENDING_TTL_MS) pending.delete(k);
    const { verifier, challenge } = makePkce();
    const state = makeState();
    pending.set(state, { verifier, at: now });
    redirect(res, buildAuthUrl({ clientId, redirectUri, state, codeChallenge: challenge }));
  });

  route('GET', '/api/x/auth/callback', async (_req, res, _p, _b, url) => {
    const state = url.searchParams.get('state') ?? '';
    const entry = pending.get(state);
    pending.delete(state);
    const err = url.searchParams.get('error');
    if (err) return redirect(res, `/?x=${encodeURIComponent('denied')}`);
    if (!entry || Date.now() - entry.at > PENDING_TTL_MS) return redirect(res, '/?x=expired');
    const code = url.searchParams.get('code');
    if (!code) return redirect(res, '/?x=missing-code');
    try {
      const me = await completeAuthorization({ code, codeVerifier: entry.verifier, redirectUri, secrets });
      let source = store.listSources().find((s) => s.connector === 'x-bookmarks');
      if (!source) source = store.createSource({ connector: 'x-bookmarks', label: `X bookmarks${me?.username ? ` (@${me.username})` : ''}`, platform: 'x', config: {} });
      else store.updateSource(source.id, { status: 'never', statusDetail: null });
      void syncSource(source.id);
      return redirect(res, '/?x=connected');
    } catch (e) {
      console.error('[x-auth] authorization failed:', (e as Error).message);
      return redirect(res, '/?x=failed');
    }
  });

  route('POST', '/api/x/disconnect', () => {
    clearTokens(secrets);
    for (const s of store.listSources()) if (s.connector === 'x-bookmarks') store.updateSource(s.id, { status: 'blocked', statusDetail: 'Disconnected. Approve read access again to resume.' });
    return { ok: true };
  });
}
