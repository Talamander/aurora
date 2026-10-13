// What the phone keeps so it opens instantly and still reads with no connection: the library
// manifest and its chunks, the Read later queue, articles that were opened or put aside, and the
// read/save/hide changes waiting to reach the computer.
//
// Files live in the app's private documents directory (expo-file-system), one folder per paired
// device, and the whole folder is deleted when the phone is unpaired. Nothing here is a secret:
// the device token stays in the keychain (secure.ts). The web build (development preview only)
// uses localStorage and quietly gives up when it is full.
import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';

const web = Platform.OS === 'web';
const WEB_PREFIX = 'aurora.cache.';

let scope: string | null = null;

/** Which paired device the cache belongs to. Null while unpaired. */
export function setCacheScope(id: string | null) {
  scope = id ? safe(id) : null;
}

/** A name like "chunk/2026-W41" as a file-system-safe path. */
function safe(part: string): string {
  return encodeURIComponent(part).replace(/%/g, '~').replace(/\./g, '~2E').slice(0, 180);
}

function fileFor(name: string): File | null {
  if (!scope) return null;
  const parts = name.split('/');
  const leaf = `${safe(parts.pop()!)}.json`;
  const dir = new Directory(Paths.document, 'aurora', scope, ...parts.map(safe));
  dir.create({ intermediates: true, idempotent: true });
  return new File(dir, leaf);
}

export async function readCache<T>(name: string): Promise<T | null> {
  try {
    if (web) {
      if (!scope) return null;
      const raw = globalThis.localStorage?.getItem(`${WEB_PREFIX}${scope}/${name}`);
      return raw ? (JSON.parse(raw) as T) : null;
    }
    const f = fileFor(name);
    if (!f || !f.exists) return null;
    return JSON.parse(await f.text()) as T;
  } catch {
    return null;
  }
}

export function writeCache(name: string, value: unknown): void {
  try {
    const text = JSON.stringify(value);
    if (web) {
      if (scope) globalThis.localStorage?.setItem(`${WEB_PREFIX}${scope}/${name}`, text);
      return;
    }
    fileFor(name)?.write(text);
  } catch {
    /* storage full or blocked: the phone still works, it just remembers less */
  }
}

export function removeCache(name: string): void {
  try {
    if (web) {
      if (scope) globalThis.localStorage?.removeItem(`${WEB_PREFIX}${scope}/${name}`);
      return;
    }
    const f = fileFor(name);
    if (f?.exists) f.delete();
  } catch {
    /* already gone */
  }
}

/** The names kept under a folder ("chunk", "article"), oldest first by modification time. */
export function listCache(folder: string): string[] {
  try {
    if (web) {
      if (!scope) return [];
      const pre = `${WEB_PREFIX}${scope}/${folder}/`;
      const out: string[] = [];
      for (let i = 0; i < (globalThis.localStorage?.length ?? 0); i++) {
        const k = globalThis.localStorage!.key(i);
        if (k?.startsWith(pre)) out.push(k.slice(pre.length));
      }
      return out;
    }
    if (!scope) return [];
    const dir = new Directory(Paths.document, 'aurora', scope, safe(folder));
    if (!dir.exists) return [];
    return dir
      .list()
      .filter((x): x is File => x instanceof File && x.name.endsWith('.json'))
      .sort((a, b) => (a.modificationTime ?? 0) - (b.modificationTime ?? 0))
      .map((f) => decodeURIComponent(f.name.slice(0, -5).replace(/~2E/g, '.').replace(/~/g, '%')));
  } catch {
    return [];
  }
}

/** Forgets everything the phone kept, for every pairing. Called when the phone is unpaired. */
export function wipeCache(): void {
  try {
    if (web) {
      const ls = globalThis.localStorage;
      if (!ls) return;
      const keys: string[] = [];
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k?.startsWith(WEB_PREFIX)) keys.push(k);
      }
      keys.forEach((k) => ls.removeItem(k));
      return;
    }
    const dir = new Directory(Paths.document, 'aurora');
    if (dir.exists) dir.delete();
  } catch {
    /* nothing to wipe */
  }
}
