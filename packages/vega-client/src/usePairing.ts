// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 vega-pair contributors

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPairingConnection, type PairingConnection, type PairingState } from './core.ts';

export type UsePairingOptions = {
  /** WebSocket URL of the pairing server, e.g. "ws://192.168.1.20:8787/ws". */
  url: string;
  /** Called with `data` of every message a phone sends. */
  onMessage?: (data: any, from: string) => void;
};

export type UsePairingResult = {
  /** connecting -> waiting (show the QR) -> paired (a phone is connected); offline while reconnecting. */
  state: PairingState;
  /** The 4-letter code, once known. */
  code: string | undefined;
  /** URL to encode in the QR code, once known. */
  joinUrl: string | undefined;
  /** Send `data` to all phones. Returns false when not connected. */
  send: (data: unknown) => boolean;
};

export function usePairing({ url, onMessage }: UsePairingOptions): UsePairingResult {
  const [state, setState] = useState<PairingState>({ status: 'connecting' });
  const conn = useRef<PairingConnection | null>(null);
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    const c = createPairingConnection({
      url,
      onState: setState,
      onMessage: (data, from) => handler.current?.(data, from),
    });
    conn.current = c;
    c.start();
    return () => {
      c.stop();
      conn.current = null;
    };
  }, [url]);

  const send = useCallback((data: unknown) => conn.current?.send(data) ?? false, []);

  const hasCode = state.status === 'waiting' || state.status === 'paired';
  return {
    state,
    code: hasCode ? state.code : undefined,
    joinUrl: hasCode ? state.joinUrl : undefined,
    send,
  };
}
