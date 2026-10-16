// SPDX-License-Identifier: Apache-2.0
import WebSocket from 'ws';

/** Start a server on a free port. */
export async function start(createPairingServer, opts = {}) {
  const pairing = createPairingServer({ port: 0, publicUrl: 'http://tv.test', heartbeatMs: 0, ...opts });
  await pairing.ready;
  return pairing;
}

/** A ws client whose messages can be awaited by type. Keeps raw frames in `raw`. */
export function connect(port, query) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${query}`);
  const inbox = [];
  const waiters = [];
  ws.raw = [];
  ws.on('message', (data) => {
    const text = String(data);
    ws.raw.push(text);
    const msg = JSON.parse(text);
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  ws.next = (type, ms = 2000) => {
    const i = inbox.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for "${type}"`)), ms);
      waiters.push({ type, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  };
  ws.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  ws.sendJson = (obj) => ws.send(JSON.stringify(obj));
  return ws;
}
