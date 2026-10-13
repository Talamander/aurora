// Client side of Ambient: a tiny global opener (the palette, the rail, the agent, the desktop
// shell and ?ambient=1 all open the same thing) and the per-browser settings.

export interface AmbientOpen {
  /** A view id or name; the current view when omitted. */
  view?: string | null;
  photosOnly?: boolean;
  /** A person's name or handle. */
  person?: string | null;
  pace?: number;
  /** Ask for full screen right away (only works from a click, or in the desktop app). */
  fullscreen?: boolean;
}

export interface AmbientPrefs {
  pace: 8 | 15 | 30;
  shuffle: boolean;
  photosOnly: boolean;
  clock: boolean;
}

export const PACES = [8, 15, 30] as const;
const DEFAULTS: AmbientPrefs = { pace: 15, shuffle: true, photosOnly: false, clock: true };
const KEY = 'sr.ambient';

export function loadPrefs(): AmbientPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return DEFAULTS;
    return {
      pace: PACES.includes(raw.pace) ? raw.pace : DEFAULTS.pace,
      shuffle: typeof raw.shuffle === 'boolean' ? raw.shuffle : DEFAULTS.shuffle,
      photosOnly: !!raw.photosOnly,
      clock: typeof raw.clock === 'boolean' ? raw.clock : DEFAULTS.clock,
    };
  } catch {
    return DEFAULTS;
  }
}

export function savePrefs(p: AmbientPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

/** The nearest allowed pace for any number of seconds. */
export function nearestPace(s: number | undefined): AmbientPrefs['pace'] | undefined {
  if (!s || !Number.isFinite(s)) return undefined;
  return PACES.reduce((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a));
}

const EVT = 'aurora:ambient';

export function openAmbient(o: AmbientOpen = {}) {
  window.dispatchEvent(new CustomEvent(EVT, { detail: o }));
}

export function onOpenAmbient(fn: (o: AmbientOpen) => void): () => void {
  const h = (e: Event) => fn(((e as CustomEvent).detail ?? {}) as AmbientOpen);
  window.addEventListener(EVT, h);
  return () => window.removeEventListener(EVT, h);
}

/** ?ambient=1 (with optional view, person, photos and pace) from the address, or null. */
export function ambientFromUrl(search = window.location.search): AmbientOpen | null {
  const q = new URLSearchParams(search);
  const v = q.get('ambient');
  if (v === null || v === '0' || v === 'false') return null;
  return {
    view: q.get('view'),
    person: q.get('person'),
    photosOnly: q.get('photos') === '1' || v === 'photos',
    pace: Number(q.get('pace')) || undefined,
  };
}

/** Drops the Ambient parameters from the address, so a reload after closing shows the feed. */
export function clearAmbientUrl() {
  const q = new URLSearchParams(window.location.search);
  if (!q.has('ambient')) return;
  for (const k of ['ambient', 'view', 'person', 'photos', 'pace']) q.delete(k);
  const rest = q.toString();
  window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
}
