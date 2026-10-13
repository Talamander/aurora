// Routes the library's pictures (image media, thumbnails, avatars) through the server's image
// proxy (/api/img), so the hosts serving them never see when you look at a post. Original URLs
// stay on the item where they are used as links; only what an <img> loads is rewritten. Videos
// are never proxied. Turned off in settings, everything loads directly again.

import type { Author, Item, Library } from '../../core/types.ts';

let cfg: { enabled: boolean; token: string } | null = null;
let loading: Promise<void> | null = null;

/** Loads the proxy settings once (call again after resetImgProxy). Never rejects. */
export function imgProxyReady(): Promise<void> {
  loading ??= fetch('/api/img/config')
    .then((r) => (r.ok ? r.json() : null))
    .then((c) => void (cfg = c && c.enabled && typeof c.token === 'string' ? c : null))
    .catch(() => void (cfg = null));
  return loading;
}

/** Forget the loaded settings, for example after the proxy was turned on or off. */
export function resetImgProxy() {
  loading = null;
}

export function proxied(u: string | undefined): string | undefined {
  if (!u || !cfg || !/^https?:\/\//i.test(u)) return u;
  return `/api/img?u=${encodeURIComponent(u)}&t=${encodeURIComponent(cfg.token)}`;
}

const author = (a: Author): Author => (a.avatar ? { ...a, avatar: proxied(a.avatar) } : a);

function proxyItem(it: Item): Item {
  return {
    ...it,
    author: author(it.author),
    quoted: it.quoted ? { ...it.quoted, author: author(it.quoted.author) } : it.quoted,
    // An image shows m.thumb ?? m.url; keep m.url as the original for links and opening.
    media: it.media.map((m) => (m.type === 'image' ? { ...m, thumb: proxied(m.thumb ?? m.url) } : m.thumb ? { ...m, thumb: proxied(m.thumb) } : m)),
  };
}

/** The same rewrite for a batch of items (one chunk of the library at a time). */
export function proxyItems(items: Item[]): Item[] {
  return cfg ? items.map(proxyItem) : items;
}

export function proxyLibrary(lib: Library): Library {
  return cfg ? { ...lib, items: lib.items.map(proxyItem) } : lib;
}
