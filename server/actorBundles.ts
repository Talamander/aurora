// Actor bundles: share a connector as one JSON file, with no cloud in between. Export gives the
// manifest and code; import validates the manifest through the actor store (hosts, tier, id)
// and saves it as a new, untested actor. It never installs a source by itself: the builder's
// install_source still insists on a passing test, and every run stays in the sandbox.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ActorManifest } from './actors/types.ts';
import type { ActorStore } from './actors/store.ts';
import { ACTOR_ID_RE, ActorValidationError } from './actors/store.ts';

type RouteFn = (
  method: string,
  path: string,
  handler: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, body: any, url: URL) => unknown,
) => void;

export const BUNDLE_FORMAT = 'social-reader-actor';
const MAX_CODE = 400_000;

export interface ActorBundle {
  format: typeof BUNDLE_FORMAT;
  formatVersion: 1;
  exportedAt: string;
  manifest: ActorManifest;
  code: string;
}

export function registerActorBundleRoutes(
  route: RouteFn,
  deps: { actorStore: () => ActorStore | null; HttpError: new (status: number, message: string) => Error },
) {
  const need = () => {
    const s = deps.actorStore();
    if (!s) throw new deps.HttpError(404, 'The actor runtime is not available');
    return s;
  };

  route('GET', '/api/actors/:id/bundle', (_q, _s, p) => {
    const got = need().get(p.id);
    if (!got) throw new deps.HttpError(404, 'No such actor');
    const bundle: ActorBundle = { format: BUNDLE_FORMAT, formatVersion: 1, exportedAt: new Date().toISOString(), manifest: got.manifest, code: got.code };
    return bundle;
  });

  route('POST', '/api/actors/import', (_q, _s, _p, body) => importBundle(need(), body?.bundle, { HttpError: deps.HttpError }));
}

/**
 * Saves a bundle as a new, untested actor. Used by file import and by a connector a friend
 * suggested. It validates the manifest through the store (hosts, tier, id), never overwrites an
 * actor you already have, and never installs a source: that still needs a passing test run.
 */
export function importBundle(
  store: ActorStore,
  raw: unknown,
  opts: { HttpError: new (status: number, message: string) => Error; note?: string; maxCode?: number },
): { manifest: ActorManifest; renamed: boolean } {
  const { HttpError } = opts;
  const b = raw as Partial<ActorBundle> | undefined;
  if (!b || b.format !== BUNDLE_FORMAT || b.formatVersion !== 1) throw new HttpError(400, 'Not an Aurora connector file');
  const m = b.manifest as Partial<ActorManifest> | undefined;
  if (!m || typeof m.id !== 'string' || !ACTOR_ID_RE.test(m.id)) throw new HttpError(400, 'The connector file has no valid id');
  if (typeof b.code !== 'string' || !b.code.trim() || b.code.length > (opts.maxCode ?? MAX_CODE)) throw new HttpError(400, 'The connector file has no usable code');
  // Never overwrite a connector you already have: an import with the same id gets a new one.
  const taken = new Set(store.list().map((a) => a.id));
  let id = m.id;
  for (let n = 2; taken.has(id); n++) id = `${m.id.slice(0, 56)}-${n}`;
  const { version: _v, createdAt: _c, updatedAt: _u, ...rest } = m;
  const note = opts.note ?? `Imported from a file on ${new Date().toISOString().slice(0, 10)}. Not tested here yet.`;
  let manifest: ActorManifest;
  try {
    manifest = store.write({
      manifest: { ...rest, id, createdBy: 'import', notes: [typeof m.notes === 'string' ? m.notes : '', note].filter(Boolean).join('\n\n') } as ActorManifest,
      code: b.code,
    });
  } catch (e) {
    if (e instanceof ActorValidationError) throw new HttpError(400, `The connector file was refused: ${e.message}`);
    throw e;
  }
  return { manifest, renamed: id !== m.id };
}
