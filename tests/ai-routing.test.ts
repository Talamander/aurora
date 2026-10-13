// Per-task model routing, spending caps and the spend log, without a server or a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capBlock, capStates, isLoopbackUrl, parseCap, parseRoute, pausable, periodStarts, resolveRoute, type Routes } from '../server/agent/routing.ts';
import { createSpend, money } from '../server/agent/spend.ts';
import { paramsB } from '../server/agent/localModels.ts';
import type { AiConfig } from '../server/agent/types.ts';

const claudeMain: AiConfig = { provider: 'claude', model: 'claude-sonnet-5-5', builderModel: 'claude-opus-5-5', baseUrl: null };
const hostedMain: AiConfig = { provider: 'openai', model: 'gpt-x', builderModel: 'gpt-x-big', baseUrl: 'https://openrouter.ai/api/v1' };
const ollama = 'http://127.0.0.1:11434/v1';

test('without routes every job keeps today’s defaults', () => {
  assert.equal(resolveRoute('chat', claudeMain, {}).model, 'claude-sonnet-5-5');
  assert.equal(resolveRoute('builder', claudeMain, {}).model, 'claude-opus-5-5');
  assert.equal(resolveRoute('builder', { ...claudeMain, builderModel: '' }, {}).model, 'claude-sonnet-5-5');
  // A caller's own cheaper model (Haiku for labelling) is kept; otherwise the chat model.
  assert.equal(resolveRoute('classifier', claudeMain, null, 'claude-haiku-5-5').model, 'claude-haiku-5-5');
  assert.equal(resolveRoute('week', claudeMain, undefined).model, 'claude-sonnet-5-5');
  const r = resolveRoute('alerts', claudeMain, {});
  assert.deepEqual([r.provider, r.key, r.routed, r.local], ['claude', 'main', false, false]);
});

test('a main provider on this computer counts as local', () => {
  const local: AiConfig = { provider: 'openai', model: 'qwen3:8b', builderModel: '', baseUrl: ollama };
  const r = resolveRoute('classifier', local, {});
  assert.equal(r.local, true);
  assert.equal(r.baseUrl, ollama);
  assert.equal(resolveRoute('chat', hostedMain, {}).local, false);
});

test('a routed job wins over the defaults and over the caller’s model', () => {
  const routes: Routes = { classifier: { provider: 'openai', model: 'qwen3:8b', baseUrl: ollama }, builder: { provider: 'claude', model: 'claude-sonnet-5-5' } };
  const c = resolveRoute('classifier', claudeMain, routes, 'claude-haiku-5-5');
  assert.deepEqual([c.provider, c.model, c.baseUrl, c.routed, c.local], ['openai', 'qwen3:8b', ollama, true, true]);
  assert.equal(resolveRoute('builder', claudeMain, routes).model, 'claude-sonnet-5-5');
  assert.equal(resolveRoute('chat', claudeMain, routes).routed, false);
});

test('a saved key only goes to the service it was saved for', () => {
  // The Claude key never goes to a local server.
  assert.equal(resolveRoute('alerts', claudeMain, { alerts: { provider: 'openai', model: 'm', baseUrl: ollama } }).key, 'none');
  // The OpenRouter key goes to OpenRouter (same endpoint, trailing slash ignored) and nowhere else.
  assert.equal(resolveRoute('week', hostedMain, { week: { provider: 'openai', model: 'other', baseUrl: 'https://openrouter.ai/api/v1/' } }).key, 'main');
  assert.equal(resolveRoute('week', hostedMain, { week: { provider: 'openai', model: 'm', baseUrl: ollama } }).key, 'none');
  // A Claude job with a non-Claude main provider uses only the environment or Claude Code login.
  assert.equal(resolveRoute('chat', hostedMain, { chat: { provider: 'claude', model: 'claude-haiku-5-5' } }).key, 'env');
  assert.equal(resolveRoute('chat', claudeMain, { chat: { provider: 'claude', model: 'claude-haiku-5-5' } }).key, 'main');
});

test('routes are validated', () => {
  assert.equal(parseRoute(null), null);
  assert.equal(parseRoute({ provider: 'claude', model: '  ' }), null);
  assert.deepEqual(parseRoute({ provider: 'claude', model: 'claude-haiku-5-5', baseUrl: 'http://evil' }), { provider: 'claude', model: 'claude-haiku-5-5' });
  assert.deepEqual(parseRoute({ provider: 'openai', model: 'qwen3:8b', baseUrl: ` ${ollama} ` }), { provider: 'openai', model: 'qwen3:8b', baseUrl: ollama });
  assert.throws(() => parseRoute({ provider: 'claude', model: 'gpt-4' }));
  assert.throws(() => parseRoute({ provider: 'openai', model: 'm', baseUrl: 'file:///etc/passwd' }));
  assert.throws(() => parseRoute({ provider: 'other', model: 'm' }));
  assert.throws(() => parseRoute('claude'));
});

test('loopback detection', () => {
  for (const u of ['http://127.0.0.1:1234/v1', 'http://localhost:11434', 'http://[::1]:8080/v1', 'http://127.4.5.6']) assert.equal(isLoopbackUrl(u), true, u);
  for (const u of ['http://192.168.1.5:11434', 'https://openrouter.ai/api/v1', 'http://127.0.0.1.evil.com', null, 'nonsense']) assert.equal(isLoopbackUrl(u), false, String(u));
});

test('only background work pauses; a chat the user started never does', () => {
  assert.equal(pausable('chat', 'user'), false);
  assert.equal(pausable('chat', 'schedule'), false);
  assert.equal(pausable('summaries', 'schedule'), false);
  assert.equal(pausable('builder', 'user'), false);
  assert.equal(pausable('builder', 'repair'), true);
  for (const t of ['classifier', 'alerts', 'week', 'briefs'] as const) assert.equal(pausable(t, 'schedule'), true);
});

test('caps stop background jobs once reached, and never stop free local calls', () => {
  const caps = { classifier: 1, alerts: 5, chat: 0.01 };
  const spent = { classifier: 1.2, alerts: 0.5, chat: 9 };
  assert.deepEqual(capStates(spent, caps).map((c) => [c.task, c.reached]), [['chat', true], ['classifier', true], ['alerts', false]]);
  assert.equal(capBlock('classifier', 'schedule', spent, caps)?.cap, 1);
  assert.equal(capBlock('alerts', 'schedule', spent, caps), null);
  assert.equal(capBlock('chat', 'user', spent, caps), null, 'chat over its cap still runs');
  assert.equal(capBlock('week', 'schedule', spent, caps), null, 'no cap, no pause');
  assert.equal(capBlock('classifier', 'schedule', spent, caps, true), null, 'local calls are free');
  assert.equal(capBlock('classifier', 'schedule', {}, null), null);
  // A $0 cap means local models only: it stops paid calls but is not shown as paused.
  assert.equal(capBlock('briefs', 'schedule', {}, { briefs: 0 })?.localOnly, true);
  assert.equal(capStates({}, { briefs: 2 })[0].localOnly, false);
  assert.equal(capBlock('briefs', 'schedule', {}, { briefs: 0 }, true), null);
});

test('cap values are validated and rounded to cents', () => {
  assert.equal(parseCap(null), null);
  assert.equal(parseCap(''), null);
  assert.equal(parseCap('2.345'), 2.35);
  assert.equal(parseCap(0), 0);
  assert.throws(() => parseCap(-1));
  assert.throws(() => parseCap('lots'));
  assert.throws(() => parseCap(1e9));
});

test('periods start at local midnight, Monday and the first of the month', () => {
  const now = new Date(2026, 9, 15, 14, 30); // Thursday 15 October 2026
  const p = periodStarts(now);
  assert.equal(new Date(p.today).getTime(), new Date(2026, 9, 15).getTime());
  assert.equal(new Date(p.week).getTime(), new Date(2026, 9, 12).getTime());
  assert.equal(new Date(p.month).getTime(), new Date(2026, 9, 1).getTime());
  // On a Sunday the week still began the Monday before.
  assert.equal(new Date(periodStarts(new Date(2026, 9, 18, 9)).week).getTime(), new Date(2026, 9, 12).getTime());
});

test('the spend log adds up by period, job and model', () => {
  const s = createSpend(':memory:');
  const now = new Date(2026, 9, 15, 12);
  const at = (d: number, h = 10) => new Date(2026, 9, d, h).toISOString();
  s.record({ task: 'chat', provider: 'claude', model: 'claude-sonnet-5-5', costUsd: 0.4, inTokens: 1000, outTokens: 200, local: false, at: at(15) });
  s.record({ task: 'builder', provider: 'claude', model: 'claude-opus-5-5', costUsd: 1.5, local: false, ref: 't1', label: 'Build a Lemmy connector', at: at(13) });
  s.record({ task: 'builder', provider: 'claude', model: 'claude-opus-5-5', costUsd: 0.5, local: false, ref: 't1', label: 'Build a Lemmy connector', at: at(13, 11) });
  s.record({ task: 'classifier', provider: 'openai', model: 'qwen3:8b', costUsd: 0.9, inTokens: 50, outTokens: 5, local: true, at: at(14) });
  s.record({ task: 'week', provider: 'openai', model: 'gpt-x', costUsd: null, local: false, at: at(2) });
  s.record({ task: 'chat', provider: 'claude', model: 'claude-sonnet-5-5', costUsd: 3, local: false, at: new Date(2026, 8, 30).toISOString() });

  const sum = s.summary(now);
  assert.equal(sum.today.calls, 1);
  assert.equal(sum.today.cost, 0.4);
  assert.equal(sum.week.calls, 4);
  assert.equal(Math.round(sum.week.cost * 100), 240, 'local calls count as $0 even when a cost is passed');
  assert.equal(sum.month.calls, 5);
  assert.equal(sum.month.unknown, 1);
  assert.equal(sum.month.inTokens, 1050);
  assert.deepEqual(sum.byTask.map((t) => t.task), ['builder', 'chat', 'classifier', 'week']);
  assert.equal(sum.byModel.find((m) => m.model === 'qwen3:8b')?.local, true);
  assert.deepEqual(sum.topBuilds.map((b) => [b.label, b.cost]), [['Build a Lemmy connector', 2]]);
  assert.equal(sum.daily.length, 30);
  assert.equal(sum.daily.at(-1)?.cost, 0.4);
  assert.deepEqual(s.monthByTask(now), { builder: 2, chat: 0.4, classifier: 0, week: 0 });
  s.close();
});

test('money and model sizes read well', () => {
  assert.equal(money(0), '$0');
  assert.equal(money(0.004), '<$0.01');
  assert.equal(money(1.234), '$1.23');
  assert.equal(paramsB({ id: 'qwen3:8b' }), 8);
  assert.equal(paramsB({ id: 'llama', size: '70.6B' }), 70.6);
  assert.equal(paramsB({ id: 'mistral-small' }), null);
});
