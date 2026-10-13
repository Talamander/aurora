// The "actor" connector: a source backed by an AI-built actor. Runs it in the sandbox,
// maps raw posts to drafts and keeps the actor's state as the source cursor.

import type { Source } from '../core/types.ts';
import type { SyncContext, SyncOutput } from './connectors/types.ts';
import { rawToDraft } from './actors/map.ts';

export async function syncActorSource(actors: any, source: Source, ctx: SyncContext): Promise<SyncOutput> {
  const actorId = String(source.config.actorId ?? '');
  const actor = actors.store.get(actorId);
  if (!actor) return { items: [], errors: [`The actor “${actorId}” no longer exists.`] };
  let state: unknown = null;
  try {
    state = ctx.cursor ? JSON.parse(ctx.cursor) : null;
  } catch {
    state = null;
  }
  const r = await actors.run(actorId, (source.config.input as Record<string, unknown>) ?? {}, state, { timeoutMs: 240_000, maxItems: 200 });
  const items = [];
  const errors: string[] = [];
  for (const raw of r.items ?? []) {
    try {
      items.push(rawToDraft(raw, actor.manifest));
    } catch (e) {
      if (errors.length < 5) errors.push(`Skipped a post: ${(e as Error).message}`);
    }
  }
  if (!r.ok) errors.unshift(r.error || 'The actor failed.');
  const blocked = (r.requests ?? []).filter((q: any) => q.blocked).map((q: any) => q.host);
  if (blocked.length) errors.push(`Blocked hosts: ${[...new Set(blocked)].slice(0, 6).join(', ')}`);
  // A failed run keeps the previous state: the actor may have marked posts as seen before it
  // crashed. Re-emitting them next time is harmless (the feed dedupes by id); losing them is not.
  return { items, errors, cursor: !r.ok || r.state == null ? ctx.cursor : JSON.stringify(r.state).slice(0, 200_000) };
}
