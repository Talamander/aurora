// The Waybar status line carries third-party text into a Pango-rendered tooltip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waybar } from '../cli/status.ts';

test('waybar output escapes markup and stays valid JSON', () => {
  const out = JSON.parse(waybar({ profile: 'Work <b>', worth: 2, saved: 1, newest: [{ author: 'Eve & co', text: '<span foreground="red">hi</span>' }] }));
  assert.equal(out.text, '◆ 2');
  assert.equal(out.class, 'unread');
  assert.ok(!out.tooltip.includes('<span'));
  assert.ok(out.tooltip.includes('Eve &amp; co'));
  assert.ok(out.tooltip.includes('Work &lt;b&gt;'));
});
