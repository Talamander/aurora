// Actor runtime: storage, sandboxed runs behind the egress proxy, and the browser service.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBrowserService } from './browser.ts';
import type { BrowserService } from './browser.ts';
import { startProxy } from './proxy.ts';
import type { EgressProxy } from './proxy.ts';
import { runActor } from './runner.ts';
import { createActorStore } from './store.ts';
import type { ActorStore } from './store.ts';
import type { ActorRunOptions, ActorRunResult } from './types.ts';

export type { ActorManifest, ActorRunOptions, ActorRunResult, ProxyLogEntry, RawPost } from './types.ts';
export { rawToDraft } from './map.ts';
export { ActorValidationError } from './store.ts';

export interface ActorRuntime {
  store: ActorStore;
  run(actorId: string, input?: Record<string, unknown>, state?: unknown, opts?: Omit<ActorRunOptions, 'input' | 'state'>): Promise<ActorRunResult>;
  browser: Pick<BrowserService, 'render' | 'probe' | 'openLoginWindow'>;
  /** Starts the egress proxy on first use. */
  proxy(): Promise<EgressProxy>;
  close(): Promise<void>;
}

export function createActorRuntime(dataDir: string): ActorRuntime {
  const store = createActorStore(dataDir);
  const browser = createBrowserService({ dataDir });
  let proxy: Promise<EgressProxy> | null = null;
  let runDir: string | null = null;

  const getProxy = () => {
    // Unix socket paths are limited to ~108 bytes, so sockets live in a short temp dir.
    runDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'sr-proxy-'));
    proxy ??= startProxy({
      runDir,
      browser: (req) => browser.render(req.url, { waitMs: req.waitMs, scroll: req.scroll, capture: req.capture, allowHosts: req.allowHosts, profile: req.profile, timeoutMs: 60_000 }),
    });
    proxy.catch(() => (proxy = null));
    return proxy;
  };

  return {
    store,
    browser: { render: browser.render, probe: browser.probe, openLoginWindow: browser.openLoginWindow },
    proxy: getProxy,
    async run(actorId, input, state, opts = {}) {
      const actor = store.get(actorId);
      if (!actor) throw new Error(`No actor ${actorId}`);
      return runActor({ manifest: actor.manifest, dir: store.dir(actorId) }, { ...opts, input, state, proxy: await getProxy(), dataDir });
    },
    async close() {
      await browser.close();
      if (proxy) await (await proxy).close().catch(() => {});
      proxy = null;
      if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
      runDir = null;
    },
  };
}
