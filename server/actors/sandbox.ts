// Builds the command that runs an actor: bubblewrap when it works here, a plain child
// process otherwise. Inside bwrap there is no network namespace; the egress proxy's unix
// socket is bound in and sr/launch.mjs bridges it to 127.0.0.1 for HTTP(S)_PROXY.
//
// Layout inside the sandbox:
//   /usr, /etc/ssl, /etc/ca-certificates   read-only system (lib/bin symlinks mirrored)
//   /actor                                 the actor dir, read-only
//   /sr                                    helper libs (python/sr.py, node/sr.ts), read-only
//   /cache                                 per-actor writable cache (uv)
//   /opt/sr/bin/{node,uv}                  host binaries, read-only
//   /run/sr/proxy.sock                     the run's proxy socket
//   /tmp (tmpfs, HOME=/tmp/home)

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ActorManifest } from './types.ts';

export const SR_DIR = path.join(import.meta.dirname, 'sr');
const TMPFS_BYTES = 256 * 1024 * 1024;
const MEMORY_MAX = '1536M';
const TASKS_MAX = 512;

export type Isolation = 'bwrap' | 'none';

export const NEEDS_SANDBOX =
  'Connectors written by the AI need a sandbox; on macOS run Aurora in Docker (docs/self-hosting.md) or on Linux';

/**
 * Whether an actor may run as a plain child process when bubblewrap is unavailable. On Linux the
 * fallback stays automatic (containers whose seccomp profile blocks bwrap rely on it, and the run
 * is labelled isolation: none). Elsewhere (macOS, Windows) there is no sandbox at all, so
 * AI-written code never runs unless the owner opts in with SR_ACTOR_ISOLATION=none.
 */
export function unsandboxedAllowed(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  return platform === 'linux' || env.SR_ACTOR_ISOLATION === 'none';
}

export interface SandboxSpec {
  manifest: ActorManifest;
  actorDir: string;
  cacheDir: string;
  /** Session unix socket (bwrap) and credentialed TCP proxy URL (fallback). */
  socketPath: string;
  proxyUrl: string;
  env: Record<string, string>;
}

export interface SandboxCommand {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  isolation: Isolation;
  cleanup(): void;
}

function which(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.realpathSync(p);
    } catch {}
  }
  return null;
}

const run = (cmd: string, args: string[]): Promise<boolean> =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 10_000 }, (err) => resolve(!err)));

let probe: Promise<{ bwrap: boolean; systemdRun: boolean }> | null = null;

/**
 * Checks once whether unprivileged bwrap and `systemd-run --user --scope` work on this machine.
 * The bwrap probe mounts /proc and /dev like a real run: under Podman's default seccomp a bare
 * probe passes but `--proc` fails, and then we must fall back instead of failing every run.
 */
export function detectIsolation(): Promise<{ bwrap: boolean; systemdRun: boolean }> {
  probe ??= (async () => {
    if (process.env.SR_ACTOR_ISOLATION === 'none') return { bwrap: false, systemdRun: false };
    const bwrap = which('bwrap') ? await run('bwrap', ['--unshare-all', '--die-with-parent', ...systemBinds(), '--proc', '/proc', '--dev', '/dev', '--', '/usr/bin/true']) : false;
    const systemdRun = which('systemd-run') ? await run('systemd-run', ['--user', '--scope', '--quiet', '-p', `MemoryMax=${MEMORY_MAX}`, '--', '/usr/bin/true']) : false;
    return { bwrap, systemdRun };
  })();
  return probe;
}

function systemBinds(): string[] {
  const out = ['--ro-bind', '/usr', '/usr'];
  for (const d of ['/bin', '/sbin', '/lib', '/lib64', '/lib32']) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(d);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) out.push('--symlink', fs.readlinkSync(d), d);
    else out.push('--ro-bind', d, d);
  }
  for (const e of ['/etc/ssl', '/etc/ca-certificates', '/etc/pki', '/etc/alternatives', '/etc/localtime', '/etc/ld.so.cache']) {
    out.push('--ro-bind-try', e, e);
  }
  return out;
}

function actorCommand(m: ActorManifest, binDir: string, actorDir: string, nodeHooks: string): string[] {
  if (m.runtime === 'node') return [path.join(binDir, 'node'), '--import', nodeHooks, '--disable-warning=ExperimentalWarning', path.join(actorDir, 'main.ts')];
  const withs = (m.python?.requires ?? []).flatMap((r) => ['--with', r]);
  return [path.join(binDir, 'uv'), 'run', '--isolated', '--no-project', '--python', '3', ...withs, path.join(actorDir, 'main.py')];
}

function baseEnv(spec: SandboxSpec): Record<string, string> {
  return {
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    UV_NO_PROGRESS: '1',
    UV_PYTHON_DOWNLOADS: 'never',
    NODE_USE_ENV_PROXY: '1',
    NO_PROXY: '',
    no_proxy: '',
    ...spec.env,
  };
}

/** Wraps a command in a memory/tasks-limited scope and rlimits where available. */
function limits(cmd: string, args: string[], systemdRun: boolean): { cmd: string; args: string[]; env: Record<string, string> } {
  let c = cmd;
  let a = args;
  if (which('prlimit')) {
    a = ['--nofile=1024', '--fsize=2147483648', '--core=0', '--', c, ...a];
    c = 'prlimit';
  }
  if (systemdRun) {
    // systemd-run needs the session bus; the actor must not inherit it.
    a = ['-u', 'XDG_RUNTIME_DIR', '-u', 'DBUS_SESSION_BUS_ADDRESS', c, ...a];
    c = 'env';
    a = ['--user', '--scope', '--quiet', '--collect', '-p', `MemoryMax=${MEMORY_MAX}`, '-p', 'MemorySwapMax=0', '-p', `TasksMax=${TASKS_MAX}`, '--', c, ...a];
    c = 'systemd-run';
  }
  const env: Record<string, string> = {};
  if (systemdRun) {
    for (const k of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[k]) env[k] = process.env[k]!;
  }
  return { cmd: c, args: a, env };
}

export async function buildSandboxCommand(spec: SandboxSpec): Promise<SandboxCommand> {
  const { bwrap, systemdRun } = await detectIsolation();
  if (!bwrap && !unsandboxedAllowed()) throw new Error(NEEDS_SANDBOX);
  const uv = which('uv');
  if (spec.manifest.runtime === 'python' && !uv) throw new Error('uv is not installed on the host (needed for python actors)');
  fs.mkdirSync(path.join(spec.cacheDir, 'uv'), { recursive: true });

  if (bwrap) {
    const args = [
      '--unshare-all',
      '--die-with-parent',
      '--new-session',
      '--cap-drop', 'ALL',
      ...systemBinds(),
      '--proc', '/proc',
      '--dev', '/dev',
      '--size', String(TMPFS_BYTES), '--tmpfs', '/tmp',
      '--dir', '/tmp/home',
      '--ro-bind', spec.actorDir, '/actor',
      '--ro-bind', SR_DIR, '/sr',
      '--bind', spec.cacheDir, '/cache',
      '--ro-bind', process.execPath, '/opt/sr/bin/node',
      ...(uv ? ['--ro-bind', uv, '/opt/sr/bin/uv'] : []),
      '--ro-bind', spec.socketPath, '/run/sr/proxy.sock',
      '--hostname', 'sr-actor',
      '--chdir', '/tmp',
      '--',
      '/opt/sr/bin/node', '/sr/launch.mjs', '/run/sr/proxy.sock',
      ...actorCommand(spec.manifest, '/opt/sr/bin', '/actor', 'file:///sr/node/hooks.mjs'),
    ];
    const env = {
      ...baseEnv(spec),
      PATH: '/opt/sr/bin:/usr/bin:/bin',
      HOME: '/tmp/home',
      TMPDIR: '/tmp',
      PYTHONPATH: '/sr/python',
      UV_CACHE_DIR: '/cache/uv',
      UV_PYTHON_PREFERENCE: 'only-system',
      SR_NODE_LIB: 'file:///sr/node/sr.ts',
    };
    const w = limits('bwrap', args, systemdRun);
    return { cmd: w.cmd, args: w.args, env: { ...env, ...w.env }, cwd: os.tmpdir(), isolation: 'bwrap', cleanup() {} };
  }

  // Fallback: plain child process. Still forced through the proxy, but not contained.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-actor-'));
  fs.mkdirSync(path.join(tmp, 'home'));
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir);
  fs.symlinkSync(process.execPath, path.join(binDir, 'node'));
  if (uv) fs.symlinkSync(uv, path.join(binDir, 'uv'));
  const [cmd, ...args] = actorCommand(spec.manifest, binDir, spec.actorDir, pathToFileURL(path.join(SR_DIR, 'node', 'hooks.mjs')).href);
  const env: Record<string, string> = {
    ...baseEnv(spec),
    PATH: `${binDir}:/usr/bin:/bin`,
    HOME: path.join(tmp, 'home'),
    TMPDIR: tmp,
    PYTHONPATH: path.join(SR_DIR, 'python'),
    UV_CACHE_DIR: path.join(spec.cacheDir, 'uv'),
    SR_NODE_LIB: pathToFileURL(path.join(SR_DIR, 'node', 'sr.ts')).href,
  };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[k] = spec.proxyUrl;
  const w = limits(cmd, args, systemdRun);
  return { cmd: w.cmd, args: w.args, env: { ...env, ...w.env }, cwd: tmp, isolation: 'none', cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}
