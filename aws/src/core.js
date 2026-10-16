// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 vega-pair contributors
//
// The vega-pair protocol as an API Gateway WebSocket Lambda handler. This file
// has no AWS imports: it talks to a `store` (sessions and connections) and a
// `gateway` (push to / drop a connection), so it can be unit-tested in memory.
// dynamo.js provides the real implementations.
//
// Differences from the Node server, forced by API Gateway:
//  - nothing can be posted to a client during $connect, so the replies
//    ({type:'session'} / {type:'joined'}) are sent when the client says hello
//    (clients always do), and 'peer joined' is broadcast on the phone's hello;
//  - an unknown code is refused at the HTTP upgrade (403), so there is no 4004
//    close code; the browser client treats "never joined" as rejected;
//  - when the TV disconnects, phones get {type:'closed'} and are dropped by
//    the server (a Lambda cannot choose a WebSocket close code).
//
// store: {
//   claimSession(code, tvId): Promise<boolean>   // false if the code is taken
//   sessionExists(code): Promise<boolean>
//   addConnection(id, code, role): Promise<void>
//   getConnection(id): Promise<{code, role} | null>
//   sessionConnections(code): Promise<{id, role}[]>
//   removeConnection(code, id): Promise<void>
//   deleteSession(code): Promise<void>
// }
// gateway: { post(id, obj): Promise<boolean /* false if gone */>, disconnect(id): Promise<void> }

import { randomBytes } from 'node:crypto';

export const CODE_ALPHABET = 'ACDEFHJKMNPRTUVWXY3479';

const defaultNewCode = () => [...randomBytes(4)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

/**
 * @param {{
 *   store: object, gateway: object, publicUrl: string, joinPath?: string,
 *   newCode?: () => string,
 *   onMessage?: (e: {code: string, from: 'tv'|'phone', data: unknown, post: Function}) => Promise<void>|void,
 * }} options
 */
export function createPairingHandler({ store, gateway, publicUrl, joinPath = '/p', newCode = defaultNewCode, onMessage }) {
  const base = publicUrl.replace(/\/$/, '');
  const joinUrl = (code) => `${base}${joinPath}/${code}`;

  // Same newline framing as the Node server (Vega splits large messages).
  const post = (id, msg) => gateway.post(id, msg);

  async function broadcast(code, msg, exceptId) {
    const peers = await store.sessionConnections(code);
    await Promise.all(
      peers
        .filter((p) => p.id !== exceptId)
        .map(async (p) => {
          if (!(await post(p.id, msg))) await store.removeConnection(code, p.id);
        }),
    );
  }

  async function onConnect(id, query) {
    const role = query.role === 'tv' ? 'tv' : 'phone';
    let code;
    if (role === 'tv') {
      for (let attempt = 0; attempt < 5 && !code; attempt++) {
        const candidate = newCode();
        if (await store.claimSession(candidate, id)) code = candidate;
      }
      if (!code) return { statusCode: 503 };
    } else {
      code = String(query.code ?? '').toUpperCase();
      if (!(await store.sessionExists(code))) return { statusCode: 403 };
    }
    await store.addConnection(id, code, role);
    return { statusCode: 200 };
  }

  async function onMessageRoute(id, body) {
    const me = await store.getConnection(id);
    if (!me) return { statusCode: 410 };
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      await post(id, { type: 'error', message: 'Messages must be JSON.' });
      return { statusCode: 400 };
    }
    // Heartbeat: resets API Gateway's 10 minute idle timer and lets clients
    // notice dead links.
    if (msg?.type === 'ping') {
      await post(id, { type: 'pong' });
      return { statusCode: 200 };
    }
    if (msg?.type === 'hello') {
      if (me.role === 'tv') {
        await post(id, { type: 'session', code: me.code, joinUrl: joinUrl(me.code) });
      } else {
        await post(id, { type: 'joined', code: me.code });
        await broadcast(me.code, { type: 'peer', event: 'joined', role: 'phone' }, id);
      }
      return { statusCode: 200 };
    }
    if (msg?.type !== 'send') return { statusCode: 200 };
    await broadcast(me.code, { type: 'message', from: me.role, data: msg.data }, id);
    if (onMessage) {
      await onMessage({
        code: me.code,
        from: me.role,
        data: msg.data,
        post: (data) => broadcast(me.code, { type: 'message', from: 'server', data }),
      });
    }
    return { statusCode: 200 };
  }

  async function onDisconnect(id) {
    const me = await store.getConnection(id);
    if (!me) return { statusCode: 200 };
    await store.removeConnection(me.code, id);
    if (me.role === 'tv') {
      const phones = await store.sessionConnections(me.code);
      await Promise.all(
        phones.map(async (p) => {
          await post(p.id, { type: 'closed', reason: 'tv left' });
          await store.removeConnection(me.code, p.id);
          await gateway.disconnect(p.id);
        }),
      );
      await store.deleteSession(me.code);
    } else {
      await broadcast(me.code, { type: 'peer', event: 'left', role: 'phone' });
    }
    return { statusCode: 200 };
  }

  return async function handler(event) {
    const { routeKey, connectionId } = event.requestContext;
    if (routeKey === '$connect') return onConnect(connectionId, event.queryStringParameters ?? {});
    if (routeKey === '$disconnect') return onDisconnect(connectionId);
    return onMessageRoute(connectionId, event.body);
  };
}
