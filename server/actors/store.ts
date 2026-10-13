// Actor storage: <dataDir>/actors/<id>/{actor.json, main.py|main.ts, versions/<n>/}.
// Removed actors move to <dataDir>/actors/.trash/ instead of being deleted.

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import type { ActorManifest } from './types.ts';

export const ACTOR_ID_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;
const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const TIERS = new Set(['api', 'http', 'browser', 'session']);

export interface ActorVersionInfo {
  version: number;
  updatedAt: string;
  current: boolean;
}

export interface ActorStore {
  list(): ActorManifest[];
  get(id: string): { manifest: ActorManifest; code: string } | null;
  write(input: { manifest: Partial<ActorManifest> & { id: string }; code: string }): ActorManifest;
  versions(id: string): ActorVersionInfo[];
  rollback(id: string, version: number): ActorManifest;
  remove(id: string): void;
  dir(id: string): string;
}

export class ActorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActorValidationError';
  }
}

/** Normalise and validate a host pattern. Throws on IPs, localhost and malformed names. */
export function normalizeHostPattern(raw: unknown): string {
  if (typeof raw !== 'string') throw new ActorValidationError('Host must be a string');
  const h = raw.trim().toLowerCase().replace(/\.$/, '');
  const bare = h.replace(/^\*\./, '');
  if (net.isIP(bare.replace(/^\[|\]$/g, ''))) throw new ActorValidationError(`IP addresses are not allowed as hosts: ${raw}`);
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local') || bare.endsWith('.internal')) {
    throw new ActorValidationError(`Local hosts are not allowed: ${raw}`);
  }
  if (!HOST_RE.test(h)) throw new ActorValidationError(`Invalid host: ${raw}`);
  return h;
}

/**
 * Hosts a run may reach because the input names that site (manifest.hostsFromInput): a URL,
 * a bare hostname or a fediverse handle `@user@host`. Gives the host, its bare domain (without
 * www.) and subdomains of that domain. Values that are not public hostnames are ignored.
 */
export function inputHosts(manifest: Pick<ActorManifest, 'hostsFromInput'>, input: Record<string, unknown> | undefined): string[] {
  const out = new Set<string>();
  for (const field of manifest.hostsFromInput ?? []) {
    const v = input?.[field];
    if (typeof v !== 'string' || !v.trim()) continue;
    let host = '';
    const s = v.trim();
    try {
      if (/^https?:\/\//i.test(s)) host = new URL(s).hostname;
      else if (/^@?[^@\s/]+@[^@\s/]+$/.test(s)) host = s.split('@').pop()!;
      else if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(s)) host = s.split('/')[0];
    } catch {}
    host = host.toLowerCase().replace(/\.$/, '');
    if (!host || !host.includes('.')) continue;
    const base = host.replace(/^www\./, '');
    for (const h of [host, base, `*.${base}`]) {
      try {
        out.add(normalizeHostPattern(h));
      } catch {}
    }
  }
  return [...out];
}

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function validate(m: Partial<ActorManifest> & { id: string }, prev: ActorManifest | null, now: string): ActorManifest {
  if (!ACTOR_ID_RE.test(m.id)) throw new ActorValidationError('Actor id must match /^[a-z0-9][a-z0-9-]{1,60}$/');
  const runtime = m.runtime ?? prev?.runtime ?? 'python';
  if (runtime !== 'python' && runtime !== 'node') throw new ActorValidationError('runtime must be "python" or "node"');
  const entry = runtime === 'python' ? 'main.py' : 'main.ts';
  if (m.entry && m.entry !== entry) throw new ActorValidationError(`entry must be ${entry} for runtime ${runtime}`);
  const tier = m.tier ?? prev?.tier ?? 'http';
  if (!TIERS.has(tier)) throw new ActorValidationError('tier must be one of api, http, browser, session');
  const hostsIn = m.hosts ?? prev?.hosts ?? [];
  if (!Array.isArray(hostsIn)) throw new ActorValidationError('hosts must be an array');
  const hosts = [...new Set(hostsIn.map(normalizeHostPattern))];
  if (hosts.length > 100) throw new ActorValidationError('Too many hosts (max 100)');
  const fromInput = m.hostsFromInput ?? prev?.hostsFromInput;
  if (fromInput != null && (!Array.isArray(fromInput) || fromInput.length > 10 || fromInput.some((f) => typeof f !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(f)))) {
    throw new ActorValidationError('hostsFromInput must be a list of input field names');
  }
  const requires = m.python?.requires ?? prev?.python?.requires;
  if (requires != null) {
    if (!Array.isArray(requires) || requires.some((r) => typeof r !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._\-\[\],<>=!~ ]{0,120}$/.test(r))) {
      throw new ActorValidationError('python.requires must be an array of requirement strings');
    }
  }
  const out: ActorManifest = {
    id: m.id,
    name: String(m.name ?? prev?.name ?? m.id).slice(0, 200),
    version: (prev?.version ?? 0) + 1,
    runtime,
    entry,
    platform: String(m.platform ?? prev?.platform ?? m.id).slice(0, 60),
    tier,
    hosts,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  const description = m.description ?? prev?.description;
  if (description) out.description = String(description).slice(0, 2000);
  const input = m.input ?? prev?.input;
  if (input && typeof input === 'object') out.input = input;
  if (fromInput?.length) out.hostsFromInput = [...new Set(fromInput)];
  if (requires?.length) out.python = { requires };
  const createdBy = m.createdBy ?? prev?.createdBy;
  if (createdBy) out.createdBy = createdBy;
  const notes = m.notes ?? prev?.notes;
  if (notes) out.notes = String(notes).slice(0, 4000);
  return out;
}

export function createActorStore(dataDir: string): ActorStore {
  const root = path.join(dataDir, 'actors');
  const dir = (id: string): string => {
    if (!ACTOR_ID_RE.test(id)) throw new ActorValidationError(`Invalid actor id: ${id}`);
    return path.join(root, id);
  };
  const manifestOf = (id: string): ActorManifest | null => readJson(path.join(dir(id), 'actor.json')) as ActorManifest | null;

  const get = (id: string) => {
    if (!ACTOR_ID_RE.test(id)) return null;
    const manifest = manifestOf(id);
    if (!manifest) return null;
    try {
      return { manifest, code: fs.readFileSync(path.join(dir(id), manifest.entry), 'utf8') };
    } catch {
      return null;
    }
  };

  const write: ActorStore['write'] = ({ manifest, code }) => {
    if (typeof code !== 'string' || !code.trim()) throw new ActorValidationError('Actor code is empty');
    if (code.length > 512 * 1024) throw new ActorValidationError('Actor code is too large (max 512 KB)');
    const d = dir(manifest.id);
    const prev = manifestOf(manifest.id);
    const next = validate(manifest, prev, new Date().toISOString());
    fs.mkdirSync(d, { recursive: true });
    if (prev) {
      // Archive the current version before overwriting it.
      const vdir = path.join(d, 'versions', String(prev.version));
      fs.mkdirSync(vdir, { recursive: true });
      fs.copyFileSync(path.join(d, 'actor.json'), path.join(vdir, 'actor.json'));
      if (fs.existsSync(path.join(d, prev.entry))) fs.copyFileSync(path.join(d, prev.entry), path.join(vdir, prev.entry));
      if (prev.entry !== next.entry) fs.rmSync(path.join(d, prev.entry), { force: true });
    }
    writeAtomic(path.join(d, next.entry), code);
    writeAtomic(path.join(d, 'actor.json'), JSON.stringify(next, null, 2) + '\n');
    return next;
  };

  return {
    dir,
    get,
    write,
    list() {
      let names: string[] = [];
      try {
        names = fs.readdirSync(root);
      } catch {
        return [];
      }
      return names
        .filter((n) => ACTOR_ID_RE.test(n))
        .map((n) => manifestOf(n))
        .filter((m): m is ActorManifest => !!m)
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    versions(id) {
      const cur = manifestOf(id);
      if (!cur) return [];
      const out: ActorVersionInfo[] = [{ version: cur.version, updatedAt: cur.updatedAt, current: true }];
      let names: string[] = [];
      try {
        names = fs.readdirSync(path.join(dir(id), 'versions'));
      } catch {}
      for (const n of names) {
        const m = readJson(path.join(dir(id), 'versions', n, 'actor.json')) as ActorManifest | null;
        if (m && String(m.version) === n) out.push({ version: m.version, updatedAt: m.updatedAt, current: false });
      }
      return out.sort((a, b) => b.version - a.version);
    },
    rollback(id, version) {
      const cur = manifestOf(id);
      if (!cur) throw new ActorValidationError(`No actor ${id}`);
      const vdir = path.join(dir(id), 'versions', String(Math.trunc(version)));
      const old = readJson(path.join(vdir, 'actor.json')) as ActorManifest | null;
      if (!old) throw new ActorValidationError(`Actor ${id} has no version ${version}`);
      const code = fs.readFileSync(path.join(vdir, old.entry), 'utf8');
      // A rollback is a new version whose content equals the old one.
      const { version: _v, createdAt: _c, updatedAt: _u, ...rest } = old;
      return write({ manifest: { ...rest, notes: old.notes }, code });
    },
    remove(id) {
      const d = dir(id);
      if (!fs.existsSync(d)) return;
      const trash = path.join(root, '.trash');
      fs.mkdirSync(trash, { recursive: true });
      fs.renameSync(d, path.join(trash, `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
    },
  };
}
