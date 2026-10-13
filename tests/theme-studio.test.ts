import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio, derive, normalizeSeed, parseThemeFile, seedFromPixels, seedFromTokens, themeFile, DEFAULT_SEED, THEME_FILE_MAX } from '../web/src/themeStudio.ts';

const hex = (v: string) => v.match(/#[0-9a-f]{6}/gi) ?? [];

test('every derived palette passes WCAG AA for text, in both modes, across the dials', () => {
  for (const hue of [0, 28, 60, 95, 140, 200, 250, 300, 340]) {
    for (const chroma of [0, 0.5, 1]) {
      for (const contrast of [0, 1]) {
        for (const warmth of [-1, 0, 1]) {
          const seed = normalizeSeed({ ...DEFAULT_SEED, hue, accents: [hue + 30, hue, hue - 60], chroma, contrast, warmth });
          for (const mode of ['dark', 'light'] as const) {
            const t = derive(seed, mode).tokens;
            const where = `${mode} hue=${hue} chroma=${chroma} contrast=${contrast} warmth=${warmth}`;
            for (const bg of [t.ground, t.surface]) {
              assert.ok(contrastRatio(t.ink, bg) >= 7, `ink ${where}`);
              assert.ok(contrastRatio(t['ink-2'], bg) >= 4.5, `ink-2 ${where}`);
              assert.ok(contrastRatio(t['ink-3'], bg) >= 4.5, `ink-3 ${where}`);
              assert.ok(contrastRatio(t['lamp-ink'], bg) >= 4.5, `lamp-ink ${where}`);
            }
            assert.ok(contrastRatio(t['on-lamp'], t.lamp) >= 4.5, `on-lamp ${where}`);
            for (const stop of [...hex(t.lit), ...hex(t['lit-soft'])]) assert.ok(contrastRatio(t['on-lit'], stop) >= 4.5, `on-lit ${where}`);
          }
        }
      }
    }
  }
});

test('theme files round-trip and reject anything that is not a theme', () => {
  const seed = normalizeSeed({ ...DEFAULT_SEED, name: 'Harbour at dusk', hue: 210, font: 'literata', radius: 14 });
  const back = parseThemeFile(themeFile(seed));
  assert.deepEqual(back.seed, seed);
  assert.equal(back.ignored, 0);

  assert.throws(() => parseThemeFile('x'.repeat(THEME_FILE_MAX + 1)), /too big/);
  assert.throws(() => parseThemeFile('{nope'), /not valid JSON/);
  assert.throws(() => parseThemeFile(JSON.stringify({ kind: 'other', version: 1, seed: {} })), /not an Aurora theme/);

  const hostile = JSON.stringify({
    kind: 'aurora-theme',
    version: 1,
    script: 'alert(1)',
    seed: { name: '<img onerror=x>Evil;}', hue: 'red', ground: 'url(http://x)', radius: 999, font: 'comic', density: 'compact', accents: [1, 2] },
  });
  const p = parseThemeFile(hostile);
  assert.equal(p.seed.name, 'img onerror=xEvil');
  assert.equal(p.seed.hue, DEFAULT_SEED.hue);
  assert.equal(p.seed.radius, 34);
  assert.equal(p.seed.font, 'geist');
  assert.equal(p.seed.density, 'compact');
  assert.deepEqual(p.seed.accents, DEFAULT_SEED.accents);
  assert.equal(p.ignored, 4);
  for (const v of Object.values(derive(p.seed, 'dark').tokens)) assert.doesNotMatch(v, /[;{}<>]|url\(/i);
});

test('a picture becomes a seed keyed to its strongest colour', () => {
  // Mostly teal with a band of orange: the key hue should land in teal, an accent in orange.
  const px: number[] = [];
  for (let i = 0; i < 900; i++) px.push(20, 150, 150, 255);
  for (let i = 0; i < 300; i++) px.push(240, 130, 30, 255);
  const { seed, swatches, mode } = seedFromPixels(px);
  assert.ok(seed.hue > 150 && seed.hue < 230, `key hue ${seed.hue}`);
  assert.ok(seed.accents.some((h) => h > 30 && h < 90), `accents ${seed.accents}`);
  assert.equal(swatches.length, 2);
  assert.equal(mode, 'dark');
});

test('tokens set by the AI can be pulled back into dials', () => {
  const t = derive(normalizeSeed({ ...DEFAULT_SEED, hue: 140 }), 'dark').tokens;
  const seed = seedFromTokens(t);
  assert.ok(seed && Math.abs(seed.hue - 140) < 15, `hue ${seed?.hue}`);
  assert.equal(seedFromTokens({ ground: '#000000' }), null);
});
