// Omarchy colours.toml parsing: only known keys with plain hex values get through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseColors } from '../server/desktopTheme.ts';

test('parseColors keeps known hex keys and the mode, drops everything else', () => {
  const { mode, colors } = parseColors('mode = "light"\naccent = "#89B4FA"\nbackground = "#1e1e2e"\nforeground = "url(x)"\nevil = "#000000"\n# comment\n');
  assert.equal(mode, 'light');
  assert.deepEqual(colors, { accent: '#89b4fa', background: '#1e1e2e' });
});
