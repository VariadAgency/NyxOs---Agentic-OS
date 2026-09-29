// Demo mode: the invented sessions of "Lumen Labs", a small studio building "Atlas" (web app, API,
// mobile app). Everything here is fiction; paths live under /Users/demo/projects.
import { DAY, HOUR, l, type L } from "./text.js";
import type { Step, Turn } from "./transcripts.js";

export const DEMO_ROOT = "/Users/demo/projects";

export interface DemoRepo {
  id: string;
  label: string;
  root: string;
  mainBranch: string;
}

export const REPOS = {
  web: { id: "atlas-web", label: "Atlas Web", root: `${DEMO_ROOT}/atlas-web`, mainBranch: "main" },
  api: { id: "atlas-api", label: "Atlas API", root: `${DEMO_ROOT}/atlas-api`, mainBranch: "main" },
  mobile: { id: "atlas-mobile", label: "Atlas Mobile", root: `${DEMO_ROOT}/atlas-mobile`, mainBranch: "main" },
  infra: { id: "atlas-infra", label: "Atlas Infra", root: `${DEMO_ROOT}/atlas-infra`, mainBranch: "main" },
} satisfies Record<string, DemoRepo>;

export type RepoKey = keyof typeof REPOS;

export interface DemoWorktree {
  slug: string;
  label: string;
  repo: RepoKey;
  branch: string;
}

/** Worktrees live in `<repo>/.worktrees/<slug>`, one per feature branch. */
export const WORKTREES: DemoWorktree[] = [
  { slug: "checkout-v2", label: "Checkout v2", repo: "web", branch: "feat/checkout-v2" },
  { slug: "search-rework", label: "Search Rework", repo: "web", branch: "feat/search-rework" },
  { slug: "passkeys", label: "Passkey Login", repo: "api", branch: "feat/passkey-login" },
  { slug: "offline-sync", label: "Offline Sync", repo: "mobile", branch: "feat/offline-sync" },
];

export function worktreePath(w: DemoWorktree): string {
  return `${REPOS[w.repo].root}/.worktrees/${w.slug}`;
}

export type DemoState = "running" | "waiting" | "idle" | "crashed" | "closed" | "ended";

export interface DemoSession {
  key: string;
  tool: "claude" | "codex";
  repo: RepoKey;
  worktree?: string;
  /** Branch when not in a worktree (default: main). */
  branch?: string;
  model: string;
  subModel?: string;
  title?: L;
  /** Minutes before now when the session started and how long it ran. */
  startMin: number;
  durMin: number;
  state: DemoState;
  contextFrac: number;
  turns: Turn[];
  /** Codex sub-agent: key of the parent session. */
  parent?: string;
  nickname?: string;
  limits?: { primary: number; secondary: number };
}

const read = (path: string): Step => ({ t: "read", path });
const grep = (pattern: string): Step => ({ t: "grep", pattern });
const edit = (path: string, old: string, neu: string): Step => ({ t: "edit", path, old, new: neu });
const write = (path: string, content: string): Step => ({ t: "write", path, content });
const bash = (cmd: string, fail = false): Step => ({ t: "bash", cmd, fail });
const say = (de: string, en: string): Step => ({ t: "say", text: l(de, en) });
const skill = (name: string): Step => ({ t: "skill", name });
const agent = (type: string, desc: L, prompt: L, result: L, steps: Step[]): Step => ({ t: "agent", type, desc, prompt, result, steps });

/** Test critic sub-agent with its verdict (PASS / PASS_WITH_NOTES / BLOCK), as the agents tab reads it. */
const critic = (area: string, result: L, files: string[]): Step =>
  agent("test-critic", l(`Tests prüfen: ${area}`, `Review tests: ${area}`), l(`Prüfe die Tests für ${area} auf fehlende Randfälle.`, `Review the tests for ${area} for missing edge cases.`), result, files.map(read));
const reviewer = (area: string, result: L, files: string[]): Step =>
  agent("code-reviewer", l(`Code-Review: ${area}`, `Code review: ${area}`), l(`Prüfe die Änderungen an ${area} auf Fehler und Lesbarkeit.`, `Review the changes to ${area} for bugs and readability.`), result, files.map(read));

export const SESSIONS: DemoSession[] = [
  {
    key: "checkout-stepper",
    tool: "claude",
    repo: "web",
    worktree: "checkout-v2",
    model: "claude-opus-5-5",
    subModel: "claude-sonnet-5",
    title: l("Checkout v2: Schritt-Leiste und Adressformular", "Checkout v2: step bar and address form"),
    startMin: 95,
    durMin: 93,
    state: "running",
    contextFrac: 0.46,
    turns: [
      {
        user: l(
          "Bau im Checkout v2 eine Schritt-Leiste (Warenkorb → Adresse → Zahlung → Bestätigung). Das Adressformular soll Fehler direkt am Feld zeigen, nicht erst beim Absenden.",
          "Build a step bar for checkout v2 (cart → address → payment → confirmation). The address form should show errors right at the field, not only on submit.",
        ),
        steps: [
          skill("frontend-design"), read("src/app/checkout/page.tsx"),
          read("src/app/checkout/AddressForm.tsx"),
          grep("useCheckoutState"),
          say("Ich lege die Schritt-Leiste als eigene Komponente an und hänge sie an den bestehenden Checkout-Zustand.", "I'll add the step bar as its own component and connect it to the existing checkout state."),
          write("src/app/checkout/StepBar.tsx", "export function StepBar({ step }: { step: CheckoutStep }) {\n  return <ol className=\"steps\">…</ol>;\n}\n"),
          edit("src/app/checkout/page.tsx", "<AddressForm />", "<StepBar step={state.step} />\n      <AddressForm onValid={next} />"),
          edit("src/app/checkout/AddressForm.tsx", "validateOnSubmit", "validateOnBlur"),
          bash("pnpm vitest run src/app/checkout"),
        ],
        reply: l(
          "Fertig: `StepBar` zeigt vier Schritte, der aktive ist hervorgehoben. Das Adressformular prüft jetzt beim Verlassen eines Felds. 18 Tests grün.",
          "Done: `StepBar` shows four steps and highlights the active one. The address form now validates when you leave a field. 18 tests green.",
        ),
      },
      {
        user: l("Schau bitte noch, ob die Tastatur-Bedienung passt, und lass einen Test-Kritiker drüberschauen.", "Please check keyboard navigation too, and let a test critic take a look."),
        steps: [
          agent(
            "test-critic",
            l("Checkout-Tests prüfen", "Review checkout tests"),
            l("Prüfe die Tests unter src/app/checkout: fehlen Randfälle (leere PLZ, Umlaute, Tastatur)?", "Review the tests in src/app/checkout: are edge cases missing (empty postcode, umlauts, keyboard)?"),
            l("PASS_WITH_NOTES – zwei Lücken: kein Test für die Tab-Reihenfolge, keiner für Umlaute im Straßennamen. Der Rest ist solide.", "PASS_WITH_NOTES – two gaps: no test for tab order, none for umlauts in street names. The rest is solid."),
            [read("src/app/checkout/AddressForm.test.tsx"), read("src/app/checkout/StepBar.tsx"), say("Tab-Reihenfolge ist nicht abgedeckt.", "Tab order is not covered.")],
          ),
          edit("src/app/checkout/AddressForm.test.tsx", "describe(\"AddressForm\"", "describe(\"AddressForm – keyboard and umlauts\""),
          bash("pnpm vitest run src/app/checkout"),
        ],
      },
    ],
  },
  {
    key: "passkey-register",
    tool: "claude",
    repo: "api",
    worktree: "passkeys",
    model: "claude-opus-5-5",
    title: l("Passkey-Login: Registrierung mit WebAuthn", "Passkey login: registration with WebAuthn"),
    startMin: 3 * HOUR,
    durMin: 2 * HOUR + 48,
    state: "waiting",
    contextFrac: 0.62,
    turns: [
      {
        user: l("Wir brauchen Passkeys als Login. Fang mit der Registrierung an: Challenge erzeugen, speichern, Antwort prüfen.", "We need passkeys for login. Start with registration: create a challenge, store it, verify the response."),
        steps: [
          read("src/auth/routes.ts"),
          read("src/db/schema.ts"),
          write("src/auth/passkeys.ts", "export async function beginRegistration(userId: string) {\n  // challenge valid for 5 minutes\n}\n"),
          write("src/db/migrations/0043_passkeys.sql", "create table passkeys (id text primary key, user_id text not null, public_key text not null, counter bigint not null default 0);\n"),
          edit("src/auth/routes.ts", "router.post(\"/login\"", "router.post(\"/passkeys/register/begin\", beginRegistration);\nrouter.post(\"/login\""),
          bash("pnpm test src/auth"),
        ],
        reply: l(
          "Registrierung steht: `POST /passkeys/register/begin` und `/finish`, Challenge 5 Minuten gültig, Tabelle `passkeys` als neue Migration 0043. Tests grün.",
          "Registration works: `POST /passkeys/register/begin` and `/finish`, challenge valid for 5 minutes, new table `passkeys` in migration 0043. Tests green.",
        ),
      },
      {
        user: l("Soll die Challenge in Redis oder in Postgres liegen?", "Should the challenge live in Redis or in Postgres?"),
        steps: [read("src/lib/cache.ts"), say("Redis gibt es schon für Sessions, TTL wäre dort eingebaut.", "Redis already exists for sessions, TTL would be built in there.")],
        reply: l(
          "Ich empfehle Redis: die Challenge lebt nur 5 Minuten, Redis räumt sie mit TTL selbst weg, und wir nutzen es schon für Sessions. Postgres ginge auch, bräuchte aber einen Aufräum-Job. Soll ich umstellen?",
          "I recommend Redis: the challenge only lives 5 minutes, Redis removes it with a TTL by itself, and we already use it for sessions. Postgres would work too but needs a cleanup job. Should I switch?",
        ),
      },
    ],
  },
  {
    key: "offline-queue",
    tool: "codex",
    repo: "mobile",
    worktree: "offline-sync",
    model: "gpt-6-astra",
    title: l("Offline-Warteschlange für Bestellungen", "Offline queue for orders"),
    startMin: 70,
    durMin: 68,
    state: "running",
    contextFrac: 0.33,
    limits: { primary: 38, secondary: 57 },
    turns: [
      {
        user: l("Bestellungen sollen offline in eine Warteschlange und beim nächsten Netz automatisch gesendet werden.", "Orders should go into a queue while offline and be sent automatically once the network is back."),
        steps: [
          read("src/sync/offlineQueue.ts"),
          read("src/api/orders.ts"),
          say("Ich speichere offene Bestellungen in SQLite und sende sie mit exponentiellem Backoff.", "I'll keep pending orders in SQLite and send them with exponential backoff."),
          edit("src/sync/offlineQueue.ts", "export const queue = [];", "export const queue = createPersistentQueue(\"orders\");"),
          write("src/sync/backoff.ts", "export const backoff = (attempt: number) => Math.min(30_000, 500 * 2 ** attempt);\n"),
          agent("explorer", l("Sync-Protokoll lesen", "Read sync protocol"), l("Lies docs/sync.md", "Read docs/sync.md"), l("ok", "ok"), []),
        ],
        reply: l("Warteschlange ist persistent, Backoff bis 30 s. Nächster Schritt: Konflikte, wenn dieselbe Bestellung doppelt ankommt.", "The queue is persistent, backoff up to 30 s. Next step: conflicts when the same order arrives twice."),
      },
      {
        user: l("Dann bau die Idempotenz auf der Client-Seite ein, der Server kann Idempotenz-Schlüssel schon.", "Then add idempotency on the client side, the server already supports idempotency keys."),
        steps: [read("src/api/client.ts"), edit("src/api/client.ts", "headers: {}", "headers: { \"Idempotency-Key\": order.localId }"), bash("pnpm jest src/sync")],
      },
    ],
  },
  {
    key: "offline-explorer",
    tool: "codex",
    repo: "mobile",
    worktree: "offline-sync",
    model: "gpt-5.6-terra",
    title: l("Recherche: Duplikat-Erkennung im Sync-Protokoll", "Research: duplicate detection in the sync protocol"),
    parent: "offline-queue",
    nickname: "explorer",
    startMin: 52,
    durMin: 6,
    state: "ended",
    contextFrac: 0.08,
    turns: [
      {
        user: l("Recherche: Lies docs/sync.md und fasse zusammen, woran doppelte Bestellungen erkannt werden.", "Research: read docs/sync.md and summarize how duplicate orders are detected."),
        steps: [read("docs/sync.md"), grep("Idempotency-Key")],
        reply: l("Der Server speichert den Idempotenz-Schlüssel 24 h und antwortet bei Wiederholung mit derselben Bestellung (HTTP 200 statt 201).", "The server keeps the idempotency key for 24 h and answers a repeat with the same order (HTTP 200 instead of 201)."),
      },
    ],
  },
  {
    key: "rate-limit-audit",
    tool: "claude",
    repo: "api",
    model: "claude-opus-5-5",
    subModel: "claude-sonnet-5",
    title: l("Audit: Rate-Limits und Fehlercodes der API", "Audit: API rate limits and error codes"),
    startMin: 5 * HOUR,
    durMin: 4 * HOUR + 30,
    state: "waiting",
    contextFrac: 0.71,
    turns: [
      {
        user: l("Mach ein Audit der API: Welche Endpunkte haben kein Rate-Limit, und sind die Fehlercodes einheitlich?", "Audit the API: which endpoints have no rate limit, and are the error codes consistent?"),
        steps: [
          skill("audit"),
          grep("rateLimit("),
          read("src/routes/orders.ts"),
          read("src/routes/users.ts"),
          read("src/middleware/errors.ts"),
          agent(
            "code-reviewer",
            l("Fehlercodes vergleichen", "Compare error codes"),
            l("Vergleiche alle Fehlerantworten unter src/routes mit docs/errors.md.", "Compare all error responses in src/routes with docs/errors.md."),
            l("BLOCK – 7 Abweichungen: 3× 400 statt 422 bei Validierung, 2× fehlender `code`, 2× Klartext statt JSON.", "BLOCK – 7 mismatches: 3× 400 instead of 422 for validation, 2× missing `code`, 2× plain text instead of JSON."),
            [read("docs/errors.md"), grep("c.text("), grep("status(400)")],
          ),
          write("docs/audits/2026-api-rate-limits.md", "# Audit: rate limits and error codes\n\n## Findings\n1. /export has no rate limit (high)\n"),
        ],
        reply: l(
          "Audit fertig (docs/audits/2026-api-rate-limits.md): 4 Endpunkte ohne Rate-Limit, darunter `/export` (hoch). 7 uneinheitliche Fehlercodes. Ich habe 5 Befunde als Aufgaben vorgeschlagen.",
          "Audit done (docs/audits/2026-api-rate-limits.md): 4 endpoints without rate limit, including `/export` (high). 7 inconsistent error codes. I proposed 5 findings as tasks.",
        ),
      },
      {
        user: l("Welchen Befund zuerst?", "Which finding first?"),
        steps: [],
        reply: l("`/export` zuerst: er ist teuer (ganze Historie als CSV) und ohne Limit leicht zu missbrauchen. Danach die 422-Codes, weil die Web-App darauf reagiert.", "`/export` first: it is expensive (whole history as CSV) and easy to abuse without a limit. Then the 422 codes, because the web app reacts to them."),
      },
    ],
  },
  {
    key: "product-images",
    tool: "claude",
    repo: "web",
    model: "claude-sonnet-5",
    title: l("Produktbilder: responsive Größen und Lazy Loading", "Product images: responsive sizes and lazy loading"),
    startMin: 2 * HOUR + 10,
    durMin: 80,
    state: "idle",
    contextFrac: 0.28,
    turns: [
      {
        user: l("Die Produktseiten laden alle Bilder in voller Größe. Bau responsive Größen und Lazy Loading ein.", "Product pages load every image at full size. Add responsive sizes and lazy loading."),
        steps: [
          read("src/app/products/[slug]/page.tsx"),
          read("src/lib/images.ts"),
          edit("src/lib/images.ts", "export function imageUrl(src: string)", "export function imageUrl(src: string, width = 800)"),
          edit("src/app/products/[slug]/page.tsx", "<img src={p.image}", "<ProductImage src={p.image} sizes=\"(max-width: 768px) 100vw, 50vw\""),
          edit("next.config.mjs", "images: {}", "images: { deviceSizes: [640, 828, 1200] }"),
          write("src/components/ProductImage.tsx", "export function ProductImage(props: ProductImageProps) {\n  return <img loading=\"lazy\" {...props} />;\n}\n"),
          bash("pnpm build"),
        ],
      },
    ],
  },
  {
    key: "lcp-performance",
    tool: "claude",
    repo: "web",
    model: "claude-opus-5-5",
    title: l("Performance: LCP der Startseite unter 2 Sekunden", "Performance: home page LCP under 2 seconds"),
    startMin: 110,
    durMin: 62,
    state: "waiting",
    contextFrac: 0.39,
    turns: [
      {
        user: l("Die Startseite hat einen LCP von 3,4 s. Finde die Ursache und bring ihn unter 2 s.", "The home page has an LCP of 3.4 s. Find the cause and get it below 2 s."),
        steps: [
          bash("pnpm lighthouse --only=performance /"),
          read("src/app/page.tsx"),
          read("src/lib/images.ts"),
          say("Das Hero-Bild ist 1,8 MB groß und wird nicht vorgeladen.", "The hero image is 1.8 MB and isn't preloaded."),
          edit("src/lib/images.ts", "quality: 90", "quality: 72, format: \"avif\""),
          edit("next.config.mjs", "images: {}", "images: { formats: [\"image/avif\", \"image/webp\"] }"),
          edit("src/app/page.tsx", "<Hero />", "<Hero priority />"),
          bash("pnpm lighthouse --only=performance /"),
        ],
        reply: l(
          "LCP jetzt 1,7 s (vorher 3,4 s): Hero-Bild als AVIF (1,8 MB → 210 KB) und mit `priority` vorgeladen. Achtung: `src/lib/images.ts` bearbeitet gerade auch die Session „Produktbilder“ – bitte vor dem Commit abgleichen.",
          "LCP is now 1.7 s (was 3.4 s): hero image as AVIF (1.8 MB → 210 KB) and preloaded with `priority`. Heads-up: the “Product images” session is also editing `src/lib/images.ts` – please reconcile before committing.",
        ),
      },
    ],
  },
  {
    key: "android-map-crash",
    tool: "claude",
    repo: "mobile",
    model: "claude-opus-5-5",
    title: l("Absturz beim Kartenstart auf Android beheben", "Fix crash when the map starts on Android"),
    startMin: 4 * HOUR,
    durMin: 95,
    state: "crashed",
    contextFrac: 0.57,
    turns: [
      {
        user: l("Die App stürzt auf Android 15 beim Öffnen der Karte ab. Stacktrace liegt in crash.log.", "The app crashes on Android 15 when the map opens. The stack trace is in crash.log."),
        steps: [
          read("crash.log"),
          read("app/(tabs)/map.tsx"),
          grep("requestLocationPermission"),
          say("Die Standort-Berechtigung wird abgefragt, bevor die Karte bereit ist.", "The location permission is requested before the map is ready."),
          edit("app/(tabs)/map.tsx", "useEffect(() => requestLocationPermission(), []);", "useEffect(() => { if (mapReady) void requestLocationPermission(); }, [mapReady]);"),
          bash("pnpm android --variant release"),
        ],
      },
    ],
  },
  {
    key: "webhook-retries",
    tool: "claude",
    repo: "api",
    model: "claude-sonnet-5",
    title: l("Webhooks: Wiederholungen mit Backoff", "Webhooks: retries with backoff"),
    startMin: 9 * HOUR,
    durMin: 2 * HOUR + 5,
    state: "ended",
    contextFrac: 0.35,
    turns: [
      {
        user: l("Fehlgeschlagene Webhooks gehen verloren. Bau Wiederholungen mit Backoff und ein Protokoll.", "Failed webhooks get lost. Add retries with backoff and a log."),
        steps: [
          skill("tdd"), read("src/webhooks/dispatch.ts"),
          write("src/webhooks/retry.ts", "export const RETRY_DELAYS = [1, 5, 30, 120, 600];\n"),
          edit("src/webhooks/dispatch.ts", "await send(hook, payload);", "await sendWithRetry(hook, payload, RETRY_DELAYS);"),
          edit("src/routes/orders.ts", "return c.json(order, 201);", "void emit(\"order.created\", order);\n  return c.json(order, 201);"),
          write("src/db/migrations/0044_webhook_log.sql", "create table webhook_log (id serial primary key, hook_id text, attempt int, status int, at timestamptz default now());\n"),
          bash("pnpm test src/webhooks"), critic("webhooks", l("PASS – Wiederholungen, Abbruch nach 5 Versuchen und Protokoll sind getestet.", "PASS – retries, giving up after 5 attempts and the log are tested."), ["src/webhooks/retry.test.ts"]),
          bash("git commit -am \"webhooks: retries with backoff and delivery log\""),
        ],
        reply: l("Webhooks werden bis zu 5× wiederholt (1 s bis 10 min), jeder Versuch steht im Protokoll `webhook_log`. Commit ist drin.", "Webhooks are retried up to 5× (1 s to 10 min), every attempt is stored in `webhook_log`. Committed."),
      },
    ],
  },
  {
    key: "deploy-staging",
    tool: "claude",
    repo: "infra",
    model: "claude-sonnet-5",
    title: l("Deploy Staging: Datenbank-Migration 0042", "Deploy staging: database migration 0042"),
    startMin: 6 * HOUR,
    durMin: 50,
    state: "ended",
    contextFrac: 0.21,
    turns: [
      {
        user: l("Deploy bitte die API auf Staging, inklusive Migration 0042. Vorher Backup.", "Please deploy the API to staging, including migration 0042. Backup first."),
        steps: [
          skill("deploy"), read("staging/compose.yml"),
          bash("./scripts/backup.sh staging"),
          edit("scripts/deploy.sh", "docker compose up -d", "docker compose up -d --wait"),
          bash("./scripts/deploy.sh staging atlas-api"),
          bash("curl -s https://staging.atlas.example/health"),
        ],
        reply: l("Staging läuft mit v2.3.0-rc2. Backup vorher erstellt (412 MB), Migration 0042 in 3,1 s durch, Health-Check grün.", "Staging runs v2.3.0-rc2. Backup taken first (412 MB), migration 0042 finished in 3.1 s, health check green."),
      },
    ],
  },
  {
    key: "idempotency-keys",
    tool: "claude",
    repo: "api",
    model: "claude-opus-5-5",
    title: l("Bestellungen: Idempotenz-Schlüssel", "Orders: idempotency keys"),
    startMin: 2 * DAY + 3 * HOUR,
    durMin: 3 * HOUR,
    state: "closed",
    contextFrac: 0.49,
    turns: [
      {
        user: l("Doppelte Bestellungen bei schlechtem Netz verhindern: Idempotenz-Schlüssel im Header, 24 h gültig.", "Prevent duplicate orders on bad networks: idempotency key in a header, valid for 24 h."),
        steps: [
          read("src/routes/orders.ts"),
          write("src/middleware/idempotency.ts", "export const idempotency = (ttlHours = 24) => async (c, next) => { /* … */ };\n"),
          edit("src/routes/orders.ts", "router.post(\"/orders\", create)", "router.post(\"/orders\", idempotency(24), create)"),
          bash("pnpm test src/routes/orders"), reviewer("idempotency.ts", l("PASS – Schlüssel wird vor dem Schreiben geprüft, kein Wettlauf.", "PASS – the key is checked before writing, no race."), ["src/middleware/idempotency.ts"]),
        ],
        reply: l("Fertig. Gleicher Schlüssel innerhalb 24 h liefert die ursprüngliche Bestellung zurück (200 statt 201).", "Done. The same key within 24 h returns the original order (200 instead of 201)."),
      },
    ],
  },
  {
    key: "pricing-tests",
    tool: "codex",
    repo: "api",
    model: "gpt-5.6-terra",
    title: l("Tests für die Preisberechnung", "Tests for price calculation"),
    startMin: DAY + 5 * HOUR,
    durMin: 55,
    state: "ended",
    contextFrac: 0.18,
    limits: { primary: 12, secondary: 44 },
    turns: [
      {
        user: l("Ergänze Tests für die Preisberechnung: Rabatte, Steuern, Rundung.", "Add tests for price calculation: discounts, taxes, rounding."),
        steps: [skill("tdd"), read("src/pricing/calculate.ts"), write("src/pricing/calculate.test.ts", "describe(\"calculate\", () => { /* 14 cases */ });\n"), edit("src/pricing/calculate.ts", "Math.round(net * tax)", "Math.round(net * tax * 100) / 100"), bash("pnpm vitest run src/pricing")],
        reply: l("14 neue Tests, einer deckte einen Rundungsfehler bei 19 % Steuer auf – behoben.", "14 new tests, one uncovered a rounding bug at 19 % tax – fixed."),
      },
    ],
  },
  {
    key: "avif-research",
    tool: "codex",
    repo: "web",
    model: "gpt-6-astra",
    title: l("Recherche: AVIF oder WebP für Produktbilder", "Research: AVIF or WebP for product images"),
    startMin: DAY + 2 * HOUR,
    durMin: 40,
    state: "ended",
    contextFrac: 0.12,
    turns: [
      {
        user: l("Recherche: AVIF oder WebP für Produktbilder? Browser-Unterstützung, Größe, Kodierzeit.", "Research: AVIF or WebP for product images? Browser support, size, encoding time."),
        steps: [bash("node scripts/compare-formats.mjs samples/"), read("samples/report.json")],
        reply: l("AVIF ist im Schnitt 31 % kleiner als WebP, kodiert aber 4× langsamer. Empfehlung: AVIF mit WebP als Rückfall, Kodierung beim Upload statt beim Abruf.", "AVIF is 31 % smaller than WebP on average but encodes 4× slower. Recommendation: AVIF with WebP fallback, encode on upload instead of on request."),
      },
    ],
  },
  {
    key: "roadmap-q4",
    tool: "claude",
    repo: "web",
    model: "claude-opus-5-5",
    title: l("Planung: Roadmap Q4 und Release 2.3", "Planning: Q4 roadmap and release 2.3"),
    startMin: DAY + 7 * HOUR,
    durMin: 45,
    state: "ended",
    contextFrac: 0.15,
    turns: [
      {
        user: l("Lass uns die Roadmap für Q4 planen. Was muss in Release 2.3, was kann warten?", "Let's plan the Q4 roadmap. What has to go into release 2.3, what can wait?"),
        steps: [skill("brainstorm"), read("docs/roadmap.md"), read("docs/feedback-summary.md")],
        reply: l(
          "Vorschlag für 2.3: Checkout v2, Passkeys, Offline-Warteschlange. Später (2.4): Suche neu, Dark Mode für das Dashboard. Begründung: Checkout und Login betreffen jeden Kauf.",
          "Proposal for 2.3: checkout v2, passkeys, offline queue. Later (2.4): new search, dark mode for the dashboard. Reason: checkout and login affect every purchase.",
        ),
      },
    ],
  },
  {
    key: "coupon-codes",
    tool: "claude",
    repo: "web",
    worktree: "checkout-v2",
    model: "claude-sonnet-5",
    title: l("Checkout v2: Gutscheincodes", "Checkout v2: coupon codes"),
    startMin: 3 * DAY + 2 * HOUR,
    durMin: 2 * HOUR,
    state: "ended",
    contextFrac: 0.31,
    turns: [
      {
        user: l("Gutscheincodes im Warenkorb: Feld, Prüfung gegen die API, Anzeige des Rabatts.", "Coupon codes in the cart: field, check against the API, show the discount."),
        steps: [edit("src/app/checkout/page.tsx", "<CartSummary />", "<CartSummary />\n      <CouponField />"), write("src/app/checkout/CouponField.tsx", "export function CouponField() { /* … */ }\n"), edit("src/lib/api.ts", "export const api = {", "export const api = {\n  validateCoupon: (code: string) => post(\"/coupons/validate\", { code }),"), bash("pnpm vitest run"), critic("CouponField", l("PASS – alle Randfälle abgedeckt (leerer Code, abgelaufen, Groß/Klein).", "PASS – all edge cases covered (empty code, expired, upper/lower case)."), ["src/app/checkout/CouponField.test.tsx"])],
        reply: l("Gutscheinfeld eingebaut, ungültige Codes zeigen eine klare Meldung.", "Coupon field added, invalid codes show a clear message."),
      },
    ],
  },
  {
    key: "a11y-review",
    tool: "claude",
    repo: "web",
    model: "claude-opus-5-5",
    title: l("Review: Barrierefreiheit der Navigation", "Review: accessibility of the navigation"),
    startMin: 4 * DAY + 5 * HOUR,
    durMin: 70,
    state: "ended",
    contextFrac: 0.26,
    turns: [
      {
        user: l("Mach ein Review der Navigation auf Barrierefreiheit (Fokus, Kontrast, Screenreader).", "Review the navigation for accessibility (focus, contrast, screen readers)."),
        steps: [skill("audit"), read("src/components/Nav.tsx"), bash("pnpm axe http://localhost:3000"), edit("src/styles/tokens.css", "--focus-ring: transparent", "--focus-ring: var(--accent)"), reviewer("Nav.tsx", l("PASS_WITH_NOTES – Fokus-Reihenfolge stimmt, aber der Menü-Knopf braucht ein aria-label.", "PASS_WITH_NOTES – focus order is fine, but the menu button needs an aria-label."), ["src/components/Nav.tsx"]), write("docs/audits/2026-a11y-navigation.md", "# Review: navigation accessibility\n")],
        reply: l("5 Befunde, 2 davon wichtig: Menü-Knopf ohne Beschriftung, Fokus verschwindet im Untermenü.", "5 findings, 2 of them important: menu button without a label, focus disappears in the submenu."),
      },
    ],
  },
  {
    key: "backups-logs",
    tool: "codex",
    repo: "infra",
    model: "gpt-5.6-terra",
    title: l("Server: Backups und Log-Rotation prüfen", "Server: check backups and log rotation"),
    startMin: 5 * DAY + 3 * HOUR,
    durMin: 35,
    state: "ended",
    contextFrac: 0.1,
    turns: [
      {
        user: l("Server: prüf die Backups und die Log-Rotation auf Produktion.", "Server: check backups and log rotation on production."),
        steps: [bash("ssh prod 'ls -lh /var/backups/atlas | tail -5'"), bash("ssh prod 'cat /etc/logrotate.d/atlas'")],
        reply: l("Backups laufen täglich um 03:00, letzte 7 vorhanden. Log-Rotation greift, aber ohne Komprimierung – 2,1 GB könnten auf 300 MB schrumpfen.", "Backups run daily at 03:00, last 7 present. Log rotation works but without compression – 2.1 GB could shrink to 300 MB."),
      },
    ],
  },
  {
    key: "sync-conflicts",
    tool: "claude",
    repo: "mobile",
    worktree: "offline-sync",
    model: "claude-opus-5-5",
    title: l("Offline Sync: Konflikte auflösen", "Offline sync: resolve conflicts"),
    startMin: 6 * DAY + 4 * HOUR,
    durMin: 3 * HOUR,
    state: "ended",
    contextFrac: 0.44,
    turns: [
      {
        user: l("Wenn zwei Geräte dieselbe Merkliste offline ändern: wie lösen wir den Konflikt?", "When two devices change the same wishlist offline: how do we resolve the conflict?"),
        steps: [read("src/sync/merge.ts"), write("src/sync/lww.ts", "export const lastWriteWins = (a, b) => (a.updatedAt > b.updatedAt ? a : b);\n"), edit("src/sync/offlineQueue.ts", "export const queue = [];", "export const queue = []; // merged with lastWriteWins"), bash("pnpm jest src/sync"), critic("sync/merge", l("PASS_WITH_NOTES – ein Test für gleichzeitiges Löschen fehlt noch.", "PASS_WITH_NOTES – a test for concurrent deletes is still missing."), ["src/sync/merge.test.ts"])],
        reply: l("Merklisten werden eintragsweise zusammengeführt (Vereinigung), Mengen per „letzte Änderung gewinnt“.", "Wishlists are merged per item (union), quantities by “last write wins”."),
      },
    ],
  },
  {
    key: "passkey-research",
    tool: "claude",
    repo: "api",
    worktree: "passkeys",
    model: "claude-sonnet-5",
    title: l("Recherche: Passkey-Unterstützung der Plattformen", "Research: passkey support across platforms"),
    startMin: 8 * DAY + 2 * HOUR,
    durMin: 50,
    state: "ended",
    contextFrac: 0.17,
    turns: [
      {
        user: l("Recherche: Welche Browser und Handys können Passkeys, und was ist mit geteilten Geräten?", "Research: which browsers and phones support passkeys, and what about shared devices?"),
        steps: [read("docs/auth/requirements.md")],
        reply: l("Alle aktuellen Browser und beide Handy-Systeme können Passkeys. Für geteilte Geräte behalten wir den E-Mail-Link als Rückfall.", "All current browsers and both phone platforms support passkeys. For shared devices we keep the email link as a fallback."),
      },
    ],
  },
  {
    key: "dashboard-dark-mode",
    tool: "claude",
    repo: "web",
    model: "claude-sonnet-5",
    title: l("Dark Mode für das Dashboard", "Dark mode for the dashboard"),
    startMin: 10 * DAY + 3 * HOUR,
    durMin: 2 * HOUR + 20,
    state: "ended",
    contextFrac: 0.3,
    turns: [
      {
        user: l("Dunkles Design für das Händler-Dashboard, per Systemeinstellung und Schalter.", "Dark theme for the merchant dashboard, via system setting and a toggle."),
        steps: [skill("frontend-design"), read("src/styles/tokens.css"), edit("src/styles/tokens.css", ":root {", ":root, [data-theme=\"light\"] {"), write("src/components/ThemeToggle.tsx", "export function ThemeToggle() { /* … */ }\n"), bash("pnpm vitest run"), reviewer("ThemeToggle", l("PASS – Kontraste in beiden Modi über 4.5:1.", "PASS – contrast above 4.5:1 in both modes."), ["src/styles/tokens.css"])],
        reply: l("Dark Mode läuft, Farben kommen aus Tokens. Diagramme nutzen jetzt ebenfalls die Tokens.", "Dark mode works, colors come from tokens. Charts use the tokens now too."),
      },
    ],
  },
  {
    key: "search-index",
    tool: "codex",
    repo: "web",
    worktree: "search-rework",
    model: "gpt-6-astra",
    title: l("Suchindex mit Tippfehler-Toleranz", "Search index with typo tolerance"),
    startMin: 12 * DAY + 4 * HOUR,
    durMin: 90,
    state: "ended",
    contextFrac: 0.27,
    turns: [
      {
        user: l("Suchindex neu aufbauen: Tippfehler-Toleranz und Synonyme für Produktnamen.", "Rebuild the search index: typo tolerance and synonyms for product names."),
        steps: [read("src/search/index.ts"), write("src/search/synonyms.json", "{ \"sneaker\": [\"trainer\", \"runner\"] }\n"), edit("src/search/index.ts", "typoTolerance: false", "typoTolerance: { minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 } }"), bash("pnpm test src/search")],
        reply: l("Neuer Index mit Tippfehler-Toleranz ab 4 Buchstaben und 38 Synonymen. Trefferquote im Testset von 71 % auf 89 %.", "New index with typo tolerance from 4 letters and 38 synonyms. Hit rate on the test set from 71 % to 89 %."),
      },
    ],
  },
  {
    key: "export-privacy-audit",
    tool: "claude",
    repo: "api",
    model: "claude-opus-5-5",
    title: l("Audit: Datenschutz beim Export-Endpunkt", "Audit: privacy of the export endpoint"),
    startMin: 15 * DAY + 2 * HOUR,
    durMin: 80,
    state: "ended",
    contextFrac: 0.33,
    turns: [
      {
        user: l("Audit: Gibt der Export-Endpunkt mehr Daten heraus als nötig?", "Audit: does the export endpoint hand out more data than needed?"),
        steps: [skill("audit"), read("src/routes/export.ts"), edit("src/routes/export.ts", "select * from orders", "select id, created_at, total, status from orders"), edit("src/routes/orders.ts", "ip: c.req.header(\"x-forwarded-for\"),", ""), write("docs/audits/2026-export-privacy.md", "# Audit: export privacy\n")],
        reply: l("Ja: der Export enthält interne Notizen und die IP der Bestellung. Beides ist entfernt, Befund dokumentiert.", "Yes: the export contains internal notes and the order IP. Both removed, finding documented."),
      },
    ],
  },
  {
    key: "preview-envs",
    tool: "claude",
    repo: "infra",
    model: "claude-sonnet-5",
    title: l("Deploy: Vorschau-Umgebung je Branch", "Deploy: preview environment per branch"),
    startMin: 18 * DAY + 5 * HOUR,
    durMin: 2 * HOUR,
    state: "ended",
    contextFrac: 0.29,
    turns: [
      {
        user: l("Jeder Branch soll automatisch eine Vorschau-Umgebung bekommen, Deploy über die CI.", "Every branch should automatically get a preview environment, deployed via CI."),
        steps: [skill("deploy"), write("ci/preview.yml", "on: [push]\njobs:\n  preview:\n    runs-on: ubuntu-latest\n"), edit("scripts/deploy.sh", "ENV=$1", "ENV=$1\nBRANCH=${3:-main}"), bash("./scripts/deploy.sh preview feat/checkout-v2")],
        reply: l("Vorschau-Umgebungen laufen unter <branch>.preview.atlas.example und werden nach dem Merge gelöscht.", "Preview environments run at <branch>.preview.atlas.example and are removed after the merge."),
      },
    ],
  },
  {
    key: "onboarding-flow",
    tool: "claude",
    repo: "web",
    model: "claude-opus-5-5",
    title: l("Onboarding-Flow überarbeiten", "Rework the onboarding flow"),
    startMin: 21 * DAY + 3 * HOUR,
    durMin: 3 * HOUR,
    state: "ended",
    contextFrac: 0.4,
    turns: [
      {
        user: l("Das Onboarding hat 6 Schritte, die Hälfte bricht ab. Kürzen auf 3.", "Onboarding has 6 steps and half of the users drop off. Cut it to 3."),
        steps: [read("src/app/onboarding/page.tsx"), edit("src/app/onboarding/page.tsx", "const STEPS = 6", "const STEPS = 3"), edit("src/lib/api.ts", "export const api = {", "export const api = {\n  saveInterests: (ids: string[]) => post(\"/me/interests\", { ids }),"), bash("pnpm vitest run src/app/onboarding"), critic("onboarding", l("BLOCK – der Test für „Standort überspringen“ fehlt, der Schritt bricht ohne Standort ab.", "BLOCK – the test for “skip location” is missing, the step fails without a location."), ["src/app/onboarding/page.test.tsx"]), edit("src/app/onboarding/page.tsx", "if (!location) throw", "if (!location) return next()"), critic("onboarding", l("PASS – Überspringen ist jetzt getestet und funktioniert.", "PASS – skipping is tested now and works."), ["src/app/onboarding/page.test.tsx"])],
        reply: l("3 Schritte: Name, Interessen, Standort (optional). Rest wandert in die Einstellungen.", "3 steps: name, interests, location (optional). The rest moved to the settings."),
      },
    ],
  },
  {
    key: "push-notifications",
    tool: "codex",
    repo: "mobile",
    model: "gpt-5.6-terra",
    title: l("Push-Benachrichtigungen für Bestellstatus", "Push notifications for order status"),
    startMin: 24 * DAY + 2 * HOUR,
    durMin: 100,
    state: "ended",
    contextFrac: 0.22,
    turns: [
      {
        user: l("Push-Benachrichtigungen einrichten: Bestellstatus und Lieferzeit.", "Set up push notifications: order status and delivery time."),
        steps: [write("src/notifications/register.ts", "export async function registerForPush() { /* … */ }\n"), bash("pnpm jest src/notifications")],
        reply: l("Push für Bestellstatus läuft auf beiden Plattformen, Lieferzeit folgt mit der API-Änderung.", "Push for order status works on both platforms, delivery time follows with the API change."),
      },
    ],
  },
  {
    key: "pricing-meeting",
    tool: "claude",
    repo: "web",
    model: "claude-opus-5-5",
    title: l("Besprechung: Preismodell für den Pro-Plan", "Meeting: pricing model for the Pro plan"),
    startMin: 27 * DAY + 4 * HOUR,
    durMin: 35,
    state: "ended",
    contextFrac: 0.09,
    turns: [
      {
        user: l("Besprechung vorbereiten: Pro-Plan monatlich oder nach Bestellungen abrechnen?", "Prepare the meeting: bill the Pro plan monthly or per order?"),
        steps: [skill("brainstorm"), read("docs/pricing/notes.md")],
        reply: l("Empfehlung: fester Monatspreis mit Kontingent, darüber pro Bestellung. Planbar für Händler, fair für kleine Shops.", "Recommendation: fixed monthly price with a quota, per-order above it. Predictable for merchants, fair for small shops."),
      },
    ],
  },
];
