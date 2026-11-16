# Site assistant: the server contract

What the browser calls on **your** server. Your server holds the secret key and talks to Labs; the browser never
sees the key and never calls Labs. `server-python/` and `server-node/` implement this contract the same way, and
`contract-test.py` checks either one.

All paths are on the site's own origin. JSON bodies are UTF-8. Every `/api/*` request must come from an allowed
origin (see [Who may call](#who-may-call)).

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/site` | The owner's settings the widget needs |
| `POST` | `/api/chat` | Ask a question; the answer comes back as a stream of whole sentences |
| `POST` | `/api/cancel` | Stop sending the answer that is streaming on a chat |
| `GET` | `/api/speech?text=…` | One sentence as audio, streamed as it is made |
| `GET` (WebSocket) | `/api/listen` | Live transcription of the visitor's microphone |
| `GET` | `/api/transcript?chatId=…` | The conversation so far |

## `GET /api/site`

`200 application/json`, read once when the widget starts. The public part of `site-assistant.yaml` plus the server's
limits and the message for each error code:

```json
{
  "name": "Saltmarsh Bakery assistant", "title": "Ask Saltmarsh", "storeName": "Saltmarsh Bakery",
  "welcomeMessage": "Hi, I'm the Saltmarsh Bakery assistant. …",
  "welcome": {"playOnFirstTap": true, "autoListen": true, "back": ""},
  "acknowledgements": ["One moment.", "Let me check.", "Good question, one second."],
  "prompts": ["What breads do you have?", "…"],
  "routes": [{"label": "Our breads", "path": "/breads", "aliases": ["menu", "…"], "anchorsAllowed": false}],
  "contact": {"path": "/contact", "email": "hello@example.com"},
  "mode": "turn", "bargeIn": false, "placement": ["hero", "dock", "contact", "header"],
  "theme": {"inherit": true, "colorScheme": "auto", "animation": true},
  "followUp": {"offerNavigation": true}, "navigation": {"enabled": true},
  "retention": {"keepTranscripts": true, "keepDays": 30, "analytics": false, "askMicConsent": true, "askStorageConsent": true},
  "limits": {"questionChars": 500, "speechChars": 300, "listenSeconds": 60, "questionsPerMinute": 6, "clipsPerMinute": 12},
  "listen": {"encoding": "pcm_s16le", "sampleRates": [8000, 16000]},
  "messages": {"budget_reached": "The assistant has reached its limit for now. Please use the contact page.", "…": "…"}
}
```

It never contains the alert addresses, the webhook URL, the agent id or any key.

## `POST /api/chat`

Request: `{"text": "Are you open on Monday?", "chatId": "…"}`. `text` is 1–`limits.questionChars` characters.
Leave `chatId` out for the first question; send the one from the last `chat` event after that.

Answer: `200 text/event-stream`, sent event by event as the agent writes (never buffered). Each event is
`event: <name>` and `data: <one JSON object>`, then a blank line. In this order:

| Event | `data` | What the browser does |
|---|---|---|
| `chat` | `{"chatId"}` | Always first. Keep it for the next question and for `/api/transcript`. It is opaque, and can differ from the one you sent: the server opens a new chat when the old one is full or gone. |
| `tool` | `{"name"}` | The agent is looking something up (`search_knowledge`). Show that it is checking; a good moment for an acknowledgement clip. Zero or more, before the first sentence. |
| `sentence` | `{"index", "text"}` | The next whole sentence, `index` from 0, markdown already removed. Show it and send `text` to `/api/speech`. |
| `link` | `{"path", "label"}` | The answer points to one of the owner's `routes` (the agent's `Read more: /path` line). Offer it; don't speak it. Paths that are not routes are dropped. |
| `error` | `{"code", "message"}` | The turn failed part-way (codes below). `done` follows. |
| `done` | `{"cancelled"}` | Always last. `cancelled` is `true` when `/api/cancel` (or a closed connection) stopped it. |

A refusal before the stream starts is an ordinary JSON error with a status (see [Errors](#errors)), not a stream.

One question at a time per chat. A question sent to a chat whose previous answer is still being written waits on the
server until that answer ends.

## `POST /api/cancel`

Request: `{"chatId": "…"}`. Answer: `200 {"cancelled": true}` if an answer was streaming on that chat, else
`{"cancelled": false}`. Closing the `/api/chat` connection does the same.

Labs has no way to stop a reply. Cancel stops **your server** sending it: the open stream gets `done`
`{"cancelled": true}` at once and no more sentences, so the browser makes no more speech calls for it. The agent
still finishes the reply, it is still charged in full, and it is in the transcript. The server reads the rest of it
quietly so the chat is free for the next question. Speech the browser already asked for is still made and charged
unless the browser drops it (abort the request or clear the `<audio>` element's `src`).

## `GET /api/speech?text=…`

`text` is one sentence (or the first few joined), 1–`limits.speechChars` characters. The server removes markdown,
applies the owner's `pronunciations`, and speaks it in the agent's voice.

Answer: `200 audio/mpeg`. Point an `<audio>` element at the URL: playback starts on the first bytes.

| Header | Value |
|---|---|
| `X-Clip` | `cached`: the line is one of the clips made in advance (`out/clips/`), sent from disk, free, with `Content-Length` and `Cache-Control: public, max-age=86400`; a `Range` request gets `206`. `live`: spoken now, relayed as it arrives, no `Content-Length`, `Cache-Control: no-store`. |

Only `live` clips count toward `clipsPerMinute` and cost credits. A failure before the first byte is a JSON error;
one after it ends the audio early.

## `GET /api/listen` (WebSocket)

The browser can't send the key on a WebSocket, so the server opens the Labs live-transcription socket with the key
and relays frames both ways, unchanged, using Labs' protocol:

- Browser → server: first `{"type": "start", "sampleRate": 16000}` (also optional: `language`, default `en-US`;
  `encoding`, only `pcm_s16le`). Then binary frames of 16-bit mono PCM at that rate, 20–100 ms each, at most 64 KB.
  Then `{"type": "stop"}`.
- Server → browser: `{"type": "ready"}`, then `{"type": "partial", "text"}` (replaces the previous partial),
  `{"type": "final", "text", "startMs", "endMs", "words", …}` (append it, clear the partial), and after `stop`
  `{"type": "end", "durationMs"}`, then the socket closes with `1000`.

The server adds: the origin check on the handshake (a refused origin gets HTTP `403`, no socket; a plain `GET`
without the WebSocket upgrade gets `400 bad_request`); one open session per visitor; up to `questionsPerMinute`
sessions a minute per visitor, counted apart from questions; the budget; and at most `limits.listenSeconds` of audio
a session, after which the server sends `stop` itself, so `end` can arrive without the browser's `stop`.

A refusal after the socket opens is `{"type": "error", "code", "message"}` with a code from the table below, then a
close: `1008` for the server's own limits, otherwise Labs' close code (`4000` bad start frame, `4008` no audio for
30 s, `1009` frame too large, `1011` service failure).

## `GET /api/transcript?chatId=…`

`200 {"chatId", "turns": [{"role": "user" | "assistant", "text", "link"}]}`, oldest first. Assistant text has its
markdown removed and its `Read more:` line taken out as `link` (`{"path", "label"}` or `null`), as in the stream.
Tool look-ups are left out. A `chatId` this server didn't issue gets `404 not_found`. Up to 30 reads a minute per
visitor.

## Errors

Any refusal is a status and

```json
{"error": {"code": "slow_down", "message": "One moment, please. Try again in a few seconds.", "retryAfter": 8}}
```

`retryAfter` (seconds, also sent as `Retry-After`) is there only on `slow_down`. The browser shows `message`, or its
own wording for the `code`; `GET /api/site` lists every message under `messages`. Labs' own error bodies never reach
the browser.

| Code | Status | When |
|---|---|---|
| `bad_request` | 400 | No `text`, not JSON, an unknown field, a bad start frame |
| `not_allowed` | 403 | The request's origin is not allowed |
| `not_found` | 404 | A `chatId` this server didn't issue; an unknown `/api/` path |
| `too_long` | 413 | Over `questionChars` or `speechChars`; a WebSocket frame over 64 KB |
| `slow_down` | 429 | This visitor's or the whole site's per-minute limit, or a second open listen session; also Labs' account limit |
| `budget_reached` | 402 | The month's or this visitor's spend cap is reached, or the account is out of credits. `message` is the owner's `budget.atLimitMessage`. |
| `unavailable` | 503 | Labs failed or can't answer right now (the owner is alerted when a person must act) |

## Who may call

- **Origin.** `ALLOWED_ORIGINS` (comma-separated, e.g. `https://www.example.com`); by default the server's own
  `http://localhost:<port>` and `http://127.0.0.1:<port>`. The server checks `Origin`, or the origin of `Referer`
  when there is no `Origin` (an `<audio>` element's request has none). Neither header, or one not on the list: `403
  not_allowed`. Answers to allowed origins carry `Access-Control-Allow-Origin`, so the widget also works from another
  origin. This stops other sites using your assistant from their pages; it doesn't stop scripts, which is what the
  limits are for.
- **Visitor.** The client's IP address. Behind a proxy or load balancer, set `TRUST_PROXY=1` so the server takes the
  last address in `X-Forwarded-For` (the one your proxy added).
- **Limits.** Per visitor: `rateLimits.questionsPerMinute` questions and `rateLimits.clipsPerMinute` live clips a
  minute. Per site: 40 questions, 100 live clips, 20 listen sessions and 30 transcript reads a minute. Spend:
  `budget.monthlyCredits` a calendar month for the site, `budget.perVisitorCredits` a day for each visitor. The counts are kept in the server's memory, one set per
  process: they restart at zero with the server, and several processes each count separately.

## Serving the page

The same server serves the sample site at `/` (`/breads`, `/visit`, `/contact` without `.html`) and the built
browser code from `client/dist/` at `/assistant/`. Into each page it adds, before `</body>`:

```html
<link rel="stylesheet" href="/assistant/widget.css">   <!-- only if client/dist/widget.css exists -->
<script type="module" src="/assistant/widget.js"></script>
```

So the client's build writes `client/dist/widget.js` (an ES module) and, optionally, `client/dist/widget.css`;
other files in `dist/` are served as they are. Without `client/dist/widget.js` the pages are served without the
widget.
