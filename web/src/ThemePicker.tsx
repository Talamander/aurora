import { THEME_PRESETS } from './themes.ts';

// Aurora carries no overrides (it is styles.css itself), so its swatch needs literal colours.
const AURORA: Record<'dark' | 'light', Record<string, string>> = {
  dark: { ground: '#05060a', card: 'rgba(13, 15, 21, 0.9)', 'card-line': 'rgba(255, 255, 255, 0.08)', ink: '#eef0f6', 'ink-3': '#868e9c', lamp: '#ffad7a', lit: 'linear-gradient(100deg, #ffc56b, #ff7a9c 60%, #a69bff)', 'glow-on': '#4fe0c6' },
  light: { ground: '#f3f4f7', card: 'rgba(255, 255, 255, 0.92)', 'card-line': 'rgba(11, 13, 18, 0.07)', ink: '#0b0d12', 'ink-3': '#636d7d', lamp: '#cf4419', lit: 'linear-gradient(100deg, #f08a24, #e8467c 58%, #6d5cf0)', 'glow-on': '#0ea589' },
};

function currentMode(): 'dark' | 'light' {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function ThemePicker({ current, onPick, mode: chosen }: { current: string; onPick: (preset: string) => void; mode?: 'dark' | 'light' }) {
  // The chosen mode, not the painted one: a dark-only preset paints dark even when light is chosen.
  const mode = chosen ?? currentMode();
  return (
    <div className="theme-grid" role="radiogroup" aria-label="Theme">
      {Object.entries(THEME_PRESETS).map(([id, p]) => {
        const t = id === 'aurora' ? AURORA[mode] : mode === 'light' ? p.light ?? p.dark : p.dark;
        const on = current === id || (!current && id === 'aurora');
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={on}
            className={`theme-card ${on ? 'on' : ''}`}
            onClick={() => onPick(id)}
          >
            <span className="theme-prev" style={{ background: t.ground }}>
              <span className="theme-prev-card" style={{ background: t.card, borderColor: t['card-line'] }}>
                <span className="theme-bar" style={{ background: t.ink, width: '78%' }} />
                <span className="theme-bar" style={{ background: t['ink-3'], width: '52%' }} />
                <span className="theme-row">
                  <span className="theme-pill" style={{ background: t.lit }} />
                  <span className="theme-dot" style={{ background: t['glow-on'] }} />
                  <span className="theme-dot" style={{ background: t.lamp }} />
                </span>
              </span>
            </span>
            <span className="theme-name">
              {p.label}
              {!p.light && id !== 'aurora' && <small>dark only</small>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
