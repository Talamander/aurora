// Finds model servers running on this computer. One short request to each of three fixed
// loopback ports, only when AI settings open. Never scans the network.

export interface LocalServer {
  id: 'ollama' | 'lmstudio' | 'llamacpp';
  name: string;
  /** The OpenAI-compatible endpoint Aurora talks to. */
  baseUrl: string;
  models: { id: string; size?: string; params?: number | null }[];
}

const SERVERS: { id: LocalServer['id']; name: string; port: number }[] = [
  { id: 'ollama', name: 'Ollama', port: 11434 },
  { id: 'lmstudio', name: 'LM Studio', port: 1234 },
  { id: 'llamacpp', name: 'llama.cpp server', port: 8080 },
];

async function getJson(url: string, ms: number): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: 'error' });
  if (!res.ok) throw new Error(String(res.status));
  const text = await res.text();
  if (text.length > 2_000_000) throw new Error('too big');
  return JSON.parse(text);
}

const clean = (s: unknown) => String(s ?? '').replace(/[^\w.:\-/@+]/g, '').slice(0, 120);

const withParams = (models: { id: string; size?: string }[]) => models.map((m) => ({ ...m, params: paramsB(m) }));

async function probe(s: (typeof SERVERS)[number], ms: number): Promise<LocalServer | null> {
  const root = `http://127.0.0.1:${s.port}`;
  try {
    if (s.id === 'ollama') {
      const j = await getJson(`${root}/api/tags`, ms);
      if (!Array.isArray(j?.models)) return null;
      const models = j.models.slice(0, 60).map((m: any) => ({ id: clean(m.name ?? m.model), size: m.details?.parameter_size ? clean(m.details.parameter_size) : undefined })).filter((m: any) => m.id);
      return { id: s.id, name: s.name, baseUrl: `${root}/v1`, models: withParams(models) };
    }
    const j = await getJson(`${root}/v1/models`, ms);
    if (!Array.isArray(j?.data)) return null;
    const models = j.data.slice(0, 60).map((m: any) => ({ id: clean(m.id) })).filter((m: any) => m.id);
    return { id: s.id, name: s.name, baseUrl: `${root}/v1`, models: withParams(models) };
  } catch {
    return null;
  }
}

export async function detectLocalModels(ms = 700): Promise<LocalServer[]> {
  const found = await Promise.all(SERVERS.map((s) => probe(s, ms)));
  return found.filter((x): x is LocalServer => !!x);
}

/** A rough size guess from the model name or the reported parameter size, in billions. */
export function paramsB(m: { id: string; size?: string }): number | null {
  const src = `${m.size ?? ''} ${m.id}`;
  const x = /(\d+(?:\.\d+)?)\s*[bB]\b/.exec(src);
  return x ? Number(x[1]) : null;
}
