// Time well spent: daily totals, idle cut-off, limits and the week line.
process.env.TZ = 'America/Chicago';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeSeconds, addTime, cleanLimit, dayKey, daysEnding, formatMinutes, isDayKey, KEEP_DAYS, limitDue, shortMinutes, totalsOver, weekLine,
} from '../core/timeSpent.ts';

const T = '2026-10-13';

test('day keys are local calendar days and walk across month and DST edges', () => {
  assert.equal(dayKey(new Date(2026, 9, 13, 23, 59)), '2026-10-13');
  assert.equal(dayKey(new Date(2026, 9, 14, 0, 0)), '2026-10-14');
  assert.deepEqual(daysEnding('2026-11-02', 3), ['2026-10-31', '2026-11-01', '2026-11-02']); // DST ends 1 Nov
  assert.ok(isDayKey('2026-02-28'));
  assert.ok(!isDayKey('2026-2-28'));
  assert.ok(!isDayKey('../../etc'));
  assert.ok(!isDayKey(42));
});

test('addTime adds per day and profile, caps one report and drops old days', () => {
  let log = addTime({}, T, 'work', 30, T);
  log = addTime(log, T, 'work', 45, T);
  log = addTime(log, T, 'all', 10, T);
  assert.deepEqual(log[T], { work: 75, all: 10 });
  assert.equal(addTime(log, T, 'work', 10_000, T)[T].work, 75 + 120, 'one report adds at most two minutes');
  assert.deepEqual(addTime(log, T, 'work', -50, T), log, 'negative adds nothing');
  assert.deepEqual(addTime(log, T, 'work', Number.NaN, T), log);
  const old = addTime({ '2026-01-01': { work: 500 } }, T, 'work', 5, T);
  assert.equal(old['2026-01-01'], undefined, 'days older than KEEP_DAYS go');
  assert.equal(addTime({}, '2026-01-01', 'work', 5, T)['2026-01-01'], undefined, 'a report for an old day is ignored');
  assert.equal(daysEnding(T, KEEP_DAYS).length, KEEP_DAYS);
  const input = { [T]: { work: 1 } };
  addTime(input, T, 'work', 5, T);
  assert.equal(input[T].work, 1, 'input untouched');
});

test('active seconds stop a minute after the last input and never count hidden time', () => {
  const t0 = 1_000_000;
  assert.equal(activeSeconds(t0, t0 + 5000, t0, true), 5);
  assert.equal(activeSeconds(t0, t0 + 5000, t0, false), 0);
  // Last touched 58 s before the tick window started: only 2 s of the 5 count.
  assert.equal(activeSeconds(t0, t0 + 5000, t0 - 58_000, true), 2);
  assert.equal(activeSeconds(t0, t0 + 5000, t0 - 120_000, true), 0);
  assert.equal(activeSeconds(t0, t0 - 10, t0, true), 0, 'clock going backwards counts nothing');
});

test('limits clean up and come due once, with a snooze', () => {
  assert.equal(cleanLimit(30), 30);
  assert.equal(cleanLimit('45'), 45);
  assert.equal(cleanLimit(2), 5);
  assert.equal(cleanLimit(10_000), 720);
  assert.equal(cleanLimit(0), null);
  assert.equal(cleanLimit(null), null);
  assert.equal(cleanLimit('x'), null);
  assert.equal(limitDue(30, 29 * 60), false);
  assert.equal(limitDue(30, 30 * 60), true);
  assert.equal(limitDue(null, 99_999), false);
  assert.equal(limitDue(30, 31 * 60, { snoozeTo: 31 * 60 + 300 }), false, 'five more minutes');
  assert.equal(limitDue(30, 36 * 60 + 1, { snoozeTo: 31 * 60 + 300 }), true);
  assert.equal(limitDue(30, 99 * 60, { dismissed: true }), false, 'keep going holds for the day');
});

test('totals over a week and the Your week line', () => {
  const log = {
    '2026-10-06': { work: 3000 }, // outside the 7 days ending 13 Oct (7th to 13th)
    '2026-10-08': { work: 1200, gaming: 600 },
    '2026-10-12': { work: 1800, all: 20 },
    [T]: { gaming: 2400, all: 600 },
  };
  assert.deepEqual(totalsOver(log, T, 7), [
    { profile: 'work', seconds: 3000 },
    { profile: 'gaming', seconds: 3000 },
    { profile: 'all', seconds: 620 },
  ]);
  const names: Record<string, string> = { work: 'Work', gaming: 'Gaming', all: 'All' };
  assert.equal(weekLine(log, T, (p) => names[p]), 'Work 50 minutes, Gaming 50 minutes, All 10 minutes');
  assert.equal(weekLine({}, T, (p) => p), null);
});

test('minutes read like a person wrote them', () => {
  assert.equal(formatMinutes(20), 'under a minute');
  assert.equal(formatMinutes(60), '1 minute');
  assert.equal(formatMinutes(34 * 60 + 59), '34 minutes');
  assert.equal(formatMinutes(80 * 60), '1 h 20 min');
  assert.equal(formatMinutes(120 * 60), '2 h');
  assert.equal(shortMinutes(5 * 60), '5m');
  assert.equal(shortMinutes(65 * 60), '1h05');
  assert.equal(shortMinutes(120 * 60), '2h');
});
