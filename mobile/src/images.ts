// Pictures through the computer's image proxy (/api/img), so the hosts serving them never learn
// when the phone looks at a post. Same rules as the desktop (web/src/imgProxy.ts): the proxy only
// serves images already in the library, every request carries the per-install proxy token, and
// on the phone also the device's Bearer token (the server refuses unpaired network requests).
// Videos are never proxied. When the proxy is turned off on the computer, images load directly.
import type { ImageSource } from 'expo-image';
import { call, connection } from './api';
import { getItem, setItem } from './secure';

let cfg: Cfg | null = null;
let loading: Promise<void> | null = null;
/** Until the computer has answered, no picture loads at all (not even directly). */
let settled = false;

type Cfg = { enabled: boolean; token: string };
/** The last proxy settings, kept in the keychain with the device token (and forgotten with it). */
export const IMG_KEY = 'aurora.imgProxy';
const valid = (c: Cfg | null | undefined): Cfg | null => (c && c.enabled && typeof c.token === 'string' ? c : null);

/**
 * Loads the proxy settings once per pairing. Never rejects; on failure images load directly.
 * The last answer is kept on the phone, so an offline start (or a slow network) goes on with the
 * proxy rules it had, and pictures already in expo-image's disk cache still show.
 */
export function imgProxyReady(): Promise<void> {
  loading ??= new Promise<void>((resolve) => {
    const settle = () => { settled = true; resolve(); };
    void (async () => {
      const saved = await getItem(IMG_KEY).then((s) => (s ? (JSON.parse(s) as Cfg) : null)).catch(() => null);
      if (saved) { cfg = valid(saved); settle(); }
      try {
        cfg = valid(await call<Cfg>('GET', '/api/img/config'));
        void setItem(IMG_KEY, JSON.stringify(cfg ?? { enabled: false, token: '' })).catch(() => {});
      } catch {
        if (!saved) cfg = null;
      }
      settle();
    })();
  });
  return loading;
}

/** Forget the settings, for example after pairing with another computer. */
export function resetImgProxy() {
  loading = null;
  cfg = null;
  settled = false;
}

export function proxyOn(): boolean {
  return !!cfg;
}

/**
 * An expo-image source for a remote picture: through the proxy with the Bearer header when the
 * proxy is on, otherwise the URL itself. Returns undefined for no URL, and before the proxy
 * settings have loaded (screens that fetch their own data await imgProxyReady first).
 */
export function imgSource(u: string | null | undefined): ImageSource | undefined {
  if (!u || !settled) return undefined;
  const c = connection();
  if (!cfg || !c || !/^https?:\/\//i.test(u)) return { uri: u };
  return {
    uri: `${c.url}/api/img?u=${encodeURIComponent(u)}&t=${encodeURIComponent(cfg.token)}`,
    headers: { Authorization: `Bearer ${c.token}` },
    cacheKey: u,
  };
}
