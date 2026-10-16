// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 vega-pair contributors
//
// Phone-side client. Zero dependencies, runs in any browser (or Node 22+).

const OPEN = 1;
const MAX_REJOIN_ATTEMPTS = 5;

/**
 * Connect a phone to the TV that shows `code`.
 *
 * States passed to onState: 'connecting' | 'joined' | 'reconnecting' |
 * 'rejected' (no TV with that code) | 'ended' (the TV closed the session).
 *
 * @param {import('./index.d.ts').ConnectPhoneOptions} options
 * @returns {import('./index.d.ts').PhoneConnection}
 */
export function connectPhone(options) {
  const {
    url,
    code,
    onMessage = () => {},
    onState = () => {},
    pingMs = 45000,
    retryMs = 2000,
    WebSocketImpl = globalThis.WebSocket,
  } = options;

  let ws = null;
  let state = 'connecting';
  let heartbeat;
  let retryTimer;
  let everJoined = false;
  let failedRejoins = 0;
  let finished = false;

  const setState = (next, detail) => {
    state = next;
    onState(next, detail);
  };

  const finish = (next, detail) => {
    finished = true;
    clearInterval(heartbeat);
    clearTimeout(retryTimer);
    setState(next, detail);
  };

  function connect() {
    const sep = url.includes('?') ? '&' : '?';
    const socket = new WebSocketImpl(`${url}${sep}role=phone&code=${encodeURIComponent(code)}`);
    ws = socket;
    let joined = false;

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'hello' }));
      // Keeps proxies and API Gateway (10 minute idle timeout) from dropping us.
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (socket.readyState === OPEN) socket.send(JSON.stringify({ type: 'ping' }));
      }, pingMs);
    };

    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.type === 'joined') {
        joined = everJoined = true;
        failedRejoins = 0;
        // The server answers hello with joined again; report the change once.
        if (state !== 'joined') setState('joined', { code: msg.code });
      } else if (msg.type === 'closed') {
        finish('ended', { reason: msg.reason });
      } else if (msg.type === 'error') {
        onState(state, { error: msg.message });
      } else if (msg.type === 'message') {
        onMessage(msg.data, msg.from);
      }
      // 'peer' and 'pong' need no action on the phone.
    };

    socket.onclose = (event) => {
      clearInterval(heartbeat);
      if (finished || ws !== socket) return;
      if (event.code === 4001) return finish('ended', { reason: 'tv left' });
      if (event.code === 4004) return finish('rejected');
      if (!joined) {
        // Never got in. API Gateway refuses unknown codes at the HTTP upgrade (no close code), so this is how it looks.
        if (!everJoined) return finish('rejected');
        if (++failedRejoins >= MAX_REJOIN_ATTEMPTS) return finish('ended', { reason: 'tv gone' });
      }
      setState('reconnecting');
      retryTimer = setTimeout(connect, retryMs);
    };
  }

  connect();

  return {
    /** Send `data` to the TV (and other phones). Returns false if not connected. */
    send(data) {
      if (ws?.readyState !== OPEN || state !== 'joined') return false;
      ws.send(JSON.stringify({ type: 'send', data }));
      return true;
    },
    close() {
      finished = true;
      clearInterval(heartbeat);
      clearTimeout(retryTimer);
      try {
        ws?.close();
      } catch {}
    },
    get state() {
      return state;
    },
  };
}

/** Pull the 4-letter code out of a join URL such as https://host/p/ABCD. */
export function codeFromPath(pathname = globalThis.location?.pathname ?? '') {
  const m = pathname.match(/\/([A-Za-z0-9]{4})\/?$/);
  return m ? m[1].toUpperCase() : undefined;
}
