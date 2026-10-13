// The terminal client prints untrusted post text. None of it may steer the terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oneLine, sanitize } from '../cli/sanitize.ts';
import { resolveBase } from '../cli/api.ts';
import { truncate, width, wrap } from '../cli/term.ts';

const ESC = '\x1b';

test('strips CSI sequences: colours, cursor moves, screen clears', () => {
  assert.equal(sanitize(`${ESC}[31mred${ESC}[0m ${ESC}[2J${ESC}[H${ESC}[10;20Hmoved`), 'red moved');
  assert.equal(sanitize(`${ESC}[?1049l${ESC}[?25lhidden cursor`), 'hidden cursor');
});

test('strips OSC sequences: window title, clipboard write, hyperlinks', () => {
  assert.equal(sanitize(`${ESC}]0;pwned title\x07after`), 'after');
  assert.equal(sanitize(`${ESC}]52;c;ZWNobyBoYWNrZWQ=\x07copy`), 'copy');
  assert.equal(sanitize(`${ESC}]8;;https://evil.example${ESC}\\click me${ESC}]8;;${ESC}\\`), 'click me');
});

test('strips DCS, APC and 8-bit C1 forms', () => {
  assert.equal(sanitize(`${ESC}P+q544e${ESC}\\x`), 'x');
  assert.equal(sanitize(`${ESC}_kitty graphics${ESC}\\y`), 'y');
  assert.equal(sanitize('\x9b31mz\x9d0;title\x07w'), 'zw');
});

test('an unterminated string loses only its introducer, not the rest of the post', () => {
  const out = sanitize(`${ESC}]0;no terminator here, and the rest of the post`);
  assert.ok(!out.includes(ESC));
  assert.ok(out.endsWith('the rest of the post'));
});

test('removes C0/C1 controls and bidi overrides, keeps newlines, tabs and Unicode', () => {
  assert.equal(sanitize('a\x00b\x07c\x08d\x7fe\x85f'), 'abcdef');
  assert.equal(sanitize('safe\u202egnp.exe \u2066x\u2069'), 'safegnp.exe x');
  assert.equal(sanitize('line one\r\nline two\tcol'), 'line one\nline two\tcol');
  assert.equal(sanitize('café 東京 🌅'), 'café 東京 🌅');
});

test('oneLine folds whitespace after sanitizing', () => {
  assert.equal(oneLine(`  hello\n\n${ESC}[1mworld${ESC}[0m  `), 'hello world');
  assert.equal(oneLine(null), '');
});

test('the client refuses non-loopback servers unless allowed', () => {
  assert.equal(resolveBase(undefined, false).host, '127.0.0.1:4317');
  assert.equal(resolveBase('http://localhost:4360', false).port, '4360');
  assert.equal(resolveBase('http://[::1]:4317', false).hostname, '[::1]');
  assert.throws(() => resolveBase('http://192.168.1.10:4317', false), /local-only/);
  assert.throws(() => resolveBase('http://127.0.0.1.evil.example', false), /local-only/);
  assert.equal(resolveBase('http://192.168.1.10:4317', true).hostname, '192.168.1.10');
  assert.throws(() => resolveBase('file:///etc/passwd', true), /http/);
});

test('width, truncate and wrap count wide characters as two columns', () => {
  assert.equal(width('東京'), 4);
  assert.equal(width('e\u0301'), 1);
  assert.equal(truncate('東京タワー', 5), '東京…');
  assert.deepEqual(wrap('the quick brown fox', 9), ['the quick', 'brown fox']);
});
