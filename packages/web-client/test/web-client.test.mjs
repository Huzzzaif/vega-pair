// SPDX-License-Identifier: Apache-2.0
// The browser client against the real server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createPairingServer } from '@vega-pair/server';
import { connectPhone, codeFromPath } from '../src/index.js';

let pairing;
before(async () => {
  pairing = createPairingServer({ port: 0, publicUrl: 'http://tv.test', heartbeatMs: 0 });
  await pairing.ready;
});
after(() => pairing.close());

const wsUrl = () => `ws://127.0.0.1:${pairing.port}/ws`;

function tv() {
  const ws = new WebSocket(`${wsUrl()}?role=tv`);
  const msgs = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else msgs.push(m);
  });
  ws.next = (pred) => {
    const i = msgs.findIndex(pred);
    if (i >= 0) return Promise.resolve(msgs.splice(i, 1)[0]);
    return new Promise((resolve) => waiters.push({ pred, resolve }));
  };
  return ws;
}

function phone(code, extra = {}) {
  const states = [];
  const messages = [];
  const waiting = [];
  const check = () => waiting.splice(0).forEach((w) => w());
  const conn = connectPhone({
    url: wsUrl(),
    code,
    WebSocketImpl: WebSocket,
    retryMs: 20,
    onState: (s, d) => (states.push([s, d]), check()),
    onMessage: (d, from) => (messages.push([d, from]), check()),
    ...extra,
  });
  conn.states = states;
  conn.messages = messages;
  conn.until = (pred, ms = 2000) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      const run = () => (pred() ? (clearTimeout(t), resolve()) : waiting.push(run));
      run();
    });
  return conn;
}

test('joins a TV by code and exchanges messages both ways', async () => {
  const t = tv();
  const { code } = await t.next((m) => m.type === 'session');
  const p = phone(code);
  await p.until(() => p.state === 'joined');
  assert.deepEqual(p.states[0], ['joined', { code }]);

  assert.equal(p.send({ kind: 'tap', x: 1 }), true);
  const got = await t.next((m) => m.type === 'message');
  assert.deepEqual(got, { type: 'message', from: 'phone', data: { kind: 'tap', x: 1 } });

  t.send(JSON.stringify({ type: 'send', data: { kind: 'hello-phone' } }));
  await p.until(() => p.messages.length === 1);
  assert.deepEqual(p.messages[0], [{ kind: 'hello-phone' }, 'tv']);
  p.close();
  t.close();
});

test('the TV sees the phone join and leave', async () => {
  const t = tv();
  const { code } = await t.next((m) => m.type === 'session');
  const p = phone(code);
  assert.equal((await t.next((m) => m.type === 'peer')).event, 'joined');
  p.close();
  assert.equal((await t.next((m) => m.type === 'peer')).event, 'left');
  t.close();
});

test('an unknown code ends in "rejected"', async () => {
  const p = phone('QQQQ');
  await p.until(() => p.state === 'rejected');
  assert.equal(p.send(1), false);
});

test('the TV leaving ends the session ("ended"), without reconnecting', async () => {
  const t = tv();
  const { code } = await t.next((m) => m.type === 'session');
  const p = phone(code);
  await p.until(() => p.state === 'joined');
  t.close();
  await p.until(() => p.state === 'ended');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(pairing.sessionCodes().includes(code), false);
  assert.ok(!p.states.some(([s]) => s === 'reconnecting'));
});

test('a dropped connection reconnects and rejoins while the TV is still there', async () => {
  const own = createPairingServer({ port: 0, heartbeatMs: 0 });
  await own.ready;
  const t = new WebSocket(`ws://127.0.0.1:${own.port}/ws?role=tv`);
  const { code } = await new Promise((resolve) => t.once('message', (d) => resolve(JSON.parse(d))));
  const p = phone(code, { url: `ws://127.0.0.1:${own.port}/ws` });
  await p.until(() => p.state === 'joined');
  const [, phoneSocket] = [...own.wss.clients]; // the TV connected first
  phoneSocket.terminate();
  await p.until(() => p.states.some(([s]) => s === 'reconnecting'));
  await p.until(() => p.states.filter(([s]) => s === 'joined').length === 2);
  assert.equal(p.send('again'), true);
  p.close();
  t.close();
  await own.close();
});

test('sends a heartbeat ping the server answers (link stays up)', async () => {
  const t = tv();
  const { code } = await t.next((m) => m.type === 'session');
  const frames = [];
  class Spy extends WebSocket {
    constructor(u) {
      super(u);
      this.on('message', (d) => frames.push(JSON.parse(d)));
    }
  }
  const p = phone(code, { pingMs: 30, WebSocketImpl: Spy });
  await p.until(() => p.state === 'joined');
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(frames.filter((f) => f.type === 'pong').length >= 2);
  assert.equal(p.state, 'joined');
  p.close();
  t.close();
});

test('codeFromPath extracts and upper-cases the code', () => {
  assert.equal(codeFromPath('/p/abcd'), 'ABCD');
  assert.equal(codeFromPath('/p/WXYZ/'), 'WXYZ');
  assert.equal(codeFromPath('/'), undefined);
});
