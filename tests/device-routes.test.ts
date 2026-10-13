// The phone's API allowlist. Every route a paired device may call is listed here on purpose, and
// so are the routes it must never reach: keys, sources, sign-ins, actors, pairing, friend key
// material and invites. A new DEVICE_ROUTES entry that opens one of those fails this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceMayCall } from '../server/devices.ts';

const allowed: [string, string][] = [
  ['GET', '/api/library'],
  ['GET', '/api/week'],
  ['GET', '/api/events'],
  ['POST', '/api/items/state'],
  ['GET', '/api/img/config'],
  ['GET', '/api/img'],
  ['GET', '/api/articles/abc'],
  ['POST', '/api/articles/abc/extract'],
  ['PUT', '/api/reading/abc'],
  ['GET', '/api/longform/queue'],
  ['GET', '/api/highlights'],
  ['POST', '/api/highlights'],
  ['GET', '/api/social/thread/xyz'],
  ['POST', '/api/social/reply'],
  ['POST', '/api/social/react'],
  ['GET', '/api/alerts/hits'],
  ['POST', '/api/alerts/seen'],
  // Fast sync, search and More like this (reads only)
  ['GET', '/api/library/chunks/2026-W41'],
  ['GET', '/api/search'],
  ['GET', '/api/items/abc/related'],
  // Routines: the list only
  ['GET', '/api/routines'],
];

const refused: [string, string][] = [
  // Alerts are made, changed and silenced on the computer only
  ['GET', '/api/alerts'],
  ['POST', '/api/alerts'],
  ['PATCH', '/api/alerts/x'],
  ['DELETE', '/api/alerts/x'],
  ['POST', '/api/alerts/x/preview'],
  ['PUT', '/api/alerts/quiet'],
  // AI keys and settings writes
  ['PUT', '/api/agent/config'],
  ['GET', '/api/settings/agent.key'],
  ['PUT', '/api/settings/ui.imageProxy'],
  ['POST', '/api/articles/abc/ai'],
  // Writing the weekly paragraph spends AI credit: the computer only
  ['POST', '/api/week/write'],
  // Sources, sign-ins and actors
  ['GET', '/api/sources'],
  ['POST', '/api/sources'],
  ['PATCH', '/api/sources/x'],
  ['DELETE', '/api/sources/x'],
  ['POST', '/api/login'],
  ['GET', '/api/login/profiles'],
  ['POST', '/api/login/x/input'],
  ['GET', '/api/actors'],
  ['POST', '/api/actors/x/run'],
  // Pairing and device management
  ['POST', '/api/devices/pair'],
  ['POST', '/api/devices/pair/x/approve'],
  ['GET', '/api/devices'],
  ['DELETE', '/api/devices/x'],
  // Friends: identity, invites, friend management, sharing out
  ['GET', '/api/social'],
  ['POST', '/api/social/setup'],
  ['PATCH', '/api/social/me'],
  ['POST', '/api/social/invites'],
  ['POST', '/api/social/invites/accept'],
  ['POST', '/api/social/invites/preview'],
  ['DELETE', '/api/social/invites/x'],
  ['POST', '/api/social/friends/fp/accept'],
  ['POST', '/api/social/friends/fp/remove'],
  ['PATCH', '/api/social/friends/fp'],
  ['POST', '/api/social/circles'],
  ['POST', '/api/social/share'],
  ['GET', '/api/social/shares'],
  ['POST', '/api/social/sync'],
  ['GET', '/api/social/thread/xyz/extra'],
  // Long-form imports, subscriptions and export
  ['POST', '/api/longform/subscribe'],
  ['POST', '/api/longform/import'],
  ['POST', '/api/longform/sources/x'],
  ['GET', '/api/longform/epub'],
  ['PATCH', '/api/highlights/x'],
  ['DELETE', '/api/highlights/x'],
  // Profiles are read from the library, never edited from the phone
  ['POST', '/api/profiles'],
  ['PATCH', '/api/profiles/x'],
  ['PUT', '/api/profiles/active'],
  ['GET', '/api/profiles'],
  // Wrong methods and lookalike paths on allowed routes
  ['POST', '/api/img/config'],
  ['POST', '/api/img'],
  ['GET', '/api/img/config/x'],
  ['DELETE', '/api/articles/abc'],
  ['GET', '/api/reading/abc'],
  ['GET', '/api/articles/abc/extract'],
  // Sync and search are reads: no writes, no index control, no lookalikes
  ['POST', '/api/library'],
  ['POST', '/api/library/chunks/2026-W41'],
  ['GET', '/api/library/chunks'],
  ['GET', '/api/library/chunks/a/b'],
  ['POST', '/api/search'],
  ['GET', '/api/search/status'],
  ['GET', '/api/search/x'],
  ['POST', '/api/items/abc/related'],
  ['GET', '/api/items/abc'],
  ['GET', '/api/items/abc/related/x'],
  ['DELETE', '/api/items/abc'],
  // Routines are written, planned, turned on and run on the computer only
  ['POST', '/api/routines'],
  ['PATCH', '/api/routines/x'],
  ['DELETE', '/api/routines/x'],
  ['POST', '/api/routines/x/plan'],
  ['POST', '/api/routines/x/run'],
  ['GET', '/api/routines/x'],
  ['GET', '/api/routines/x/runs'],
  ['GET', '/api/routinesx'],
  ['GET', '/api/routines/'],
  ['PUT', '/api/routines'],
];

test('a device may call the reader routes the phone needs', () => {
  for (const [m, p] of allowed) assert.ok(deviceMayCall(m, p), `${m} ${p} should be allowed`);
});

test('a device may never reach keys, sources, sign-ins, actors, pairing, invites or friend management', () => {
  for (const [m, p] of refused) assert.ok(!deviceMayCall(m, p), `${m} ${p} must be refused`);
});
