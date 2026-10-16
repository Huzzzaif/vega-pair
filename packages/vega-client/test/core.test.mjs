// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPairingConnection, withRole } from '../src/core.ts';

/** Manual clock: timers only fire when the test advances time. */
function fakeTimers() {
  let t = 0;
  let nextId = 1;
  const items = new Map();
  const timers = {
    now: () => t,
    setTimeout: (fn, ms) => (items.set(nextId, { fn, at: t + ms }), nextId++),
    setInterval: (fn, ms) => (items.set(nextId, { fn, at: t + ms, every: ms }), nextId++),
    clearTimeout: (id) => items.delete(id),
    clearInterval: (id) => items.delete(id),
  };
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      const due = [...items.entries()].filter(([, i]) => i.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, item] = due;
      t = item.at;
      if (item.every) item.at += item.every;
      else items.delete(id);
      item.fn();
    }
    t = end;
  };
  return { timers, advance, pending: () => items.size };
}

class FakeSocket {
  static instances = [];
  readyState = 0;
  sent = [];
  closed = false;
  constructor(url) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(d) {
    if (this.throwOnSend) throw new Error('boom');
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  // test helpers
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  recv(msg) {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) + '\n' });
  }
}

function setup(extra = {}) {
  FakeSocket.instances = [];
  const clock = fakeTimers();
  const states = [];
  const messages = [];
  const conn = createPairingConnection({
    url: 'ws://relay/ws',
    WebSocketImpl: FakeSocket,
    timers: clock.timers,
    onState: (s) => states.push(s),
    onMessage: (d, from) => messages.push([d, from]),
    ...extra,
  });
  conn.start();
  const ws = () => FakeSocket.instances.at(-1);
  return { conn, clock, states, messages, ws };
}

const SESSION = { type: 'session', code: 'ABCD', joinUrl: 'http://x/p/ABCD' };

test('connects as tv, says hello on open', () => {
  const { ws } = setup();
  assert.equal(ws().url, 'ws://relay/ws?role=tv');
  ws().open();
  assert.deepEqual(ws().sent, [{ type: 'hello' }]);
});

test('withRole appends with ? or & as needed', () => {
  assert.equal(withRole('ws://a/ws', 'tv'), 'ws://a/ws?role=tv');
  assert.equal(withRole('ws://a/ws?k=1', 'tv'), 'ws://a/ws?k=1&role=tv');
});

test('state: connecting -> waiting -> paired -> waiting', () => {
  const { conn, ws } = setup();
  assert.equal(conn.getState().status, 'connecting');
  ws().open();
  ws().recv(SESSION);
  assert.deepEqual(conn.getState(), { status: 'waiting', code: 'ABCD', joinUrl: 'http://x/p/ABCD' });
  ws().recv({ type: 'peer', event: 'joined', role: 'phone' });
  assert.equal(conn.getState().status, 'paired');
  ws().recv({ type: 'peer', event: 'joined', role: 'phone' });
  ws().recv({ type: 'peer', event: 'left', role: 'phone' });
  assert.equal(conn.getState().status, 'paired', 'one phone still connected');
  ws().recv({ type: 'peer', event: 'left', role: 'phone' });
  assert.equal(conn.getState().status, 'waiting');
});

test('phone messages reach onMessage; a split message is reassembled', () => {
  const { messages, ws } = setup();
  ws().open();
  const line = JSON.stringify({ type: 'message', from: 'phone', data: { kind: 'x', pad: 'y'.repeat(100) } }) + '\n';
  ws().recv(line.slice(0, 40));
  ws().recv(line.slice(40, 90));
  assert.equal(messages.length, 0);
  ws().recv(line.slice(90));
  assert.equal(messages.length, 1);
  assert.equal(messages[0][0].kind, 'x');
  assert.equal(messages[0][1], 'phone');
});

test('a malformed line does not break the connection', () => {
  const { conn, ws } = setup();
  ws().open();
  ws().recv('garbage\n');
  ws().recv(SESSION);
  assert.equal(conn.getState().status, 'waiting');
});

test('send wraps data and reports whether the socket was open', () => {
  const { conn, ws } = setup();
  assert.equal(conn.send({ a: 1 }), false);
  ws().open();
  assert.equal(conn.send({ a: 1 }), true);
  assert.deepEqual(ws().sent.at(-1), { type: 'send', data: { a: 1 } });
  ws().throwOnSend = true;
  assert.equal(conn.send(1), false);
});

test('heartbeat: pings every 45s', () => {
  const { clock, ws } = setup();
  ws().open();
  ws().recv(SESSION);
  clock.advance(45000);
  assert.deepEqual(ws().sent.map((m) => m.type), ['hello', 'ping']);
  ws().recv({ type: 'pong' });
  clock.advance(45000);
  assert.equal(ws().sent.filter((m) => m.type === 'ping').length, 2);
});

test('heartbeat: answered pings keep the link alive indefinitely', () => {
  const { conn, clock, ws } = setup();
  ws().open();
  ws().recv(SESSION);
  for (let i = 0; i < 40; i++) {
    clock.advance(45000);
    ws().recv({ type: 'pong' });
  }
  assert.equal(FakeSocket.instances.length, 1);
  assert.equal(conn.getState().status, 'waiting');
});

test('dead link: silence for two missed pongs drops the socket and reconnects with a fresh code', () => {
  const { conn, clock, states, ws } = setup();
  ws().open();
  ws().recv(SESSION);
  const first = ws();
  clock.advance(45000); // ping 1, silence
  clock.advance(45000); // ping 2, silence (90s < 95s)
  assert.equal(conn.getState().status, 'waiting', 'not dead yet');
  clock.advance(45000); // 135s heard nothing for > 95s: dead
  assert.equal(conn.getState().status, 'offline');
  assert.ok(first.closed, 'old socket closed');
  assert.equal(first.onclose, null, 'old handlers detached');
  assert.equal(FakeSocket.instances.length, 1, 'waits retryMs before reconnecting');
  clock.advance(2000);
  assert.equal(FakeSocket.instances.length, 2);
  ws().open();
  ws().recv({ ...SESSION, code: 'WXYZ' });
  assert.equal(conn.getState().code, 'WXYZ');
  assert.deepEqual(states.map((s) => s.status), ['connecting', 'waiting', 'offline', 'waiting']);
});

test('dead-link threshold is configurable', () => {
  const { conn, clock, ws } = setup({ pingMs: 1000, deadAfterMs: 2500 });
  ws().open();
  clock.advance(1000);
  clock.advance(1000);
  assert.notEqual(conn.getState().status, 'offline');
  clock.advance(1000); // 3000 > 2500
  assert.equal(conn.getState().status, 'offline');
});

test('any server message counts as proof of life, not just pong', () => {
  const { conn, clock, ws } = setup({ pingMs: 1000, deadAfterMs: 2500 });
  ws().open();
  for (let i = 0; i < 10; i++) {
    clock.advance(1000);
    ws().recv({ type: 'peer', event: 'joined', role: 'phone' });
  }
  assert.notEqual(conn.getState().status, 'offline');
});

test('onclose and onerror reconnect after retryMs', () => {
  const { conn, clock, ws } = setup();
  ws().open();
  ws().onclose();
  assert.equal(conn.getState().status, 'offline');
  clock.advance(2000);
  assert.equal(FakeSocket.instances.length, 2);
  ws().onerror();
  clock.advance(2000);
  assert.equal(FakeSocket.instances.length, 3);
});

test('close followed by error only schedules one reconnect', () => {
  const { clock, ws } = setup();
  ws().open();
  const s = ws();
  s.onclose();
  s.onerror?.(); // detached already
  clock.advance(10000);
  assert.equal(FakeSocket.instances.length, 2);
});

test('a throwing send during heartbeat reconnects', () => {
  const { conn, clock, ws } = setup();
  ws().open();
  ws().throwOnSend = true;
  clock.advance(45000);
  assert.equal(conn.getState().status, 'offline');
});

test('stop() closes the socket and cancels heartbeat and pending reconnects', () => {
  const { conn, clock, ws } = setup();
  ws().open();
  ws().onclose(); // schedules a retry
  conn.stop();
  clock.advance(100000);
  assert.equal(FakeSocket.instances.length, 1);
  assert.equal(clock.pending(), 0);

  const b = setup();
  b.ws().open();
  const s = b.ws();
  b.conn.stop();
  assert.ok(s.closed);
  b.clock.advance(100000);
  assert.equal(FakeSocket.instances.length, 1);
  assert.equal(b.clock.pending(), 0);
});

test('reconnect resets the phone count', () => {
  const { conn, clock, ws } = setup();
  ws().open();
  ws().recv(SESSION);
  ws().recv({ type: 'peer', event: 'joined', role: 'phone' });
  ws().onclose();
  clock.advance(2000);
  ws().open();
  ws().recv(SESSION);
  assert.equal(conn.getState().status, 'waiting');
  ws().recv({ type: 'peer', event: 'left', role: 'phone' });
  assert.equal(conn.getState().status, 'waiting');
});

test('a repeated session reply (hello answer) keeps the paired state', () => {
  const { conn, states, ws } = setup();
  ws().open();
  ws().recv(SESSION);
  ws().recv({ type: 'peer', event: 'joined', role: 'phone' });
  const before = states.length;
  ws().recv(SESSION);
  assert.equal(conn.getState().status, 'paired');
  assert.equal(states.length, before, 'no duplicate state emission');
});
