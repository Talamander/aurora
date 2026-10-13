// Runs one actor: opens a proxy session for its hosts, starts it in the sandbox, parses the
// JSON-lines protocol from stdout, enforces time/output/item limits and returns the result.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { EgressProxy } from './proxy.ts';
import { buildSandboxCommand } from './sandbox.ts';
import { inputHosts } from './store.ts';
import { sessionProfileFor } from './browser.ts';
import type { ActorManifest, ActorRunOptions, ActorRunResult, RawPost } from './types.ts';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_ITEMS = 300;
const STDOUT_CAP = 20 * 1024 * 1024;
const MAX_LOG_LINES = 400;
const MAX_LOG_CHARS = 2000;
const MAX_ITEM_BYTES = 256 * 1024;

const PEP723_RE = /^# \/\/\/ script\s*$/m;

export interface RunContext {
  proxy: EgressProxy;
  dataDir: string;
}

function validItem(v: unknown): v is RawPost {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if ((typeof o.id !== 'string' && typeof o.id !== 'number') || String(o.id).trim() === '') return false;
  return typeof o.url === 'string' && /^https?:\/\//i.test(o.url);
}

export async function runActor(
  actor: { manifest: ActorManifest; dir: string },
  opts: ActorRunOptions & RunContext,
): Promise<ActorRunResult> {
  const started = Date.now();
  const { manifest } = actor;
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
  const maxItems = Math.max(1, opts.maxItems ?? DEFAULT_MAX_ITEMS);
  const logs: string[] = [];
  let droppedLogs = 0;
  const addLog = (line: string) => {
    const l = line.length > MAX_LOG_CHARS ? line.slice(0, MAX_LOG_CHARS) + '…' : line;
    opts.onLog?.(l);
    if (logs.length < MAX_LOG_LINES) logs.push(l);
    else droppedLogs++;
  };

  let code = '';
  try {
    code = fs.readFileSync(path.join(actor.dir, manifest.entry), 'utf8');
  } catch {
    return { ok: false, items: [], state: opts.state ?? null, logs, error: `Actor entry ${manifest.entry} not found`, requests: [], durationMs: 0, isolation: 'none' };
  }
  const hasDeps = manifest.runtime === 'python' && (!!manifest.python?.requires?.length || PEP723_RE.test(code));
  const session = await opts.proxy.openSession({ hosts: [...new Set([...manifest.hosts, ...inputHosts(manifest, opts.input)])], packageIndex: hasDeps, profile: manifest.tier === 'session' ? sessionProfileFor(manifest) : undefined });
  const cacheDir = path.join(opts.dataDir, 'cache', 'actors', manifest.id);

  let cmd;
  try {
    cmd = await buildSandboxCommand({
      manifest,
      actorDir: actor.dir,
      cacheDir,
      socketPath: session.socketPath,
      proxyUrl: session.proxyUrl,
      env: {
        SR_INPUT: JSON.stringify(opts.input ?? {}),
        SR_STATE: JSON.stringify(opts.state ?? {}),
        SR_ACTOR_ID: manifest.id,
      },
    });
  } catch (e) {
    await session.close();
    return { ok: false, items: [], state: opts.state ?? null, logs, error: (e as Error).message, requests: session.log, durationMs: Date.now() - started, isolation: 'none' };
  }

  const items: RawPost[] = [];
  const seen = new Set<string>();
  let state: unknown = opts.state ?? null;
  let error: string | undefined;
  let truncated = false;
  let stdoutBytes = 0;
  let killedFor: string | null = null;

  const child = spawn(cmd.cmd, cmd.args, { env: cmd.env, cwd: cmd.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const kill = (why: string) => {
    if (killedFor) return;
    killedFor = why;
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  const timer = setTimeout(() => kill(`timed out after ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
  const onAbort = () => kill('cancelled');
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  if (opts.signal?.aborted) onAbort();

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let msg: Record<string, unknown> | null = null;
    if (line.startsWith('{')) {
      try {
        msg = JSON.parse(line);
      } catch {}
    }
    if (!msg || typeof msg.type !== 'string') return addLog(line);
    switch (msg.type) {
      case 'item': {
        if (line.length > MAX_ITEM_BYTES) return addLog('dropped item: larger than 256 KB');
        if (!validItem(msg.item)) return addLog('dropped item: needs id and http(s) url');
        const item = { ...(msg.item as RawPost), id: String((msg.item as RawPost).id) };
        if (seen.has(item.id)) return;
        if (items.length >= maxItems) {
          truncated = true;
          return;
        }
        seen.add(item.id);
        items.push(item);
        return;
      }
      case 'state':
        state = msg.state ?? null;
        return;
      case 'log':
        return addLog(String(msg.msg ?? ''));
      case 'error':
        error = String(msg.msg ?? 'actor reported an error').slice(0, 2000);
        return addLog(`error: ${error}`);
      default:
        return addLog(line);
    }
  };

  const lineReader = (onLine: (l: string) => void, countBytes: boolean) => {
    const dec = new StringDecoder('utf8');
    let buf = '';
    return {
      data(chunk: Buffer) {
        if (countBytes) {
          stdoutBytes += chunk.length;
          if (stdoutBytes > STDOUT_CAP) return kill('stdout exceeded 20 MB');
        }
        buf += dec.write(chunk);
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, i).replace(/\r$/, ''));
          buf = buf.slice(i + 1);
        }
        if (buf.length > 4 * 1024 * 1024) {
          onLine(buf);
          buf = '';
        }
      },
      end() {
        buf += dec.end();
        if (buf) onLine(buf);
        buf = '';
      },
    };
  };
  const out = lineReader(handleLine, true);
  const stderrTail: string[] = [];
  const err = lineReader((l) => {
    if (!l.trim()) return;
    stderrTail.push(l.trim().slice(0, 300));
    if (stderrTail.length > 3) stderrTail.shift();
    addLog(l);
  }, false);
  child.stdout.on('data', out.data);
  child.stderr.on('data', err.data);

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('error', (e) => {
      error ??= `failed to start: ${e.message}`;
      resolve(null);
    });
    child.on('close', (c) => resolve(c));
  });
  out.end();
  err.end();
  clearTimeout(timer);
  opts.signal?.removeEventListener('abort', onAbort);
  await session.close();
  cmd.cleanup();

  if (killedFor) error = killedFor;
  // A crash's last stderr line (Python's exception line, SystemExit text) is the useful part.
  else if (!error && exitCode !== 0) error = `actor exited with code ${exitCode}${stderrTail.length ? `: ${stderrTail[stderrTail.length - 1]}` : ''}`;
  if (truncated) addLog(`stopped collecting at maxItems=${maxItems}`);
  if (droppedLogs) logs.push(`(${droppedLogs} more log lines dropped)`);
  const blocked = session.log.filter((r) => r.blocked);
  if (blocked.length && error) error += ` (proxy blocked: ${[...new Set(blocked.map((b) => `${b.host} ${b.reason}`))].slice(0, 5).join('; ')})`;

  return {
    ok: !error,
    items,
    state,
    logs,
    ...(error ? { error } : {}),
    requests: session.log,
    durationMs: Date.now() - started,
    isolation: cmd.isolation,
    exitCode,
    ...(truncated ? { truncated } : {}),
  };
}
