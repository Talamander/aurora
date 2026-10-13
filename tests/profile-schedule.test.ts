// Profile hours window math and On this day matching. Pinned to a US time zone so the daylight
// saving checks below land on real clock changes (Node re-reads TZ when it is set at runtime).
process.env.TZ = 'America/Chicago';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeProfileSchedule, scheduledProfile, windowAt } from '../core/profileSchedule.ts';
import { scheduleMatches } from '../core/profiles.ts';
import { agoLabel, onThisDay } from '../core/onThisDay.ts';
import type { Item, Profile } from '../core/types.ts';

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const prof = (id: string, schedule: Profile['schedule'], position = 0): Profile =>
  ({ id, name: id, icon: 'star', color: '#7aa2f7', sourceIds: [], schedule, position, createdAt: '' }) as unknown as Profile;

test('weekday 9 to 5 covers office hours in local time only', () => {
  const s = { days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00', auto: true };
  // Tuesday 13 October 2026
  assert.ok(windowAt(s, local(2026, 10, 13, 9, 0)));
  assert.ok(windowAt(s, local(2026, 10, 13, 16, 59)));
  assert.equal(windowAt(s, local(2026, 10, 13, 17, 0)), null);
  assert.equal(windowAt(s, local(2026, 10, 13, 8, 59)), null);
  assert.equal(windowAt(s, local(2026, 10, 17, 12, 0)), null); // Saturday
});

test('an overnight window belongs to the day it starts on', () => {
  const s = { days: [5], from: '22:00', to: '02:00', auto: true }; // Friday nights
  const fri = windowAt(s, local(2026, 10, 16, 23, 30));
  assert.ok(fri);
  assert.deepEqual([fri!.start, fri!.end], [local(2026, 10, 16, 22), local(2026, 10, 17, 2)]);
  assert.ok(windowAt(s, local(2026, 10, 17, 1, 59))); // still Friday's window early on Saturday
  assert.equal(windowAt(s, local(2026, 10, 17, 2, 0)), null);
  assert.equal(windowAt(s, local(2026, 10, 17, 23, 0)), null); // Saturday night is not ticked
  assert.equal(windowAt(s, local(2026, 10, 16, 1, 0)), null); // nor is Thursday night
  assert.equal(scheduleMatches(prof('p', s), local(2026, 10, 17, 1, 0)), true);
});

test('windows keep their clock times across daylight saving changes', () => {
  // US clocks spring forward on Sunday 8 March 2026 and fall back on Sunday 1 November 2026.
  const night = { days: [6], from: '22:00', to: '06:00' };
  const fall = windowAt(night, local(2026, 11, 1, 5, 30))!;
  assert.equal(fall.start.getHours(), 22);
  assert.equal(fall.end.getHours(), 6);
  assert.equal(fall.end.getTime() - fall.start.getTime(), 9 * 3600_000);
  const spring = windowAt(night, local(2026, 3, 8, 5, 30))!;
  assert.equal(spring.end.getHours(), 6);
  assert.equal(spring.end.getTime() - spring.start.getTime(), 7 * 3600_000);
  const day = windowAt({ days: [0], from: '09:00', to: '17:00' }, local(2026, 3, 8, 12))!;
  assert.deepEqual([day.start.getHours(), day.end.getHours()], [9, 17]);
});

test('the shortest overlapping window wins, and only auto profiles switch', () => {
  const work = prof('work', { days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00', auto: true }, 0);
  const lunch = prof('lunch', { days: [2], from: '12:00', to: '13:00', auto: true }, 1);
  const hint = prof('hint', { days: [2], from: '12:00', to: '12:30' }, 2);
  assert.equal(scheduledProfile([work, lunch, hint], local(2026, 10, 13, 12, 15))?.profile.id, 'lunch');
  assert.equal(scheduledProfile([work, lunch, hint], local(2026, 10, 13, 10))?.profile.id, 'work');
  assert.equal(scheduledProfile([hint], local(2026, 10, 13, 12, 15)), null);
  // The key names one window, so a boundary is acted on once.
  const key = (d: Date) => scheduledProfile([work], d)?.key;
  assert.equal(key(local(2026, 10, 13, 10)), key(local(2026, 10, 13, 16)));
  assert.notEqual(key(local(2026, 10, 13, 10)), key(local(2026, 10, 14, 10)));
});

test('the read-back says what will happen', () => {
  assert.equal(
    describeProfileSchedule({ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00', auto: true }, 'Work'),
    'Weekdays, 09:00 to 17:00. Aurora switches to Work then, and back afterwards.',
  );
  assert.equal(
    describeProfileSchedule({ days: [5, 6], from: '20:00', to: '01:00' }, 'Gaming'),
    'Fri and Sat, 20:00 to 01:00 the next morning. Aurora offers to switch to Gaming then.',
  );
  assert.equal(describeProfileSchedule({ days: [0, 6], from: '00:00', to: '00:00', auto: true }, 'Home'), 'Weekends, all day. Aurora switches to Home then, and back afterwards.');
});

const item = (id: string, savedAt: string | null, archived = false): Item =>
  ({ id, author: { name: 'A' }, text: id, state: { read: false, saved: !!savedAt, archived, savedAt } }) as unknown as Item;

test('on this day finds earlier months and years, never today or the archive', () => {
  const now = local(2026, 10, 13, 9);
  const items = [
    item('year', local(2025, 10, 13, 20).toISOString()),
    item('month', local(2026, 9, 13, 8).toISOString()),
    item('today', local(2026, 10, 13, 7).toISOString()),
    item('other', local(2025, 10, 12, 20).toISOString()),
    item('gone', local(2024, 10, 13).toISOString(), true),
  ];
  const m = onThisDay(items, [{ itemId: 'other', quote: 'q', createdAt: local(2026, 4, 13).toISOString() }], now);
  assert.deepEqual(
    m.map((x) => [x.item.id, x.kind, agoLabel(x.monthsAgo)]),
    [['year', 'saved', 'A year ago'], ['other', 'highlighted', '6 months ago'], ['month', 'saved', 'A month ago']],
  );
  assert.equal(agoLabel(13), '13 months ago');
  assert.equal(agoLabel(24), '2 years ago');
});
