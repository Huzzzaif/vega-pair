# vega-pair protocol

A pairing session has one **TV** and any number of **phones**, joined by a 4-letter code. Everything is JSON over a single WebSocket per client.

## Connecting

| Who   | URL                                     |
| ----- | --------------------------------------- |
| TV    | `ws://host/ws?role=tv`                  |
| Phone | `ws://host/ws?role=phone&code=ABCD`     |

The path (`/ws`) is configurable. A phone's code is case-insensitive. Any `role` other than `tv` is treated as `phone`.

Codes are 4 characters from `ACDEFHJKMNPRTUVWXY3479` (no `0/O`, `1/I/L`, `2/Z`, `5/S`, `8/B`), because people read them off a TV across a room. That is 22^4 = 234,256 codes; the server never hands out a code that is currently in use.

## Framing

**Server to client:** every message is one JSON object followed by a single `\n`. Browsers ignore the trailing whitespace when parsing. Clients on React Native for Vega must buffer until `\n`, because that WebSocket can deliver one message across several `onmessage` calls (`createLineBuffer` does this).

**Client to server:** one JSON object per WebSocket message; no newline needed. Messages that are not valid JSON get an `error` reply. Messages larger than `maxPayload` (default 64 KiB) close the connection with code 1009.

## Client to server

| Message | Meaning |
| ------- | ------- |
| `{"type":"hello"}` | Handshake. Clients send it as soon as the socket opens. The server replies with `session` (TV) or `joined` (phone). On the Node server it is idempotent; on the AWS adapter it is the *only* way the reply is sent (API Gateway cannot post during `$connect`). |
| `{"type":"send","data":<any JSON>}` | Relay `data` to everyone else in the session. |
| `{"type":"ping"}` | Heartbeat. Answered with `pong`. Also resets idle timers (API Gateway closes sockets idle for 10 minutes). |

Anything else is ignored.

## Server to client

| Message | To | Meaning |
| ------- | -- | ------- |
| `{"type":"session","code":"ABCD","joinUrl":"http://host/p/ABCD"}` | TV | Your session. Encode `joinUrl` in the QR code. Sent on connect and again after every `hello`. |
| `{"type":"joined","code":"ABCD"}` | phone | You are in the session. Sent on connect and again after every `hello`. |
| `{"type":"peer","event":"joined"\|"left","role":"phone"}` | everyone else in the session | A phone arrived or left. |
| `{"type":"message","from":"tv"\|"phone"\|"server","data":<any>}` | everyone except the sender | A relayed `send`. `from` is the sender's role; `server` marks messages pushed by your own server code (`sendToSession`). |
| `{"type":"pong"}` | sender of `ping` | Heartbeat reply. |
| `{"type":"error","message":"..."}` | sender | Bad input, or (before closing with 4004) an unknown code. |
| `{"type":"closed","reason":"tv left"}` | phone | AWS adapter only: the TV is gone and the server is about to drop you. |

## Close codes

| Code | Sent to | Meaning |
| ---- | ------- | ------- |
| `4001` | phone | The TV left. The session is over and its code is free; do not retry. |
| `4004` | phone | No TV is waiting with that code. Sent after an `error` message. |
| `1009` | sender | Message too large. |

The AWS adapter cannot choose close codes. It refuses an unknown code at the HTTP upgrade (status 403, so the browser sees an error/close with no `joined`) and sends `closed` before dropping phones when the TV leaves. `connectPhone` handles both forms.

## Lifecycle

1. TV connects, gets `session`, shows the QR code (`joinUrl`).
2. Phone opens `joinUrl`, extracts the code from the path, connects, gets `joined`; the TV gets `peer joined`.
3. Either side sends `{"type":"send","data":...}`; the others receive `message`.
4. A phone leaving sends `peer left` to the rest. The TV leaving closes every phone with `4001` and frees the code.

## Liveness

The server pings every WebSocket every 15 s (protocol-level ping) and terminates sockets that do not answer, which covers phones with locked screens. Clients additionally send an application-level `ping` every 45 s. The Vega client treats the link as dead when it has heard nothing for `2 x 45 s + 5 s`, and reconnects, which yields a **new code**: the old session is gone.
