// SPDX-License-Identifier: Apache-2.0
export type PhoneState = 'connecting' | 'joined' | 'reconnecting' | 'rejected' | 'ended';

export interface ConnectPhoneOptions {
  /** Pairing server WebSocket URL, e.g. "wss://example.com/ws". `role=phone&code=` is appended. */
  url: string;
  /** The 4-letter code from the QR code / join URL. */
  code: string;
  /** Called with `data` of every message the TV (or server) sends. */
  onMessage?: (data: any, from: string) => void;
  onState?: (state: PhoneState, detail?: { code?: string; reason?: string; error?: string }) => void;
  /** Heartbeat interval in ms. Default 45000. */
  pingMs?: number;
  /** Reconnect delay in ms. Default 2000. */
  retryMs?: number;
  /** Override the WebSocket class (tests, Node < 22). */
  WebSocketImpl?: new (url: string) => any;
}

export interface PhoneConnection {
  send(data: unknown): boolean;
  close(): void;
  readonly state: PhoneState;
}

export function connectPhone(options: ConnectPhoneOptions): PhoneConnection;
export function codeFromPath(pathname?: string): string | undefined;
