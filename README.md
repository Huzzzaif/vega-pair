# vega-pair

Pair phones with Fire TV (Vega OS) apps by QR code: a tiny relay server, a React Native for Vega client hook, and a browser client, with workarounds for Vega WebSocket quirks.

The TV shows a QR code. The user scans it, their phone opens a web page, and the phone and TV can now exchange JSON messages in real time: a remote control, a second-screen controller, a text-entry keyboard, a photo upload trigger, a quiz buzzer. No app install on the phone, no accounts.

```
 TV app (React Native for Vega)         relay server            phone browser
 usePairing({ url })  ── role=tv ──▶  @vega-pair/server  ◀── role=phone&code=ABCD ──  connectPhone(...)
   shows PairingQrCode ◀── session {code, joinUrl}                      joined ──▶
   send / onMessage    ◀──────────── {type:'message'} ──────────────▶   send / onMessage
```

## Why

Building the pairing screen for a Vega app turned up three platform problems that cost hours each. This library bakes in the workarounds so you do not have to rediscover them. They were first logged as entries 5, 6 and 8 in the [Drawn In](#credits) friction log.

1. **Large WebSocket messages arrive in pieces.** On the Vega Virtual Device (SDK 0.24), a message of a few KB sometimes reached `onmessage` split over several calls, which shows up as intermittent `JSON Parse error: Unexpected end of input`. Small messages (like the pairing handshake) never split, so it only bites once you send real payloads. The server ends every message with `\n` and `createLineBuffer` reassembles lines before parsing.
2. **A server-side close is not reported.** When the server (or API Gateway, which closes WebSockets idle for 10 minutes) drops the connection, Vega's WebSocket does not always fire `onclose`. The TV keeps showing a code the server has forgotten, and phones scanning it are rejected, so the QR code "doesn't scan". The client runs an application heartbeat (ping every 45 s, which also keeps API Gateway's idle timer from firing) and, after two missed pongs, treats the socket as dead and reconnects with a fresh code.
3. **`@amazon-devices/react-native-qrcode-svg@3.0.0` breaks Yarn 4 installs.** Its dependency ranges carry `+build` metadata that Yarn 4 rejects. `PairingQrCode` skips that package: it generates the matrix with the pure-JS `qrcode-generator` and draws it as a single `<Path>` with `@amazon-devices/react-native-svg`, which also keeps the QR to one native view.

The heartbeat and line-buffer logic is plain TypeScript with injectable timers and WebSocket class, and it is unit tested, so you can see exactly what it does and change the timings.

## Packages

| Package | What | Runtime deps |
| ------- | ---- | ------------ |
| [`@vega-pair/server`](packages/server) | Relay server on `ws`, event hooks for your own logic | `ws@8.18.3` |
| [`@vega-pair/vega-client`](packages/vega-client) | `usePairing` hook, `PairingQrCode`, `createLineBuffer`, framework-free `createPairingConnection` | peers: `react`, `react-native`, `@amazon-devices/react-native-svg`, `qrcode-generator` |
| [`@vega-pair/web-client`](packages/web-client) | `connectPhone` for the phone page; no dependencies | none |
| [`@vega-pair/aws`](aws) | Optional: same protocol on API Gateway WebSocket + Lambda + DynamoDB, with a SAM template | AWS SDK v3 (bundled in the Lambda runtime) |

These are not published to npm yet; use them from a clone or a workspace path (see Status).

## Quick start

### 1. Server

```js
import { createPairingServer } from '@vega-pair/server';

const pairing = createPairingServer({
  port: 8787,
  publicUrl: 'http://192.168.1.20:8787', // what phones can reach; defaults to http://<LAN ip>:<port>
  joinPath: '/p',                        // QR code encodes <publicUrl>/p/<CODE>
});

// Add your own logic; the library only pairs and relays.
pairing.on('message', ({ code, from, data }) => {
  if (from === 'phone' && data.kind === 'vote') pairing.sendToSession(code, { kind: 'tally', n: 1 });
});
// events: session, join, leave, message, end
```

To serve your phone page from the same process, pass your own HTTP server: `createPairingServer({ server })`. See [`examples/basic.mjs`](examples/basic.mjs).

### 2. Vega TV app

```tsx
import { usePairing, PairingQrCode } from '@vega-pair/vega-client';

export function PairScreen() {
  const { state, code, joinUrl, send } = usePairing({
    url: 'ws://192.168.1.20:8787/ws',
    onMessage: (data) => console.log('from phone', data),
  });

  if (state.status === 'paired') return <Text>Phone connected</Text>;
  if (!joinUrl) return <Text>{state.status === 'offline' ? 'Reconnecting…' : 'Connecting…'}</Text>;
  return (
    <View>
      <PairingQrCode value={joinUrl} size={320} />
      <Text>Or go to {joinUrl} (code {code})</Text>
    </View>
  );
}
```

`state.status` is `connecting`, `waiting` (show the QR), `paired` (at least one phone is in) or `offline` (reconnecting; you will get a **new** code). Install the peers in your app: `yarn add qrcode-generator @amazon-devices/react-native-svg`. Plain-HTTP `ws://` works on Vega for a LAN dev server (media playback is the thing that insists on HTTPS); use `wss://` in production.

The package ships TypeScript source (`main` points at `src/index.ts`), which Metro compiles; no build step.

### 3. Phone page

```html
<script type="module">
  import { connectPhone, codeFromPath } from '@vega-pair/web-client'; // or copy src/index.js
  const phone = connectPhone({
    url: `ws://${location.host}/ws`,
    code: codeFromPath(), // from /p/ABCD
    onState: (s) => console.log(s), // connecting | joined | reconnecting | rejected | ended
    onMessage: (data) => console.log('from TV', data),
  });
  document.querySelector('button').onclick = () => phone.send({ kind: 'tap' });
</script>
```

A complete page is in [`examples/phone.html`](examples/phone.html). Try the whole thing without a TV: `npm install && npm run example` runs a server, a fake TV and a fake phone exchanging a message; `node examples/basic.mjs --serve` keeps the server up so a real phone on the same Wi-Fi can join.

## How it works

- The TV opens a WebSocket with `role=tv`. The server allocates a 4-letter code from an unambiguous alphabet and answers `{type:'session', code, joinUrl}`.
- A phone opens `joinUrl`, which carries the code, and connects with `role=phone&code=ABCD`. Unknown codes are refused (close `4004`).
- `{type:'send', data}` from either side becomes `{type:'message', from, data}` for everyone else in the session. The payload is any JSON; the server never looks inside it.
- Joins and leaves are announced to the other side as `peer` events. If the TV leaves, phones are closed with `4001`.
- Both ends heartbeat; the TV also detects a silently dead link and reconnects.

Every message is documented in [PROTOCOL.md](PROTOCOL.md).

### AWS deployment (optional)

[`aws/`](aws) runs the same protocol serverless: `core.js` is the Lambda handler logic against a small store/gateway interface (unit tested in memory), `dynamo.js` implements it with DynamoDB and the API Gateway Management API, and `template.yaml` is a minimal SAM template (WebSocket API, one function, one table with TTL). The wire protocol is identical, with the small differences listed in PROTOCOL.md (replies are sent on `hello`; unknown codes are refused with a 403 upgrade). The template has not been deployed end to end by this project's authors; the protocol was proven in the Drawn In app on the same design.

## Development

```
npm install --no-audit --no-fund
npm test            # node:test, Node >= 22.18 (runs the TypeScript sources directly)
```

## Status

Version 0.1.0, extracted from a working hackathon app. Verified: the relay, line buffer, heartbeat/dead-link logic, browser client (against the real server) and AWS handler logic all have tests. The React hook and `PairingQrCode` are thin wrappers over tested code but are not rendered in tests, since they need the Vega toolchain.

Known gaps / TODO:

- Publish to npm (the client packages currently ship source).
- Render tests for `usePairing` / `PairingQrCode` on the Vega Virtual Device.
- Deploy and test `aws/template.yaml` end to end.
- Session authentication or rate limiting for public deployments: today anyone who knows a live code can join, and codes are short on purpose.
- Re-pairing without a new code after a TV reconnect.

## Credits

Extracted from **Drawn In**, built for the Amazon Developer Hackathon 2026. Contributions welcome under Apache-2.0.

## License

Apache License 2.0. See [LICENSE](LICENSE).
