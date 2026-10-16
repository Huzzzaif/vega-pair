// SPDX-License-Identifier: Apache-2.0
import type { Server } from 'node:http';
import type { WebSocketServer } from 'ws';

export const CODE_ALPHABET: string;
export const CLOSE_TV_LEFT: 4001;
export const CLOSE_UNKNOWN_SESSION: 4004;
export function lanAddress(): string;

export interface PairingServerOptions {
  /** Attach to an existing HTTP server (you serve your own pages). Otherwise one is created and listened on `port`. */
  server?: Server;
  /** Port for the server we create. Default 8787; 0 picks a free port. */
  port?: number;
  /** Base URL phones can reach, used in `joinUrl`. Default: http://<LAN ip>:<port>. */
  publicUrl?: string;
  /** Path prefix of the phone page; the QR code encodes `${publicUrl}${joinPath}/${code}`. Default "/p". */
  joinPath?: string;
  /** WebSocket path. Default "/ws". */
  path?: string;
  /** Max message size in bytes. Default 65536. */
  maxPayload?: number;
  /** Interval of the server's WebSocket ping sweep; 0 disables. Default 15000. */
  heartbeatMs?: number;
  log?: (line: string) => void;
}

export interface PairingEvents {
  session: { code: string; joinUrl: string };
  join: { code: string; phones: number };
  leave: { code: string; role: 'phone'; phones: number };
  message: { code: string; from: 'tv' | 'phone'; data: unknown };
  end: { code: string };
}

export interface PairingServer {
  server: Server;
  wss: WebSocketServer;
  /** Resolves once the server we created is listening. */
  ready: Promise<void>;
  readonly port: number | undefined;
  readonly publicUrl: string;
  on<K extends keyof PairingEvents>(name: K, fn: (e: PairingEvents[K]) => void): void;
  off<K extends keyof PairingEvents>(name: K, fn: (e: PairingEvents[K]) => void): void;
  sessionCodes(): string[];
  /** Push `data` to everyone in a session as a message from "server". Returns false if no such session. */
  sendToSession(code: string, data: unknown): boolean;
  close(): Promise<void>;
}

export function createPairingServer(options?: PairingServerOptions): PairingServer;
