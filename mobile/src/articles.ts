// Articles kept on the phone for offline reading: every article opened in the reader and the
// unread ones in Read later. Only articles the computer extracted (structured blocks, never HTML)
// are kept, and only the most recent few dozen.
import type { ArticleRecord } from '../../core/longform.ts';
import { listCache, readCache, removeCache, writeCache } from './cache';

type Rec = ArticleRecord & { canExtract?: boolean };

const KEEP = 60;

export function keepArticle(id: string, rec: Rec): void {
  if (rec.status !== 'ok') return;
  writeCache(`article/${id}`, rec);
  const names = listCache('article');
  for (const name of names.slice(0, Math.max(0, names.length - KEEP))) removeCache(`article/${name}`);
}

export function keptArticle(id: string): Promise<Rec | null> {
  return readCache<Rec>(`article/${id}`);
}
