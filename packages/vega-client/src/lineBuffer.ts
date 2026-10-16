// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 vega-pair contributors

export interface LineBuffer {
  /** Feed one onmessage payload; get back every complete, non-empty line. */
  push(chunk: string): string[];
  /** Drop any partial line (call after a reconnect). */
  reset(): void;
}

/**
 * Reassembles newline-framed messages.
 *
 * Vega's WebSocket can deliver one large message across several `onmessage`
 * calls (see "Why" in the README), and a chunk can in principle also hold
 * several messages. The server ends every message with "\n", so we buffer
 * until a newline and only hand out complete lines.
 */
export function createLineBuffer(): LineBuffer {
  let pending = '';
  return {
    push(chunk) {
      pending += chunk;
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      return parts.filter((p) => p.trim().length > 0);
    },
    reset() {
      pending = '';
    },
  };
}
