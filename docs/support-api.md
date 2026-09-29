# Support service API

NyxOS has a **Feedback & support** sheet (status line → "Feedback & Unterstützen", the connections page, the
bottom of Settings, ⌘K). It has three tabs: *report a bug*, *idea for the developer* and *Buy me Tokens*
(donations). Everything happens inside NyxOS. The web app talks only to the user's own NyxOS server; that
server forwards to the **support service** of the project website, described on this page.

This page is the contract. A website that implements it can be wired up by setting one address — nothing else
in NyxOS changes.

```
Browser (NyxOS web app) ──/api/support/*──▶ own NyxOS server ──HTTPS──▶ support service (project website)
        ▲                                                                        │
        └──────────── payment page in a sandboxed iframe, postMessage ◀──────────┘
```

## Wiring it up

The address of the support service is looked up in this order:

1. `NYXOS_SUPPORT_URL` (environment variable, see [configuration](configuration.md#feedback-and-support)),
2. the setting in the sheet ("Erweitert: Meldestelle"), for self-built versions and forks,
3. `SUPPORT_URL_DEFAULT` in `packages/shared/src/support.ts` — **the one place for the project's official
   address**. It is empty until the website exists.

The address is a base URL; endpoints are resolved relative to it. With `https://nyxos.example.org/support`
NyxOS calls `https://nyxos.example.org/support/v1/bug`. Rules:

- `https://` only. Plain `http://` is accepted only for `localhost` / `127.0.0.1` during development
  (`NYXOS_ALLOW_PRIVATE_URLS=1`).
- No user name or password in the address; query and fragment are dropped.
- Redirects are **not** followed. Answer at the exact address.
- Addresses that resolve to private networks are refused (same SSRF protection as for model providers).

Without an address, bug reports and ideas are kept in the **outbox** (status "waiting") and go out by themselves
once an address is set; donations say "payment is being set up" and cannot be started.

## Common rules

| | |
|---|---|
| Method / format | `POST`, `Content-Type: application/json`, UTF-8. Answers must be JSON. |
| `User-Agent` | `NyxOS/<version>` |
| `Idempotency-Key` | A UUID per report (bug, idea), the same on every retry. **Store it and answer a repeated key with the first answer** — NyxOS retries after timeouts and cannot know whether the first attempt arrived. Donation sessions send a fresh key per click. |
| Time limit | NyxOS waits 10 s for an answer. |
| Answer size | At most 64 KB; larger answers are treated as an error. |
| Request size | Up to 4 MB (a bug report with a 2 MB screenshot as base64). Answer `413` if you accept less. |
| Authentication | None. NyxOS installations are anonymous. Protect the service with rate limits (see `429`). |

### Answers and what NyxOS does with them

| Status | Meaning for NyxOS |
|---|---|
| `200` / `201` + JSON object | Arrived. The report is marked *sent*. |
| `408`, `425`, `429`, `500`, `502`, `503`, `504`, timeout, network error | Try again later. The report stays *waiting*; next attempt after 1, 2, 4 … minutes (at most 6 hours), or after `Retry-After` (seconds or HTTP date) if that is longer. |
| any other `4xx` | Rejected. The report is marked *rejected*, the user sees your message, no new attempt. |
| `3xx` | Treated as rejected ("the support service redirects"). |

Error body (all non-2xx answers):

```json
{ "error": { "code": "invalid_request", "message": "Please describe what happened in a few more words." } }
```

`message` is shown to the user as plain text (keep it short, at most 300 characters, in the user's language if
you can — every request carries it as `client.locale`). Suggested codes:

| Code | Status | When |
|---|---|---|
| `invalid_request` | 400 / 422 | A field is missing or too long. |
| `payload_too_large` | 413 | Screenshot or texts too large. |
| `rate_limited` | 429 | Too many reports from this address; send `Retry-After`. |
| `unavailable` | 503 | Maintenance; send `Retry-After`. |
| `payments_unavailable` | 503 | Donations are switched off right now. |

## `POST /v1/bug`

```json
{
  "id": "6f1c2c4e-3b0a-4f5e-9d51-0c8f7d2b1a90",
  "createdAt": "2026-09-28T10:00:00.000Z",
  "client": { "app": "nyxos", "version": "0.2.0", "mode": "local", "locale": "de" },
  "what": "The Save button does not respond.",
  "before": "Opened Settings, changed the language.",
  "expected": "Saved.",
  "email": "person@example.org",
  "diagnostics": {
    "version": "0.2.0",
    "mode": "local",
    "os": "macOS",
    "browser": "Chrome 140",
    "page": "/settings",
    "language": "de",
    "errors": [
      { "source": "browser", "at": "2026-09-28T09:59:58.000Z", "message": "TypeError: Cannot read properties of undefined (reading 'map')" },
      { "source": "server", "at": "2026-09-28T09:58:02.000Z", "message": "telegram-start-fehler: fetch failed: https://[host]" }
    ]
  },
  "screenshot": { "name": "screenshot.png", "type": "image/png", "dataBase64": "iVBORw0KGgo…" }
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | Same as `Idempotency-Key`. |
| `createdAt` | ISO time | When the user pressed send (not when it arrived — it may have waited in the outbox). |
| `client` | object | `mode`: `local` (on the user's computer), `server` (own server), `unknown`. `locale`: the NyxOS language, `de` or `en`. |
| `what` | string, 3–4000 | Required. |
| `before`, `expected` | string, 0–4000 | May be empty. |
| `email` | string or `null` | Only if the user wants an answer. |
| `diagnostics` | object or `null` | `null` when the user unchecked "attach diagnostics". At most 10 errors, each at most 300 characters. |
| `screenshot` | object or `null` | `type`: `image/png`, `image/jpeg` or `image/webp`; at most 2 MB before base64. |

Answer (`201`):

```json
{ "id": "BUG-1234", "message": "Thank you! We will look at it this week." }
```

`id` (string or number, at most 100 characters) is shown to the user as the report number. `message` (optional,
at most 300 characters) is shown as it is.

## `POST /v1/idea`

```json
{
  "id": "0b8e…",
  "createdAt": "2026-09-28T10:00:00.000Z",
  "client": { "app": "nyxos", "version": "0.2.0", "mode": "local", "locale": "de" },
  "title": "Filter sessions by project",
  "description": "A quick filter above the session list …",
  "importance": "important",
  "email": null
}
```

`importance`: `nice` (would be nice) · `important` · `essential` (needed urgently). `title` 3–160, `description`
3–4000 characters. Answer as for `/v1/bug`.

## `POST /v1/donate/session`

Starts a payment. The support service decides how people pay (Stripe, PayPal, …); NyxOS only embeds the page it
gets back.

```json
{
  "client": { "app": "nyxos", "version": "0.2.0", "mode": "local", "locale": "de" },
  "amountCents": 500,
  "currency": "EUR",
  "interval": "monthly",
  "name": "Kim",
  "message": "Keep going!",
  "publicThanks": true
}
```

| Field | Notes |
|---|---|
| `amountCents` | 100 – 100000 (1 € to 1000 €). Chips offer 3, 5, 10 and 25 €, or a free amount. |
| `currency` | Always `EUR` for now. |
| `interval` | `once` or `monthly`. |
| `name`, `message` | Optional (may be empty), at most 80 / 500 characters. |
| `publicThanks` | The user agrees to be named on a public supporters page. |

Answer (`200`):

```json
{ "embedUrl": "https://nyxos.example.org/support/embed/donate?session=cs_…", "expiresAt": "2026-09-28T10:30:00.000Z" }
```

`embedUrl` must have **exactly the same origin** as the support service address (scheme, host and port) and
must be `https://` (development: `http://localhost`). Anything else is refused and the user sees "the support
service did not send a valid payment page". `expiresAt` is optional and currently not used.

## The embedded payment page

NyxOS shows `embedUrl` in an iframe inside the sheet:

```html
<iframe src="…embedUrl…" sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        allow="payment" referrerpolicy="no-referrer"></iframe>
```

- The page runs in its **own** origin (the website's), so the payment provider's scripts, cookies and storage
  work as usual — nothing is shared with NyxOS.
- Popups are allowed for bank or PayPal confirmations. Top navigation is not: the page must never try to
  navigate NyxOS itself.
- The NyxOS page allows frames only from its own origin and from the support origin (`Content-Security-Policy:
  frame-src 'self' <support origin>`).
- Your page must allow being framed by NyxOS. NyxOS runs on the user's own address (for example
  `http://127.0.0.1:47800` or a Tailscale name), so send `Content-Security-Policy: frame-ancestors *` (or at least
  `http://localhost:* http://127.0.0.1:* https:`) and no `X-Frame-Options` for the embed page only.
- Design for a narrow frame: 320–560 px wide, dark or light background is fine (NyxOS shows it on a dark card).

### Messages to NyxOS (`window.parent.postMessage`)

Post plain objects to `window.parent` with target origin `"*"` (NyxOS runs on addresses you cannot know). Do not
put personal data into these messages. NyxOS accepts a message only if it comes from the support origin **and**
from this very iframe; everything else is ignored.

| Message | When | NyxOS does |
|---|---|---|
| `{ "type": "nyxos-support:ready" }` | The form is ready. | Hides its loading note. (A finished page load counts too.) |
| `{ "type": "nyxos-support:resize", "height": 640 }` | The content height changed (120–4000 px). | Sets the iframe height. |
| `{ "type": "nyxos-support:paid", "reference": "D-42" }` | Payment succeeded (after the provider confirmed it). | Shows the thank-you state. `reference` is optional (≤ 100 chars). |
| `{ "type": "nyxos-support:cancelled" }` | The user cancelled on your page. | Back to the form: "Payment cancelled – nothing was charged." |
| `{ "type": "nyxos-support:error", "message": "…" }` | Payment failed. | Shows `message` (≤ 300 chars) above the frame. |

Example for the embed page:

```js
const post = (m) => window.parent.postMessage(m, "*");
post({ type: "nyxos-support:ready" });
new ResizeObserver(() => post({ type: "nyxos-support:resize", height: document.documentElement.scrollHeight })).observe(document.body);
// after the payment provider confirmed the payment:
post({ type: "nyxos-support:paid", reference: sessionId });
```

The thank-you in NyxOS is a courtesy only. The source of truth for payments is the provider's webhook on the
website — never book anything because of a `postMessage`.

## Privacy: what NyxOS sends

| Sent | Only when |
|---|---|
| The texts the user typed | They press send. |
| E-mail address | They fill in the optional field. |
| Screenshot | They choose or paste one (shown as a preview before sending). |
| Diagnostics: NyxOS version, mode, operating system family, browser family and major version, the area of the current page (first path part only, e.g. `/sessions/…`), language, the last ≤ 10 error lines of browser and server | The "attach diagnostics" box is checked (default). The sheet shows exactly this object before sending. |
| Name, message, `publicThanks`, amount, interval | For a donation, when they press "continue to payment". |
| NyxOS version, mode and language (`client`) | With every request. |

Diagnostics are cleaned twice (in the browser for the preview, again on the NyxOS server with what only it knows,
e.g. the account name): file paths → `[path]`, host names and URLs → `[host]` / `https://[host]`, IP addresses →
`[ip]`, e-mail addresses → `[email]`, keys, tokens, `Bearer …`, long random strings → `•••`, UUIDs → `[id]`, the
user's name and the computer name → `[name]`. The rules live in `packages/shared/src/support.ts`
(`sanitizeDiagnosticText`).

Never sent: session contents, transcripts, file contents, project names, the IP of the NyxOS server beyond the TCP
connection itself, sign-in data, API keys.

The NyxOS server keeps the user's reports in its own database (`support_outbox`) so the sheet can show "waiting"
and "sent". Screenshots are removed from it once a report was sent or rejected. Donations are not stored.

## Testing a support service

The browser test `apps/web/e2e/r5-support.spec.ts` contains a small fake support service (Node `http`, about 40
lines) that implements this contract, including an embed page with "pay" and "cancel" buttons. It is a good
starting point for a real implementation and for checking one: point NyxOS at your service
(`NYXOS_SUPPORT_URL=https://…`), send a bug, an idea and a donation, and watch the sheet.
