// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPairingHandler, CODE_ALPHABET } from '../src/core.js';

function fakeAws() {
  const sessions = new Map(); // code -> tv id
  const conns = new Map(); // id -> {code, role}
  const inbox = new Map(); // id -> messages
  const dropped = [];
  const alive = (id) => inbox.has(id);
  const store = {
    claimSession: async (code, tv) => (sessions.has(code) ? false : (sessions.set(code, tv), true)),
    sessionExists: async (code) => sessions.has(code),
    addConnection: async (id, code, role) => void conns.set(id, { code, role }),
    getConnection: async (id) => conns.get(id) ?? null,
    sessionConnections: async (code) => [...conns].filter(([, c]) => c.code === code).map(([id, c]) => ({ id, role: c.role })),
    removeConnection: async (_code, id) => void conns.delete(id),
    deleteSession: async (code) => void sessions.delete(code),
  };
  const gateway = {
    post: async (id, msg) => (alive(id) ? (inbox.get(id).push(msg), true) : false),
    disconnect: async (id) => void dropped.push(id),
  };
  return { store, gateway, sessions, conns, inbox, dropped };
}

const ev = (routeKey, connectionId, extra = {}) => ({ requestContext: { routeKey, connectionId }, ...extra });

function setup(opts = {}) {
  const aws = fakeAws();
  const handler = createPairingHandler({
    ...aws,
    publicUrl: 'https://pair.example/',
    ...opts,
  });
  const connect = async (id, query) => {
    aws.inbox.set(id, []);
    return handler(ev('$connect', id, { queryStringParameters: query }));
  };
  const say = (id, obj) => handler(ev('$default', id, { body: typeof obj === 'string' ? obj : JSON.stringify(obj) }));
  return { ...aws, handler, connect, say };
}

test('TV connect claims a session; reply comes on hello (not during $connect)', async () => {
  const t = setup({ newCode: () => 'ABCD' });
  assert.deepEqual(await t.connect('tv1', { role: 'tv' }), { statusCode: 200 });
  assert.deepEqual(t.inbox.get('tv1'), []);
  await t.say('tv1', { type: 'hello' });
  assert.deepEqual(t.inbox.get('tv1'), [{ type: 'session', code: 'ABCD', joinUrl: 'https://pair.example/p/ABCD' }]);
});

test('code collisions are retried; exhausted retries give 503', async () => {
  const codes = ['AAAA', 'AAAA', 'BBBB'];
  const t = setup({ newCode: () => codes.shift() ?? 'AAAA' });
  await t.connect('tv1', { role: 'tv' });
  await t.connect('tv2', { role: 'tv' });
  assert.equal(t.conns.get('tv2').code, 'BBBB');
  assert.equal((await t.connect('tv3', { role: 'tv' })).statusCode, 503);
});

test('generated codes use the unambiguous alphabet', async () => {
  const t = setup({ newCode: undefined });
  await t.connect('tv1', { role: 'tv' });
  assert.match(t.conns.get('tv1').code, new RegExp(`^[${CODE_ALPHABET}]{4}$`));
});

test('unknown code is refused with 403 at $connect', async () => {
  const t = setup();
  assert.equal((await t.connect('p1', { role: 'phone', code: 'ZZZZ' })).statusCode, 403);
  assert.equal((await t.connect('p2', { role: 'phone' })).statusCode, 403);
});

async function paired() {
  const t = setup({ newCode: () => 'ABCD' });
  await t.connect('tv', { role: 'tv' });
  await t.say('tv', { type: 'hello' });
  await t.connect('ph', { role: 'phone', code: 'abcd' });
  await t.say('ph', { type: 'hello' });
  return t;
}

test('phone hello gets joined and the TV gets peer joined', async () => {
  const t = await paired();
  assert.deepEqual(t.inbox.get('ph'), [{ type: 'joined', code: 'ABCD' }]);
  assert.deepEqual(t.inbox.get('tv').at(-1), { type: 'peer', event: 'joined', role: 'phone' });
});

test('send relays to the others with the sender role; ping answers pong', async () => {
  const t = await paired();
  await t.say('ph', { type: 'send', data: { a: 1 } });
  assert.deepEqual(t.inbox.get('tv').at(-1), { type: 'message', from: 'phone', data: { a: 1 } });
  await t.say('tv', { type: 'send', data: 'x' });
  assert.deepEqual(t.inbox.get('ph').at(-1), { type: 'message', from: 'tv', data: 'x' });
  await t.say('ph', { type: 'ping' });
  assert.deepEqual(t.inbox.get('ph').at(-1), { type: 'pong' });
});

test('invalid JSON gets an error; unknown connection gets 410', async () => {
  const t = await paired();
  assert.equal((await t.say('ph', 'nope')).statusCode, 400);
  assert.equal(t.inbox.get('ph').at(-1).type, 'error');
  assert.equal((await t.say('ghost', { type: 'ping' })).statusCode, 410);
});

test('phone disconnect broadcasts peer left', async () => {
  const t = await paired();
  await t.handler(ev('$disconnect', 'ph'));
  assert.deepEqual(t.inbox.get('tv').at(-1), { type: 'peer', event: 'left', role: 'phone' });
});

test('TV disconnect tells phones "closed", drops them and deletes the session', async () => {
  const t = await paired();
  await t.handler(ev('$disconnect', 'tv'));
  assert.deepEqual(t.inbox.get('ph').at(-1), { type: 'closed', reason: 'tv left' });
  assert.deepEqual(t.dropped, ['ph']);
  assert.equal(t.sessions.has('ABCD'), false);
  assert.equal((await t.connect('late', { role: 'phone', code: 'ABCD' })).statusCode, 403);
});

test('stale (gone) connections are forgotten on broadcast', async () => {
  const t = await paired();
  t.inbox.delete('ph'); // the gateway says 410 for it from now on
  await t.say('tv', { type: 'send', data: 1 });
  assert.equal(t.conns.has('ph'), false);
});

test('onMessage hook receives relayed messages and can push server messages', async () => {
  const seen = [];
  const t = setup({
    newCode: () => 'ABCD',
    onMessage: async ({ code, from, data, post }) => {
      seen.push([code, from, data]);
      await post({ kind: 'ack' });
    },
  });
  await t.connect('tv', { role: 'tv' });
  await t.connect('ph', { role: 'phone', code: 'ABCD' });
  await t.say('ph', { type: 'send', data: 7 });
  assert.deepEqual(seen, [['ABCD', 'phone', 7]]);
  assert.deepEqual(t.inbox.get('tv').at(-1), { type: 'message', from: 'server', data: { kind: 'ack' } });
});
