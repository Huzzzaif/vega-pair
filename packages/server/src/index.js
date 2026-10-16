// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 vega-pair contributors
//
// A tiny pairing relay. A TV app connects with ?role=tv and gets a short code;
// phones connect with ?role=phone&code=XXXX and the server forwards JSON
// messages between them. See PROTOCOL.md for every message.

import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';

/** No 0/O, 1/I/L, 2/Z, 5/S, 8/B: codes are read off a TV across the room. */
export const CODE_ALPHABET = 'ACDEFHJKMNPRTUVWXY3479';
export const CLOSE_TV_LEFT = 4001;
export const CLOSE_UNKNOWN_SESSION = 4004;

export function lanAddress() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return 'localhost';
}

/**
 * @param {import('./index.d.ts').PairingServerOptions} [options]
 * @returns {import('./index.d.ts').PairingServer}
 */
export function createPairingServer(options = {}) {
  const {
    path = '/ws',
    joinPath = '/p',
    maxPayload = 64 * 1024,
    heartbeatMs = 15000,
    log = () => {},
  } = options;

  const events = new EventEmitter();
  /** @type {Map<string, { tv: any, phones: Set<any> }>} */
  const sessions = new Map();

  const ownsServer = !options.server;
  const server =
    options.server ??
    createServer((req, res) => {
      if (req.url === '/health') return void res.writeHead(200).end('ok');
      res.writeHead(404).end('not found');
    });

  const publicUrl = () => {
    if (options.publicUrl) return options.publicUrl.replace(/\/$/, '');
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : (options.port ?? 8787);
    return `http://${lanAddress()}:${port}`;
  };
  const joinUrl = (code) => `${publicUrl()}${joinPath}/${code}`;

  const emit = (name, payload) => {
    try {
      events.emit(name, payload);
    } catch (err) {
      console.error(`vega-pair: "${name}" listener threw`, err);
    }
  };

  function newCode() {
    for (;;) {
      const code = [...randomBytes(4)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
      if (!sessions.has(code)) return code;
    }
  }

  // Every message ends with a newline: Vega's WebSocket can hand one message
  // to the app in several pieces, so the TV buffers until '\n'. Browsers
  // ignore the trailing whitespace when parsing.
  function send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(`${JSON.stringify(msg)}\n`);
  }

  function broadcast(code, msg, except) {
    const s = sessions.get(code);
    if (!s) return;
    for (const peer of [s.tv, ...s.phones]) if (peer !== except) send(peer, msg);
  }

  const wss = new WebSocketServer({ server, path, maxPayload });

  wss.on('connection', (ws, req) => {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const role = params.get('role') === 'tv' ? 'tv' : 'phone';
    let code;

    if (role === 'tv') {
      code = newCode();
      sessions.set(code, { tv: ws, phones: new Set() });
      send(ws, { type: 'session', code, joinUrl: joinUrl(code) });
      emit('session', { code, joinUrl: joinUrl(code) });
    } else {
      code = (params.get('code') ?? '').toUpperCase();
      const session = sessions.get(code);
      if (!session) {
        send(ws, { type: 'error', message: 'No TV is waiting with that code.' });
        return ws.close(CLOSE_UNKNOWN_SESSION, 'unknown session');
      }
      session.phones.add(ws);
      send(ws, { type: 'joined', code });
      broadcast(code, { type: 'peer', event: 'joined', role }, ws);
      emit('join', { code, phones: session.phones.size });
    }
    log(`[${code}] ${role} connected`);

    // Oversized frames and protocol errors surface as 'error' (then 'close');
    // without a listener they would crash the process.
    ws.on('error', (err) => log(`[${code}] ${role} error: ${err.message}`));
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return send(ws, { type: 'error', message: 'Messages must be JSON.' });
      }
      if (msg?.type === 'ping') return send(ws, { type: 'pong' });
      if (msg?.type === 'hello') {
        // Idempotent here; the AWS relay can only answer after the handshake,
        // so clients always say hello.
        if (role === 'tv') send(ws, { type: 'session', code, joinUrl: joinUrl(code) });
        else send(ws, { type: 'joined', code });
        return;
      }
      if (msg?.type !== 'send') return;
      broadcast(code, { type: 'message', from: role, data: msg.data }, ws);
      emit('message', { code, from: role, data: msg.data });
    });

    ws.on('close', () => {
      const session = sessions.get(code);
      if (!session) return;
      if (role === 'tv') {
        // The TV owns the session; phones can't do anything without it.
        sessions.delete(code);
        for (const phone of session.phones) phone.close(CLOSE_TV_LEFT, 'tv left');
        emit('end', { code });
      } else if (session.phones.delete(ws)) {
        broadcast(code, { type: 'peer', event: 'left', role });
        emit('leave', { code, role, phones: session.phones.size });
      }
      log(`[${code}] ${role} disconnected`);
    });
  });

  // Drop connections that stopped answering (phone screen locked, Wi-Fi switch).
  const sweep =
    heartbeatMs > 0
      ? setInterval(() => {
          for (const ws of wss.clients) {
            if (!ws.isAlive) {
              ws.terminate();
              continue;
            }
            ws.isAlive = false;
            ws.ping();
          }
        }, heartbeatMs)
      : undefined;
  sweep?.unref();

  const ready = ownsServer
    ? new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 8787, () => resolve());
      })
    : Promise.resolve();

  return {
    server,
    wss,
    ready,
    on: (name, fn) => (events.on(name, fn), undefined),
    off: (name, fn) => (events.off(name, fn), undefined),
    get port() {
      const addr = server.address();
      return addr && typeof addr === 'object' ? addr.port : undefined;
    },
    get publicUrl() {
      return publicUrl();
    },
    sessionCodes: () => [...sessions.keys()],
    sendToSession(code, data) {
      broadcast(code, { type: 'message', from: 'server', data });
      return sessions.has(code);
    },
    async close() {
      if (sweep) clearInterval(sweep);
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => wss.close(() => resolve()));
      if (ownsServer) await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
