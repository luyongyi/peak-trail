import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseWatchCode, parseWatchId, normalizeWatchInput, resolveWatchInput, watchSharePayload, watchCodeFromState } from '../src/watch-client.js';

const id = 'a'.repeat(32);
const url = 'https://Example.test/MixedCase/?watch=' + id + '&lang=en#Share';

test('live codes normalize four ASCII letters without altering legacy watch URLs', () => {
  assert.equal(parseWatchCode(' abcd '), 'ABCD');
  for (const value of ['ABC', 'ABCDE', 'AB12', 'ＡＢＣＤ', 'AB C']) assert.equal(parseWatchCode(value), null);
  assert.equal(normalizeWatchInput('ab'), 'AB');
  assert.equal(normalizeWatchInput('abcd'), 'ABCD');
  assert.equal(normalizeWatchInput(url), url);
  assert.equal(normalizeWatchInput(id), id);
});

test('legacy links bypass code lookup and short codes resolve using same-origin no-store requests', async () => {
  let calls = 0;
  const controller = new AbortController();
  const fetchImpl = async (endpoint, options) => {
    calls++; assert.equal(endpoint, '/api/live/v2/codes/ABCD');
    assert.equal(options.signal, controller.signal); assert.equal(options.cache, 'no-store');
    return { ok: true, json: async () => ({ watchCode: 'ABCD', watchId: id, status: 'reconnecting', watchPath: '/?watch=' + id }) };
  };
  assert.deepEqual(await resolveWatchInput(url, { fetchImpl }), { watchId: id, watchCode: null });
  assert.equal(calls, 0);
  assert.deepEqual(await resolveWatchInput(' abcd ', { fetchImpl, signal: controller.signal }), { watchId: id, watchCode: 'ABCD' });
  assert.equal(calls, 1);
  await assert.rejects(resolveWatchInput('ab12', { fetchImpl }), { code: 'invalid-watch-input' });
  assert.equal(calls, 1);
});

test('code resolution distinguishes expired, throttled and invalid service responses', async () => {
  for (const status of [404, 410]) await assert.rejects(resolveWatchInput('ABCD', {
    fetchImpl: async () => ({ ok: false, status }),
  }), { code: 'unknown-watch-code' });
  await assert.rejects(resolveWatchInput('ABCD', {
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ retryAfterMs: 12345 }) }),
  }), { code: 'rate-limited', retryAfterMs: 12345 });
  for (const data of [{ watchCode: 'ABCD', watchId: 'bad', status: 'live' },
    { watchCode: 'WXYZ', watchId: id, status: 'live' }, { watchCode: 'ABCD', watchId: id, status: 'ended' }]) {
    await assert.rejects(resolveWatchInput('ABCD', { fetchImpl: async () => ({ ok: true, json: async () => data }) }), { code: 'watch-service-unavailable' });
  }
});

test('code lookup retains the native fetch receiver', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async function () {
    assert.equal(this, globalThis);
    return { ok: true, json: async () => ({ watchCode: 'ABCD', watchId: id, status: 'live' }) };
  };
  try { assert.equal((await resolveWatchInput('ABCD')).watchId, id); }
  finally { globalThis.fetch = previous; }
});

test('ended state immediately removes the short code and sharing falls back to the durable watch URL', () => {
  const watch = { id, status: 'live', code: 'ABCD' };
  assert.deepEqual(watchSharePayload(watch, url), { text: 'ABCD', kind: 'code' });
  assert.deepEqual(watchSharePayload(watch, url, 'link'), { text: 'https://example.test/MixedCase/?watch=' + id, kind: 'link' });
  assert.equal(watchCodeFromState('ABCD', { status: 'reconnecting' }), 'ABCD');
  assert.equal(watchCodeFromState('ABCD', { epoch: 2, watchCode: 'ABCD', status: 'live' }), 'ABCD');
  assert.equal(watchCodeFromState('ABCD', { status: 'ended' }), null);
  assert.equal(watchCodeFromState('ABCD', { watchCode: null }), null);
  watch.status = 'ended';
  assert.equal(watchSharePayload(watch, url).kind, 'link', 'a stale copied code cannot remain shareable after ended');
});

const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
function joinFixture(resolver) {
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, { attributes: {}, setAttribute(k,v) { this.attributes[k] = v; } }); return nodes.get(id); };
  const state = { watchJoin: { revision: 0, controller: null, pending: false, error: null, retryAt: 0 } };
  const opened = [];
  let api;
  const ports = { state, $, AbortController, parseWatchId, resolveWatchInput: resolver,
    location: { href: url }, tr: value => value, watchText: value => value,
    startWatch: async (...args) => { opened.push(args); api.cancelWatchJoin(); } };
  const names = ['updateWatchJoinUI', 'cancelWatchJoin', 'joinWatchFromInput'];
  api = new Function(...Object.keys(ports), names.map(name => app.match(new RegExp('^(?:async )?function ' + name + '\\([^]*?^\\}', 'm'))[0]).join('\n') + '\nreturn {' + names.join(',') + '};')(...Object.values(ports));
  return { api, state, $, opened };
}

test('cancelled code lookup cannot replace a newer session even when the network ignores abort', async () => {
  let finish;
  const f = joinFixture(() => new Promise(resolve => { finish = resolve; }));
  const old = f.api.joinWatchFromInput('ABCD');
  const controller = f.state.watchJoin.controller;
  assert.equal(f.$('watchJoinButton').disabled, true);
  f.api.cancelWatchJoin(); // startWatch and leaving the entry both invalidate the request.
  assert.equal(controller.signal.aborted, true);
  finish({ watchId: id, watchCode: 'ABCD' }); await old;
  assert.deepEqual(f.opened, []);
  assert.equal(f.$('watchJoinButton').disabled, false);
});

test('join prevents duplicate requests, shows errors in place and honors the rate limit cooldown', async () => {
  let reject, calls = 0;
  const f = joinFixture(() => { calls++; return new Promise((_, fail) => { reject = fail; }); });
  const pending = f.api.joinWatchFromInput('ABCD');
  await f.api.joinWatchFromInput('ABCD'); assert.equal(calls, 1);
  reject(Object.assign(new Error(), { code: 'rate-limited', retryAfterMs: 60000 })); await pending;
  assert.equal(f.state.watchJoin.error, 'rate-limited');
  assert.match(f.$('watchJoinHint').textContent, /请求过于频繁/);
  await f.api.joinWatchFromInput('EFGH'); assert.equal(calls, 1);
  assert.deepEqual(f.opened, []);
});

test('resolved code enters the existing watch flow and resets the join UI', async () => {
  const f = joinFixture(async () => ({ watchId: id, watchCode: 'ABCD' }));
  await f.api.joinWatchFromInput('abcd');
  assert.deepEqual(f.opened, [[id, { watchCode: 'ABCD' }]]);
  assert.equal(f.state.watchJoin.pending, false);
  assert.equal(f.state.watchJoin.controller, null);
  assert.equal(f.$('watchJoinButton').disabled, false);
});

test('leaving a watch session clears its code and copy confirmation before another session starts', () => {
  let stops = 0;
  const nodes = new Map();
  const state = { traceSelectionRevision: 1, watch: { active: true, code: 'ABCD', copiedUntil: 99999,
    client: { stop() { stops++; } }, trace: {}, timer: 7 } };
  const ports = { state, setPlaying() {}, clearInterval() {}, syncWakeLock() {},
    elements: { timeline: {}, appShell: { classList: { remove() {} } } },
    $: id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); } };
  const source = app.match(/^function stopWatch\([^]*?^\}/m)[0];
  new Function(...Object.keys(ports), source + '\nstopWatch();')(...Object.values(ports));
  assert.equal(stops, 1);
  assert.equal(state.watch.code, null);
  assert.equal(state.watch.copiedUntil, 0);
  assert.equal(state.watch.active, false);
  assert.equal(nodes.get('watchShare').hidden, true);
  assert.equal(nodes.get('watchShareLink').hidden, true);
});
