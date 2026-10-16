// SPDX-License-Identifier: Apache-2.0
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createPairingServer, CODE_ALPHABET } from '../src/index.js';
import { start, connect } from './helpers.mjs';

let pairing;
const events = [];
before(async () => {
  pairing = await start(createPairingServer);
  for (const name of ['session', 'join', 'leave', 'message', 'end']) pairing.on(name, (e) => events.push([name, e]));
});
after(() => pairing.close());

async function pair() {
  const tv = connect(pairing.port, 'role=tv');
  const { code } = await tv.next('session');
  const phone = connect(pairing.port, `role=phone&code=${code}`);
  await phone.next('joined');
  return { tv, phone, code };
}

test('TV gets a 4-letter code from the unambiguous alphabet and a join URL', async () => {
  const tv = connect(pairing.port, 'role=tv');
  const msg = await tv.next('session');
  assert.match(msg.code, new RegExp(`^[${CODE_ALPHABET}]{4}$`));
  assert.equal(msg.joinUrl, `http://tv.test/p/${msg.code}`);
  tv.close();
});

test('codes are unique across concurrent sessions', async () => {
  const tvs = Array.from({ length: 30 }, () => connect(pairing.port, 'role=tv'));
  const codes = await Promise.all(tvs.map(async (t) => (await t.next('session')).code));
  assert.equal(new Set(codes).size, 30);
  tvs.forEach((t) => t.close());
});

test('phone joins with a valid code (case-insensitive) and the TV is told', async () => {
  const tv = connect(pairing.port, 'role=tv');
  const { code } = await tv.next('session');
  const phone = connect(pairing.port, `role=phone&code=${code.toLowerCase()}`);
  assert.deepEqual(await phone.next('joined'), { type: 'joined', code });
  assert.deepEqual(await tv.next('peer'), { type: 'peer', event: 'joined', role: 'phone' });
  tv.close();
});

test('unknown code is rejected with an error and close code 4004', async () => {
  const phone = connect(pairing.port, 'role=phone&code=QQQQ');
  assert.match((await phone.next('error')).message, /No TV/);
  assert.equal(await phone.closed, 4004);
});

test('missing code is rejected too', async () => {
  const phone = connect(pairing.port, 'role=phone');
  assert.equal(await phone.closed, 4004);
});

test('messages relay both ways, tagged with the sender role', async () => {
  const { tv, phone } = await pair();
  phone.sendJson({ type: 'send', data: { kind: 'hi', n: 1 } });
  assert.deepEqual(await tv.next('message'), { type: 'message', from: 'phone', data: { kind: 'hi', n: 1 } });
  tv.sendJson({ type: 'send', data: 'yo' });
  assert.deepEqual(await phone.next('message'), { type: 'message', from: 'tv', data: 'yo' });
  tv.close();
});

test('a sender does not receive its own message; other phones do', async () => {
  const { tv, phone, code } = await pair();
  const phone2 = connect(pairing.port, `role=phone&code=${code}`);
  await phone2.next('joined');
  phone.sendJson({ type: 'send', data: 'x' });
  assert.equal((await phone2.next('message')).data, 'x');
  assert.equal((await tv.next('message')).data, 'x');
  assert.equal(phone.raw.filter((r) => r.includes('"message"')).length, 0);
  tv.close();
});

test('peer left is broadcast when a phone disconnects', async () => {
  const { tv, phone } = await pair();
  await tv.next('peer'); // joined
  phone.close();
  assert.deepEqual(await tv.next('peer'), { type: 'peer', event: 'left', role: 'phone' });
  tv.close();
});

test('ping is answered with pong', async () => {
  const { tv, phone } = await pair();
  phone.sendJson({ type: 'ping' });
  assert.deepEqual(await phone.next('pong'), { type: 'pong' });
  tv.sendJson({ type: 'ping' });
  assert.deepEqual(await tv.next('pong'), { type: 'pong' });
  tv.close();
});

test('hello re-sends session / joined (idempotent handshake)', async () => {
  const { tv, phone, code } = await pair();
  tv.sendJson({ type: 'hello' });
  assert.equal((await tv.next('session')).code, code);
  phone.sendJson({ type: 'hello' });
  assert.equal((await phone.next('joined')).code, code);
  tv.close();
});

test('every frame ends with a newline (framing for Vega) and is valid JSON', async () => {
  const { tv, phone } = await pair();
  phone.sendJson({ type: 'send', data: { big: 'x'.repeat(5000) } });
  await tv.next('message');
  for (const frame of [...tv.raw, ...phone.raw]) {
    assert.ok(frame.endsWith('\n'), 'frame ends with newline');
    assert.equal(frame.indexOf('\n'), frame.length - 1, 'only one newline, at the end');
    JSON.parse(frame);
  }
  tv.close();
});

test('non-JSON input gets an error but keeps the connection', async () => {
  const { tv, phone } = await pair();
  phone.send('not json');
  assert.match((await phone.next('error')).message, /JSON/);
  phone.sendJson({ type: 'ping' });
  await phone.next('pong');
  tv.close();
});

test('unknown message types are ignored', async () => {
  const { tv, phone } = await pair();
  phone.sendJson({ type: 'bogus' });
  phone.sendJson({ type: 'ping' });
  await phone.next('pong');
  tv.close();
});

test('TV leaving closes its phones with 4001 and frees the code', async () => {
  const { tv, phone, code } = await pair();
  tv.close();
  assert.equal(await phone.closed, 4001);
  const late = connect(pairing.port, `role=phone&code=${code}`);
  assert.equal(await late.closed, 4004);
  assert.ok(!pairing.sessionCodes().includes(code));
});

test('oversized messages are dropped by closing the sender (maxPayload)', async () => {
  const small = await start(createPairingServer, { maxPayload: 100 });
  const tv = connect(small.port, 'role=tv');
  await tv.next('session');
  tv.on('error', () => {});
  tv.send(JSON.stringify({ type: 'send', data: 'x'.repeat(500) }));
  assert.equal(await tv.closed, 1009);
  await small.close();
});

test('events: session, join, message, leave, end', async () => {
  events.length = 0;
  const { tv, phone, code } = await pair();
  phone.sendJson({ type: 'send', data: { a: 1 } });
  await tv.next('message');
  phone.close();
  await tv.next('peer');
  await tv.next('peer');
  tv.close();
  await tv.closed;
  await new Promise((r) => setTimeout(r, 50));
  const mine = events.filter(([, e]) => e.code === code).map(([n]) => n);
  assert.deepEqual(mine, ['session', 'join', 'message', 'leave', 'end']);
  const msgEvent = events.find(([n, e]) => n === 'message' && e.code === code)[1];
  assert.deepEqual(msgEvent, { code, from: 'phone', data: { a: 1 } });
});

test('sendToSession pushes a message from "server" to everyone', async () => {
  const { tv, phone, code } = await pair();
  assert.equal(pairing.sendToSession(code, { kind: 'beat' }), true);
  assert.deepEqual(await tv.next('message'), { type: 'message', from: 'server', data: { kind: 'beat' } });
  assert.equal((await phone.next('message')).from, 'server');
  assert.equal(pairing.sendToSession('NOPE', 1), false);
  tv.close();
});

test('a throwing listener does not break the relay', async () => {
  const p = await start(createPairingServer);
  const orig = console.error;
  console.error = () => {};
  p.on('message', () => {
    throw new Error('boom');
  });
  const tv = connect(p.port, 'role=tv');
  const { code } = await tv.next('session');
  const phone = connect(p.port, `role=phone&code=${code}`);
  await phone.next('joined');
  phone.sendJson({ type: 'send', data: 1 });
  assert.equal((await tv.next('message')).data, 1);
  console.error = orig;
  await p.close();
});

test('attaches to an existing http server and honours joinPath / publicUrl', async () => {
  const http = createServer((req, res) => res.writeHead(200).end('mine'));
  http.listen(0);
  await once(http, 'listening');
  const p = createPairingServer({ server: http, publicUrl: 'https://x.example/', joinPath: '/join', heartbeatMs: 0 });
  await p.ready;
  const tv = connect(http.address().port, 'role=tv');
  const { joinUrl, code } = await tv.next('session');
  assert.equal(joinUrl, `https://x.example/join/${code}`);
  const res = await fetch(`http://127.0.0.1:${http.address().port}/`);
  assert.equal(await res.text(), 'mine');
  await p.close();
  http.close();
});

test('built-in server answers /health', async () => {
  const res = await fetch(`http://127.0.0.1:${pairing.port}/health`);
  assert.equal(res.status, 200);
});
