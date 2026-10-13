// Routines: plain-English schedules, next-run math, and the rules for turning a routine on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeSchedule, dueAction, nextRun, parseSchedule, splitRoutine } from '../core/routines.ts';
import { createRoutineIn, createRoutines, listRoutines, monthSpent, updateRoutineIn } from '../server/routines.ts';
import { Store } from '../server/db.ts';

test('parseSchedule reads the usual ways people say when', () => {
  assert.deepEqual(parseSchedule('Every weekday at 7:30, make a Work brief'), { kind: 'at', time: '07:30', days: [1, 2, 3, 4, 5] });
  assert.deepEqual(parseSchedule('Sunday night, list the long reads I saved'), { kind: 'at', time: '20:00', days: [0] });
  assert.deepEqual(parseSchedule('Every 2 hours, check Family for photos'), { kind: 'every', hours: 2 });
  assert.deepEqual(parseSchedule('every two hours'), { kind: 'every', hours: 2 });
  assert.deepEqual(parseSchedule('hourly'), { kind: 'every', hours: 1 });
  assert.deepEqual(parseSchedule('After each sync, save posts about Rust'), { kind: 'sync' });
  assert.deepEqual(parseSchedule('daily at 7pm'), { kind: 'at', time: '19:00', days: [] });
  assert.deepEqual(parseSchedule('Mon, Wed and Fri at 8:15am'), { kind: 'at', time: '08:15', days: [1, 3, 5] });
  assert.deepEqual(parseSchedule('every morning'), { kind: 'at', time: '07:00', days: [] });
  assert.deepEqual(parseSchedule('weekends at noon'), { kind: 'at', time: '12:00', days: [0, 6] });
  assert.equal(parseSchedule('make me a brief'), null);
});

test('describeSchedule round-trips through parseSchedule', () => {
  for (const text of ['weekdays at 7:30', 'sunday night', 'every 3 hours', 'after each sync', 'mon, wed at 8:15', 'daily at 6am', 'weekends at 9']) {
    const s = parseSchedule(text)!;
    assert.deepEqual(parseSchedule(describeSchedule(s)), s, text);
  }
  assert.equal(describeSchedule({ kind: 'at', time: '07:30', days: [1, 2, 3, 4, 5] }), 'Weekdays at 07:30');
  assert.equal(describeSchedule({ kind: 'at', time: '20:00', days: [0] }), 'Sundays at 20:00');
});

test('splitRoutine names the job without its schedule', () => {
  const r = splitRoutine('Every weekday at 7:30, make a Work brief from my Work profile');
  assert.equal(r.name, 'Make a Work brief from my Work profile');
  assert.deepEqual(r.schedule, { kind: 'at', time: '07:30', days: [1, 2, 3, 4, 5] });
  assert.ok(splitRoutine('x'.repeat(200)).name.length <= 60);
});

test('nextRun and dueAction work in local time', () => {
  const weekdays = { kind: 'at' as const, time: '07:30', days: [1, 2, 3, 4, 5] };
  // Friday 2026-10-09 08:00 local: the next weekday slot is Monday 07:30.
  const fri = new Date(2026, 9, 9, 8, 0);
  assert.equal(nextRun(weekdays, fri)!.getTime(), new Date(2026, 9, 12, 7, 30).getTime());
  // Turned on Monday 07:00: due at 07:30, not before.
  const mon = new Date(2026, 9, 12, 7, 0);
  assert.equal(dueAction(weekdays, mon, new Date(2026, 9, 12, 7, 29)), 'wait');
  assert.equal(dueAction(weekdays, mon, new Date(2026, 9, 12, 7, 31)), 'run');
  // The computer slept through the slot by more than six hours: skip it rather than run late.
  assert.equal(dueAction(weekdays, mon, new Date(2026, 9, 12, 14, 0)), 'skip');
  const every = { kind: 'every' as const, hours: 2 };
  assert.equal(dueAction(every, mon, new Date(2026, 9, 12, 8, 59)), 'wait');
  assert.equal(dueAction(every, mon, new Date(2026, 9, 12, 9, 1)), 'run');
  // Interval routines never skip; a late one just runs.
  assert.equal(dueAction(every, mon, new Date(2026, 9, 13, 9, 0)), 'run');
  assert.equal(nextRun({ kind: 'sync' }, mon), null);
});

test('routines start off and only a person can turn one on, after a plan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-routines-'));
  try {
    const store = new Store(dir);
    const r = createRoutineIn(store, { text: 'Every weekday at 7:30, make a Work brief' }, []);
    assert.equal(r.enabled, false);
    assert.equal(r.name, 'Make a Work brief');
    assert.throws(() => updateRoutineIn(store, r.id, { enabled: true }, [], true), /Preview the plan/);
    // A plan for the current task lets the user (not the agent) turn it on.
    const list = listRoutines(store);
    list[0] = { ...list[0], plan: 'Search Work posts, save a page.', planFor: list[0].prompt, plannedAt: new Date().toISOString() };
    store.setSetting('routines', list);
    assert.throws(() => updateRoutineIn(store, r.id, { enabled: true }, [], false), /Only the user/);
    const on = updateRoutineIn(store, r.id, { enabled: true }, [], true);
    assert.equal(on.enabled, true);
    assert.ok(on.lastSlotAt);
    // Changing the task turns it off and drops the old plan.
    const changed = updateRoutineIn(store, r.id, { prompt: 'Make a Work brief and post it everywhere' }, [], true);
    assert.equal(changed.enabled, false);
    assert.equal(changed.plan, null);
    assert.throws(() => createRoutineIn(store, { text: 'make a brief' }, []), /Say when/);
    assert.throws(() => createRoutineIn(store, { text: 'daily, brief', profile: 'Nope' }, []), /No profile/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('monthSpent counts only this routine and this month', () => {
  const now = new Date(2026, 9, 13, 12);
  const run = (routineId: string, at: Date, costUsd: number | null) => ({ id: String(Math.random()), routineId, origin: 'schedule' as const, status: 'ok' as const, startedAt: at.toISOString(), finishedAt: at.toISOString(), costUsd, summary: '', error: null, threadId: null, steps: [] });
  const runs = [run('a', new Date(2026, 9, 2), 0.4), run('a', new Date(2026, 9, 12), 0.25), run('a', new Date(2026, 8, 30), 3), run('b', new Date(2026, 9, 5), 1), run('a', new Date(2026, 9, 6), null)];
  assert.equal(Math.round(monthSpent(runs, 'a', now) * 100), 65);
});

test('the scheduler runs a due routine through a stand-in AI and pauses at the monthly limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-routines-'));
  try {
    const store = new Store(dir);
    const events: string[] = [];
    const jobs: { maxBudgetUsd: number; origin: string }[] = [];
    const routines = createRoutines({
      store,
      profiles: () => [],
      // Never a real model: the run is faked and costs 30 cents each time.
      runRoutine: async (job) => {
        jobs.push({ maxBudgetUsd: job.maxBudgetUsd, origin: job.origin });
        return { threadId: 't1', ok: true, text: 'Made the page [[post:x1]].', costUsd: 0.3, error: null, steps: ['Searched posts'] };
      },
      complete: async () => { throw new Error('no model calls in tests'); },
      ready: () => ({ ready: true, provider: 'fake' }),
      broadcast: (e) => { if (e.type === 'ui') events.push(String(e.action.kind)); },
    });
    const r = createRoutineIn(store, { text: 'Every 2 hours, make a brief', monthCapUsd: 0.5 }, []);
    const list = listRoutines(store);
    const turnedOn = new Date(Date.now() - 3 * 3600_000).toISOString();
    list[0] = { ...list[0], enabled: true, plan: 'p', planFor: list[0].prompt, lastSlotAt: turnedOn };
    store.setSetting('routines', list);
    const settle = () => new Promise((ok) => setTimeout(ok, 30));

    routines.tick();
    await settle();
    let view = routines.summary().routines[0];
    assert.equal(view.lastRun?.status, 'ok');
    assert.equal(view.lastRun?.costUsd, 0.3);
    assert.equal(jobs[0].maxBudgetUsd, 0.5);
    // The second run may only spend what is left of the month.
    routines.enqueue(r.id, 'user');
    await settle();
    assert.equal(Math.round(jobs[1].maxBudgetUsd * 100), 20);
    // Now over the limit: a scheduled run is skipped, the routine pauses, and the banner shows.
    routines.enqueue(r.id, 'schedule');
    await settle();
    view = routines.summary().routines[0];
    assert.equal(jobs.length, 2);
    assert.equal(view.lastRun?.status, 'skipped');
    assert.match(view.paused ?? '', /monthly limit/);
    assert.ok(events.includes('ai-paused'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
