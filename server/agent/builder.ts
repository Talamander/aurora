// Tools for builder jobs: explore a site, write an actor, test it, install it as a source.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { z } from 'zod';
import { safeFetch } from '../safeFetch.ts';
import { libraryChanged } from '../events.ts';
import { chatTools, untrusted } from './tools.ts';
import { rawToDraft } from '../actors/map.ts';
import { toIso } from '../connectors/util.ts';
import { profileRoot } from '../actors/browser.ts';
import { profileSites } from '../login.ts';
import { NEEDS_SANDBOX } from '../actors/sandbox.ts';
import type { ToolDef, ToolOut } from './types.ts';

const KNOWLEDGE = fileURLToPath(new URL('./knowledge/', import.meta.url));

const ok = (text: string, ui?: Record<string, unknown>): ToolOut => ({ text, ui });
const fail = (text: string): ToolOut => ({ text, isError: true });

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}\n…[${s.length - n} more chars]` : s;
}

function compactJson(text: string, n: number): string {
  try {
    return clip(JSON.stringify(JSON.parse(text), null, 1), n);
  } catch {
    return clip(text, n);
  }
}

/** Last test outcome per actor, so install_source can insist the current version was tested. */
const lastTest = new Map<string, { version: number; ok: boolean; count: number }>();

/** One line the builder can check: does the output map cleanly and look like real posts? */
function qualityReport(items: any[], manifest: { id: string; version: number; platform: string }): string {
  if (!items.length) return 'Check: no items to inspect.';
  let mapFail = 0;
  let firstErr = '';
  let noDate = 0;
  let noAuthor = 0;
  let empty = 0;
  let withMedia = 0;
  let withAvatar = 0;
  let future = 0;
  let dupUrl = 0;
  const urls = new Set<string>();
  const now = Date.now();
  for (const raw of items) {
    let d;
    try {
      d = rawToDraft(raw, manifest);
    } catch (e) {
      mapFail++;
      firstErr ||= (e as Error).message;
      continue;
    }
    if (!toIso(raw.publishedAt)) noDate++;
    else if (Date.parse(d.publishedAt) > now + 36 * 3600e3) future++;
    if (!raw.author?.name && !raw.author?.handle) noAuthor++;
    if (!d.text && !d.title && !d.media.length) empty++;
    if (d.media.length) withMedia++;
    if (d.author.avatar) withAvatar++;
    if (urls.has(d.url)) dupUrl++;
    urls.add(d.url);
  }
  const n = items.length;
  const warn = [
    mapFail ? `${mapFail} rejected by the feed (${firstErr})` : '',
    noDate ? `${noDate} without a usable publishedAt (they would be dated "now")` : '',
    noAuthor ? `${noAuthor} without author name/handle` : '',
    empty ? `${empty} with no text, title or media` : '',
    dupUrl ? `${dupUrl} sharing a permalink with another item (ids or urls wrong?)` : '',
  ].filter(Boolean);
  const note = future ? ` Note: ${future} dated more than a day ahead (expected for events dated by start time; a bug for posts).` : '';
  return `Check of ${n} items: ${warn.length ? `PROBLEMS: ${warn.join('; ')}.` : 'all map cleanly with dates and authors.'} Media on ${withMedia}/${n}, avatar on ${withAvatar}/${n}.${note}`;
}

function runtime(ctx: { app: { actors: any } }) {
  if (!ctx.app.actors) throw new Error('The actor runtime is not available on this server.');
  return ctx.app.actors;
}

export const builderTools: ToolDef[] = [
  {
    name: 'read_knowledge',
    kind: 'read',
    description: 'Read the notes for one platform (file name from the knowledge index, e.g. "instagram" or "feeds-misc").',
    shape: { platform: z.string() },
    label: (a) => `Read notes on ${a.platform}`,
    run: (a) => {
      const files = readdirSync(KNOWLEDGE).filter((f) => f.endsWith('.md'));
      const want = String(a.platform).toLowerCase().replace(/\.md$/, '');
      const f = files.find((x) => x === `${want}.md`) ?? files.find((x) => x.includes(want));
      if (!f) return fail(`No notes for "${a.platform}". Available: ${files.join(', ')}`);
      return ok(readFileSync(KNOWLEDGE + f, 'utf8'));
    },
  },
  {
    name: 'http_get',
    kind: 'network',
    description: 'Fetch a public URL (GET, or POST with a body) from the server. Private addresses are refused. Returns status, final URL, headers and up to ~25 KB of body.',
    shape: { url: z.string(), headers: z.object({}).catchall(z.string()).optional(), method: z.enum(['GET', 'POST']).optional(), body: z.string().optional(), max_chars: z.number().int().min(1000).max(80000).optional() },
    label: (a) => `Fetched ${String(a.url).replace(/^https?:\/\//, '').slice(0, 70)}`,
    run: async (a) => {
      try {
        const r = await safeFetch(a.url, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36', 'accept-language': 'en-US,en;q=0.9', ...(a.headers ?? {}) }, method: a.method, body: a.body, maxBytes: 4e6, timeoutMs: 20000 });
        const ct = r.headers['content-type'] ?? '';
        const keep = ['content-type', 'location', 'set-cookie', 'x-ratelimit-remaining', 'retry-after', 'cache-control'];
        const hdrs = Object.entries(r.headers).filter(([k]) => keep.includes(k)).map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`).join('\n');
        const n = a.max_chars ?? 25000;
        const body = /json/.test(ct) ? compactJson(r.text, n) : clip(r.text, n);
        return ok(`HTTP ${r.status} ${r.url}\n${hdrs}\n${untrusted(r.url, body)}`);
      } catch (e) {
        return fail(`Fetch failed: ${(e as Error).message}`);
      }
    },
  },
  {
    name: 'browser_probe',
    kind: 'network',
    description: 'Load a page in a real headless Chromium (no login) and report the visible text excerpt and every JSON response the page fetched, with URLs and shapes. Use it to discover the data endpoints of JavaScript-heavy sites. hosts = every host the page may load (others are blocked).',
    shape: { url: z.string(), hosts: z.array(z.string()).min(1), scroll: z.number().int().min(0).max(8).optional(), wait_ms: z.number().int().min(0).max(15000).optional(), profile: z.string().optional().describe('Signed-in browser profile name, only if one exists') },
    label: (a) => `Opened ${String(a.url).replace(/^https?:\/\//, '').slice(0, 70)} in a browser`,
    run: async (a, ctx) => {
      try {
        const r = await runtime(ctx).browser.probe(a.url, { allowHosts: a.hosts, scroll: a.scroll, waitMs: a.wait_ms, profile: a.profile });
        return ok(untrusted(a.url, clip(typeof r === 'string' ? r : JSON.stringify(r, null, 1), 30000)));
      } catch (e) {
        return fail(`Browser failed: ${(e as Error).message}`);
      }
    },
  },
  {
    name: 'browser_profiles',
    kind: 'read',
    description: 'List the app-owned signed-in browser profiles (one per platform slug, e.g. "facebook", "x"). A session-tier actor whose manifest.platform equals a listed name runs sr.browser inside that login. An empty list means the user has not signed in anywhere yet.',
    shape: {},
    label: () => 'Checked which sites you are signed in to',
    run: (_a, ctx) => {
      const root = profileRoot(ctx.app.dataDir);
      const names = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name) : [];
      if (!names.length) return ok('No signed-in profiles yet.');
      // A profile exists as soon as its login window opened; the cookie names say whether the sign-in finished.
      const lines = names.map((n) => {
        const sites = profileSites(join(root, n));
        if (sites === null) return `${n}: open right now (a login window or a sync is using it), status unknown`;
        const yes = sites.filter((x) => x.signedIn === true).map((x) => x.site);
        const no = sites.filter((x) => x.signedIn === false).map((x) => x.site);
        return `${n}: ${yes.length ? `signed in to ${yes.join(', ')}` : 'not signed in to any known site'}${no.length ? `; NOT signed in to ${no.join(', ')}` : ''}`;
      });
      return ok(`Browser profiles:\n${lines.join('\n')}\nA session-tier source only works where the profile is signed in to that site. If it is not, call request_login and wait.`);
    },
  },
  {
    name: 'get_actor',
    kind: 'read',
    description: 'Manifest, code and version history of an actor.',
    shape: { id: z.string() },
    label: (a) => `Read actor ${a.id}`,
    run: (a, ctx) => {
      const rt = runtime(ctx);
      const got = rt.store.get(a.id);
      if (!got) return fail('No such actor');
      const versions = rt.store.versions?.(a.id) ?? [];
      const text = `${JSON.stringify(got.manifest, null, 1)}\n--- ${got.manifest.entry}\n${got.code}\n--- versions: ${JSON.stringify(versions).slice(0, 500)}`;
      // A connector imported from a friend or a bundle was written by someone else: its notes,
      // description and comments are data, not instructions.
      return ok(got.manifest.createdBy === 'import' ? untrusted(`imported connector ${got.manifest.id}`, text) : text);
    },
  },
  {
    name: 'write_actor',
    kind: 'write',
    description: 'Create an actor or save a new version of one. manifest follows the actor guide (id, name, runtime, entry, platform, description, tier, hosts, input, python.requires, notes). code is the whole entry file.',
    shape: { manifest: z.object({}).catchall(z.any()), code: z.string().min(20) },
    label: (a) => `Wrote actor ${a.manifest?.id ?? ''}`,
    run: (a, ctx) => {
      try {
        const m = runtime(ctx).store.write({ manifest: { createdBy: 'agent', ...a.manifest }, code: a.code });
        ctx.emit('actor', { id: m.id, version: m.version, platform: m.platform });
        return ok(`Saved ${m.id} v${m.version} (${m.runtime}, tier ${m.tier}, hosts ${m.hosts.join(', ')}${m.hostsFromInput?.length ? `, hosts from input ${m.hostsFromInput.join(', ')}` : ''}).`, { actorId: m.id, version: m.version });
      } catch (e) {
        return fail(`Not saved: ${(e as Error).message}`);
      }
    },
  },
  {
    name: 'edit_actor',
    kind: 'write',
    description: 'Save a new version of an existing actor by exact find/replace edits to its code (each find must occur exactly once), and optionally merge manifest fields (e.g. hosts, hostsFromInput, notes). Cheaper than rewriting the whole file with write_actor for small fixes.',
    shape: {
      id: z.string(),
      edits: z.array(z.object({ find: z.string().min(1), replace: z.string() })).max(20).optional(),
      manifest: z.object({}).catchall(z.any()).optional(),
    },
    label: (a) => `Edited actor ${a.id}${a.edits?.length ? ` (${a.edits.length} change${a.edits.length > 1 ? 's' : ''})` : ''}`,
    run: (a, ctx) => {
      const rt = runtime(ctx);
      const got = rt.store.get(a.id);
      if (!got) return fail('No such actor');
      let code: string = got.code;
      for (const [i, e] of (a.edits ?? []).entries()) {
        const n = code.split(e.find).length - 1;
        if (n !== 1) return fail(`Not saved: edit ${i + 1} matches ${n} times (it must match exactly once). Nothing was changed.`);
        code = code.replace(e.find, () => e.replace);
      }
      if (code === got.code && !a.manifest) return fail('Not saved: no change.');
      try {
        const m = rt.store.write({ manifest: { ...got.manifest, ...(a.manifest ?? {}), id: a.id }, code });
        ctx.emit('actor', { id: m.id, version: m.version, platform: m.platform });
        return ok(`Saved ${m.id} v${m.version} (${m.runtime}, tier ${m.tier}, hosts ${m.hosts.join(', ')}${m.hostsFromInput?.length ? `, hosts from input ${m.hostsFromInput.join(', ')}` : ''}).`, { actorId: m.id, version: m.version });
      } catch (e) {
        return fail(`Not saved: ${(e as Error).message}`);
      }
    },
  },
  {
    name: 'test_actor',
    kind: 'network',
    description: 'Run an actor once in the sandbox with the given input (no state) and report: item count, the first items exactly as the feed will store them, logs, network requests that were blocked, and errors.',
    shape: {
      id: z.string(),
      input: z.object({}).catchall(z.any()),
      max_items: z.number().int().min(1).max(100).optional(),
      check_state: z.boolean().optional().describe('Also run a second time with the state the first run saved, as the next scheduled sync would. Use on the final version.'),
    },
    label: (a) => `Tested ${a.id} with ${JSON.stringify(a.input).slice(0, 60)}${a.check_state ? ' (and a second run with saved state)' : ''}`,
    run: async (a, ctx) => {
      const rt = runtime(ctx);
      try {
        const got = rt.store.get(a.id);
        const r = await rt.run(a.id, a.input, null, { timeoutMs: 240000, maxItems: a.max_items ?? 40 });
        if (r.error === NEEDS_SANDBOX) return fail(`${NEEDS_SANDBOX}. This is not a bug in the connector: stop building and tell the user.`);
        const blocked = (r.requests ?? []).filter((q: any) => q.blocked).map((q: any) => `${q.host}${q.reason ? ` (${q.reason})` : ''}`);
        const hosts = [...new Set((r.requests ?? []).map((q: any) => q.host))];
        const sample = (r.items ?? []).slice(0, 3).map((it: any) => JSON.stringify(it).slice(0, 1500)).join('\n');
        const summary = [
          `${r.ok ? 'OK' : 'FAILED'} in ${Math.round((r.durationMs ?? 0) / 100) / 10}s, isolation ${r.isolation}. ${r.items?.length ?? 0} items.`,
          r.error ? `Error: ${r.error}` : '',
          blocked.length ? `Blocked hosts (add to manifest.hosts if legitimate): ${[...new Set(blocked)].join(', ')}` : '',
          `Hosts contacted: ${hosts.join(', ') || 'none'}`,
          `State saved: ${JSON.stringify(r.state ?? null).slice(0, 300)}`,
          got ? qualityReport(r.items ?? [], got.manifest) : '',
          `Logs (tail):\n${clip((r.logs ?? []).slice(-40).join('\n'), 6000)}`,
        ].filter(Boolean);
        let stateOk = true;
        if (a.check_state && r.ok) {
          const r2 = await rt.run(a.id, a.input, r.state ?? null, { timeoutMs: 240000, maxItems: a.max_items ?? 40 });
          stateOk = r2.ok;
          const again = (r2.items ?? []).filter((it: any) => (r.items ?? []).some((x: any) => x.id === it.id)).length;
          summary.push(
            `Second run with the saved state: ${r2.ok ? 'OK' : 'FAILED'}, ${r2.items?.length ?? 0} items (${again} repeated from the first run; the feed dedupes by id, so repeats are harmless but wasteful).${r2.error ? ` Error: ${r2.error}` : ''}`,
          );
        }
        if (got) lastTest.set(a.id, { version: got.manifest.version, ok: r.ok && stateOk, count: r.items?.length ?? 0 });
        ctx.emit('test', { actorId: a.id, ok: r.ok, count: r.items?.length ?? 0, sample: (r.items ?? []).slice(0, 3) });
        return ok(`${summary.join('\n')}\nFirst items:\n${untrusted('actor output', sample || '(none)')}`, { actorId: a.id, count: r.items?.length ?? 0 });
      } catch (e) {
        return fail(`Run failed: ${(e as Error).message}`);
      }
    },
  },
  {
    name: 'install_source',
    kind: 'network',
    description: 'Install a tested actor as a source in the feed (or update the existing source for the same actor and input), sync it once, and report the counts.',
    shape: {
      actor_id: z.string(),
      input: z.object({}).catchall(z.any()),
      label: z.string(),
      every_minutes: z.number().int().min(15).max(10080).optional(),
      coverage: z.string().max(240).optional().describe('One honest line on what this source does and does not get, e.g. "Logged out: newest 12 posts per check; no stories or comments".'),
    },
    label: (a) => `Installed “${a.label}”`,
    run: async (a, ctx) => {
      const rt = runtime(ctx);
      const got = rt.store.get(a.actor_id);
      if (!got) return fail('No such actor');
      const t = lastTest.get(a.actor_id);
      if (!t || t.version !== got.manifest.version) return fail(`Not installed: ${a.actor_id} v${got.manifest.version} has not been tested. Run test_actor on this version first.`);
      if (!t.ok) return fail(`Not installed: the last test of ${a.actor_id} v${got.manifest.version} failed. Fix it, or stop and explain what blocks it.`);
      const store = ctx.app.store;
      const key = JSON.stringify(a.input);
      const existing = store.listSources().find((s) => s.connector === 'actor' && s.config.actorId === a.actor_id && JSON.stringify(s.config.input) === key);
      let id: string;
      if (existing) {
        store.updateSource(existing.id, { label: String(a.label).slice(0, 120), enabled: true, config: { ...existing.config, everyMinutes: a.every_minutes ?? existing.config.everyMinutes ?? 60, ...(a.coverage ? { coverage: a.coverage } : {}) } });
        id = existing.id;
      } else {
        id = store.createSource({ connector: 'actor', label: String(a.label).slice(0, 120), platform: got.manifest.platform || 'web', config: { actorId: a.actor_id, input: a.input, everyMinutes: a.every_minutes ?? 60, ...(a.coverage ? { coverage: a.coverage } : {}) } }).id;
      }
      const r = await ctx.app.syncSource(id);
      const changeId = existing ? undefined : store.addChange({ threadId: ctx.threadId, label: `follow “${a.label}”`, undo: { op: 'deleteSource', id } });
      libraryChanged('install');
      ctx.emit('installed', { sourceId: id, label: a.label, added: r.added ?? 0, error: r.error ?? null, coverage: a.coverage ?? null, tier: got.manifest.tier });
      return ok(`Source ${existing ? 'updated' : 'installed'} (${id}). Sync: ${JSON.stringify(r)}`, { sourceId: id, changeId, label: `Following “${a.label}”` });
    },
  },
  {
    name: 'get_source',
    kind: 'read',
    description: 'A source with its config, status and recent sync runs (errors included).',
    shape: { id: z.string() },
    label: () => 'Read the source',
    run: (a, ctx) => {
      const s = ctx.app.store.getSource(a.id);
      if (!s) return fail('No such source');
      const runs = ctx.app.store.listRuns(200).filter((r) => r.sourceId === s.id).slice(0, 8);
      return ok(`${JSON.stringify({ ...s, cursor: s.cursor?.slice(0, 300) }, null, 1)}\nRecent runs:\n${runs.map((r) => `${r.startedAt} ok=${r.ok} +${r.added} errors=${JSON.stringify(r.errors).slice(0, 400)}`).join('\n')}`);
    },
  },
  ...chatTools.filter((t) => ['list_actors', 'run_source', 'library_overview', 'request_login'].includes(t.name)),
];
