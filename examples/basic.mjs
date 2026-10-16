// SPDX-License-Identifier: Apache-2.0
// Starts the pairing server, a fake TV and a fake phone, and has them swap a message.
//
//   node examples/basic.mjs           run the demo and exit
//   node examples/basic.mjs --serve   keep the server up and serve examples/phone.html,
//                                     so a real phone (on the same Wi-Fi) can join
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { createPairingServer } from '@vega-pair/server';
import { connectPhone } from '@vega-pair/web-client';
import { createPairingConnection } from '@vega-pair/vega-client/core';

const serve = process.argv.includes('--serve');
const here = (p) => new URL(p, import.meta.url);

// Your own HTTP server: it serves the phone page the QR code points at.
const http = createServer(async (req, res) => {
  if (/^\/p\/[A-Za-z0-9]{4}$/.test(req.url)) {
    return void res.writeHead(200, { 'content-type': 'text/html' }).end(await readFile(here('./phone.html')));
  }
  if (req.url === '/vega-pair-web-client.js') {
    const js = await readFile(here('../packages/web-client/src/index.js'));
    return void res.writeHead(200, { 'content-type': 'text/javascript' }).end(js);
  }
  res.writeHead(404).end('not found');
});

const pairing = createPairingServer({
  server: http,
  publicUrl: process.env.PUBLIC_URL, // defaults to http://<LAN ip>:<port>
});
http.listen(Number(process.env.PORT ?? (serve ? 8787 : 0)));
await new Promise((resolve) => http.once('listening', resolve));
const wsUrl = `ws://127.0.0.1:${http.address().port}/ws`;

// App-specific logic goes here: react to events, push your own messages.
pairing.on('join', ({ code, phones }) => console.log(`[server] phone joined ${code} (${phones} connected)`));
pairing.on('message', ({ code, from, data }) => console.log(`[server] ${code} ${from}:`, data));

// Fake TV, using the same core the React hook wraps (Node's WebSocket needs the `ws` class here).
let code;
const tv = createPairingConnection({
  url: wsUrl,
  WebSocketImpl: WebSocket,
  onState: (s) => {
    if (s.status === 'waiting' && !code) {
      code = s.code;
      console.log(`[tv] show this QR code: ${s.joinUrl}`);
    }
  },
  onMessage: (data, from) => {
    console.log(`[tv] got`, data, `from ${from}`);
    tv.send({ kind: 'reply', text: 'hello phone' });
  },
});
tv.start();
while (!code) await new Promise((r) => setTimeout(r, 20));

if (serve) {
  console.log(`\nOpen the join URL on a phone, or just watch: Ctrl+C to stop.`);
} else {
  // Fake phone.
  const phone = connectPhone({
    url: wsUrl,
    code,
    WebSocketImpl: WebSocket,
    onState: (s) => {
      console.log(`[phone] ${s}`);
      if (s === 'joined') phone.send({ kind: 'hello', text: 'hello TV' });
    },
    onMessage: async (data) => {
      console.log('[phone] got', data);
      phone.close();
      tv.stop();
      await pairing.close();
      http.close();
    },
  });
}
