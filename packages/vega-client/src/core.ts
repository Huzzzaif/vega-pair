// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 vega-pair contributors
//
// Framework-free pairing connection: owns the WebSocket, the line buffer, the
// hello handshake, the heartbeat and reconnects. Everything environmental
// (WebSocket class, timers, clock) is injectable so the dead-link logic can be
// tested without waiting 90 seconds.

import { createLineBuffer } from './lineBuffer.ts';

export type PairingState =
  | { status: 'connecting' }
  | { status: 'waiting'; code: string; joinUrl: string }
  | { status: 'paired'; code: string; joinUrl: string }
  | { status: 'offline' };

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  now(): number;
}

/** The subset of the WebSocket API we use (Vega, browsers and `ws` all fit). */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev?: any) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: any) => void) | null;
  onerror: ((ev?: any) => void) | null;
}

export interface PairingConnectionOptions {
  /** WebSocket URL of the pairing server, e.g. "ws://192.168.1.20:8787/ws". `role=tv` is appended. */
  url: string;
  /** Called for every `{type:'message'}` from a phone (or the server). */
  onMessage?: (data: any, from: string) => void;
  onState?: (state: PairingState) => void;
  /** Heartbeat interval. Default 45 000 ms: well inside API Gateway's 10 minute idle timeout. */
  pingMs?: number;
  /** Consider the link dead when nothing was heard for this long. Default 2 * pingMs + 5000. */
  deadAfterMs?: number;
  /** Delay before reconnecting. Default 2000 ms. */
  retryMs?: number;
  WebSocketImpl?: new (url: string) => SocketLike;
  timers?: Timers;
}

export interface PairingConnection {
  start(): void;
  stop(): void;
  /** Send `data` to the phones. Returns false if the socket is not open. */
  send(data: unknown): boolean;
  getState(): PairingState;
}

const OPEN = 1;

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as any),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as any),
  now: () => Date.now(),
};

export function withRole(url: string, role: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}role=${role}`;
}

export function createPairingConnection(opts: PairingConnectionOptions): PairingConnection {
  const pingMs = opts.pingMs ?? 45000;
  const deadAfterMs = opts.deadAfterMs ?? pingMs * 2 + 5000;
  const retryMs = opts.retryMs ?? 2000;
  const timers = opts.timers ?? realTimers;
  const WS = opts.WebSocketImpl ?? ((globalThis as any).WebSocket as new (url: string) => SocketLike);

  let state: PairingState = { status: 'connecting' };
  let socket: SocketLike | null = null;
  let stopped = true;
  let retry: unknown;
  let heartbeat: unknown;
  let phones = 0;

  const setState = (next: PairingState) => {
    state = next;
    opts.onState?.(next);
  };

  const open = () => {
    if (stopped) return;
    const ws = new WS(withRole(opts.url, 'tv'));
    socket = ws;
    const lines = createLineBuffer();
    let lastHeard = timers.now();
    let reconnecting = false;

    // Drop this socket and start over with a fresh one (and a fresh code).
    const reconnect = () => {
      if (reconnecting || stopped) return;
      reconnecting = true;
      timers.clearInterval(heartbeat);
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {}
      if (socket === ws) socket = null;
      phones = 0;
      setState({ status: 'offline' });
      timers.clearTimeout(retry);
      retry = timers.setTimeout(open, retryMs);
    };

    const handle = (msg: any) => {
      if (!msg || msg.type === 'pong') return;
      if (msg.type === 'session') {
        // The server answers hello with the same session again; that must not
        // forget a phone that joined in between.
        if ((state.status === 'waiting' || state.status === 'paired') && state.code === msg.code) return;
        phones = 0;
        setState({ status: 'waiting', code: msg.code, joinUrl: msg.joinUrl });
      } else if (msg.type === 'peer') {
        phones = Math.max(0, phones + (msg.event === 'joined' ? 1 : -1));
        if (state.status === 'waiting' || state.status === 'paired') {
          setState({ ...state, status: phones > 0 ? 'paired' : 'waiting' });
        }
      } else if (msg.type === 'message') {
        opts.onMessage?.(msg.data, msg.from);
      }
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello' }));
      timers.clearInterval(heartbeat);
      // Vega's WebSocket doesn't always fire onclose when the server drops the
      // connection, so silence is the only signal we get.
      heartbeat = timers.setInterval(() => {
        if (timers.now() - lastHeard > deadAfterMs) return reconnect();
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          reconnect();
        }
      }, pingMs);
    };

    ws.onmessage = (event) => {
      lastHeard = timers.now();
      for (const line of lines.push(String(event.data))) {
        try {
          handle(JSON.parse(line));
        } catch {
          // A malformed line must not take the connection down.
        }
      }
    };

    ws.onclose = reconnect;
    ws.onerror = reconnect;
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      setState({ status: 'connecting' });
      open();
    },
    stop() {
      stopped = true;
      timers.clearTimeout(retry);
      timers.clearInterval(heartbeat);
      const ws = socket;
      socket = null;
      if (ws) {
        ws.onclose = ws.onmessage = ws.onerror = null;
        try {
          ws.close();
        } catch {}
      }
    },
    send(data) {
      if (socket?.readyState !== OPEN) return false;
      try {
        socket.send(JSON.stringify({ type: 'send', data }));
        return true;
      } catch {
        return false;
      }
    },
    getState: () => state,
  };
}
