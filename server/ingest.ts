// Ingest pipeline: connector drafts in, durable items out.

import { guessLang } from '../core/lang.ts';
import { dedupeKeyFor, safeHttpUrl } from '../core/normalize.ts';
import type { Item, Source } from '../core/types.ts';
import type { Store } from './db.ts';
import type { ItemDraft } from './connectors/types.ts';

export interface IngestResult {
  added: number;
  updated: number;
  skipped: number;
  errors: string[];
}

const MAX_TEXT = 40_000;

export function ingestDrafts(store: Store, source: Source, drafts: ItemDraft[]): IngestResult {
  const res: IngestResult = { added: 0, updated: 0, skipped: 0, errors: [] };
  const now = new Date().toISOString();
  store.tx(() => {
    for (const d of drafts) {
      try {
        const url = safeHttpUrl(d.url);
        if (!url || !d.externalId) {
          res.skipped++;
          if (res.errors.length < 50) res.errors.push(`Skipped an item without a usable link (${String(d.externalId || '?').slice(0, 40)})`);
          continue;
        }
        const published = Number.isFinite(Date.parse(d.publishedAt)) ? new Date(d.publishedAt).toISOString() : now;
        const text = String(d.text ?? '').slice(0, MAX_TEXT);
        const links = (d.links ?? []).map(safeHttpUrl).filter((x): x is string => !!x);
        const media = (d.media ?? []).filter((m) => safeHttpUrl(m.url)).map((m) => ({ ...m, thumb: m.thumb ? safeHttpUrl(m.thumb) ?? undefined : undefined }));
        const sourceLang = d.lang ? String(d.lang).slice(0, 12) : null;
        const guessed = sourceLang ? null : guessLang(`${d.title ?? ''} ${text.slice(0, 2000)}`);
        const item: Omit<Item, 'state'> = {
          ...d,
          lang: sourceLang ?? guessed,
          ...(guessed ? { langGuessed: true } : {}),
          url,
          text,
          links,
          media,
          author: { ...d.author, url: d.author.url ? safeHttpUrl(d.author.url) ?? undefined : undefined, avatar: d.author.avatar ? safeHttpUrl(d.author.avatar) ?? undefined : undefined },
          id: `${d.platform}:${d.externalId}`,
          sourceId: source.id,
          publishedAt: published,
          ingestedAt: now,
          dedupeKey: dedupeKeyFor({ url, text, links, kind: d.kind }),
          isDemo: source.isDemo,
        };
        // A thin copy (e.g. an archive bookmark with no text) must not overwrite a richer one.
        const existing = store.getItem(item.id);
        if (existing && existing.text.length > item.text.length && item.text.length === 0) {
          res.skipped++;
          continue;
        }
        const r = store.upsertItem(item);
        res[r]++;
      } catch (e) {
        res.skipped++;
        if (res.errors.length < 50) res.errors.push(`Item failed: ${(e as Error).message}`);
      }
    }
  });
  return res;
}
