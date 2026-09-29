// Demo mode: tasks, bugs, ideas, audit findings, decisions, the decisions inbox, approvals,
// build runs, deploys and the collision/lesson data of the invented "Atlas" project.
import type { Lang } from "@nyxos/shared";
import { REPOS, WORKTREES, worktreePath } from "./sessions.js";
import { DAY, HOUR, l, pick, type L } from "./text.js";

export interface Baustelle {
  slug: string;
  label: string;
}

const B = {
  web: { slug: REPOS.web.id, label: REPOS.web.label },
  api: { slug: REPOS.api.id, label: REPOS.api.label },
  mobile: { slug: REPOS.mobile.id, label: REPOS.mobile.label },
  infra: { slug: REPOS.infra.id, label: REPOS.infra.label },
  checkout: { slug: "checkout-v2", label: "Checkout v2" },
  search: { slug: "search-rework", label: "Search Rework" },
  passkeys: { slug: "passkeys", label: "Passkey Login" },
  offline: { slug: "offline-sync", label: "Offline Sync" },
} satisfies Record<string, Baustelle>;

/** Sort rules the demo user created: every repo and worktree folder is its own "Baustelle". */
export function demoSortRules(): { cwd: string; slug: string; label: string }[] {
  return [
    ...Object.values(REPOS).map((r) => ({ cwd: r.root, slug: r.id, label: r.label })),
    ...WORKTREES.map((w) => ({ cwd: worktreePath(w), slug: w.slug, label: w.label })),
  ];
}

/** Planning words in English have no built-in rule (only German „Planung“/„Besprechung“). */
export const PLANNING_KEYWORDS = ["planning", "roadmap", "meeting"];

export type EntryKind = "aufgabe" | "bug" | "audit" | "idee" | "entscheidung" | "frage" | "problem";

export interface DemoSubtask {
  title: L;
  weight?: number;
  /** Done by this demo session (key) or by hand. */
  done?: { session?: string; min: number };
}

export interface DemoEntry {
  key: string;
  kind: EntryKind;
  title: L;
  description?: L;
  stage: string;
  priority?: "p0" | "p1" | "p2" | "p3";
  baustelle?: Baustelle;
  fileScope?: string[];
  estimate?: string | L;
  modelSuggestion?: string;
  /** Audit finding id (groups findings by prefix). */
  findingId?: string;
  subtasks?: DemoSubtask[];
  /** Linked demo sessions (relation "session"). */
  sessions?: string[];
  /** Session that started the work (`started_session_key`). */
  startedBy?: string;
  /** Session the entry came from (relation "entstand_aus"). */
  from?: string;
  createdMin: number;
  updatedMin: number;
  /** Progress notes sessions reported (`entry_events` kind "fortschritt"). */
  notes?: { min: number; text: L; session?: string }[];
}

export interface DemoEntryLink {
  from: string;
  to: string;
  relation: string;
}

const s = (title: L, done?: { session?: string; min: number }, weight = 1): DemoSubtask => ({ title, done, weight });

export function demoEntries(): DemoEntry[] {
  return [
    // ── tasks ──
    {
      key: "t-stepper",
      kind: "aufgabe",
      title: l("Checkout v2: Schritt-Leiste und Adressformular", "Checkout v2: step bar and address form"),
      description: l(
        "Ziel: Käufer sehen jederzeit, wo sie im Checkout sind. Abnahme: vier Schritte sichtbar, Fehler direkt am Feld, per Tastatur bedienbar.",
        "Goal: buyers always see where they are in checkout. Acceptance: four steps visible, errors right at the field, fully usable by keyboard.",
      ),
      stage: "laeuft",
      priority: "p1",
      baustelle: B.checkout,
      fileScope: ["src/app/checkout/**"],
      estimate: l("1 Tag", "1 day"),
      modelSuggestion: "claude-opus-5-5",
      subtasks: [
        s(l("Schritt-Leiste als Komponente", "Step bar component"), { session: "checkout-stepper", min: 80 }, 2),
        s(l("Adressformular prüft beim Verlassen des Felds", "Address form validates on blur"), { session: "checkout-stepper", min: 75 }, 2),
        s(l("Tastatur-Bedienung testen", "Test keyboard navigation")),
        s(l("Umlaute im Straßennamen testen", "Test umlauts in street names")),
      ],
      sessions: ["checkout-stepper"],
      startedBy: "checkout-stepper",
      createdMin: 2 * DAY,
      updatedMin: 3,
      notes: [{ min: 70, text: l("Schritt-Leiste steht, 18 Tests grün.", "Step bar done, 18 tests green."), session: "checkout-stepper" }],
    },
    {
      key: "t-payment",
      kind: "aufgabe",
      title: l("Checkout v2: Zahlungsschritt mit 3-D-Secure", "Checkout v2: payment step with 3-D Secure"),
      description: l(
        "Ziel: Kartenzahlung inklusive Bestätigung durch die Bank. Abnahme: Testkarten mit und ohne Bestätigung laufen durch, Abbruch führt zurück in den Warenkorb.",
        "Goal: card payment including bank confirmation. Acceptance: test cards with and without confirmation pass, cancelling returns to the cart.",
      ),
      stage: "geplant",
      priority: "p1",
      baustelle: B.checkout,
      fileScope: ["src/app/checkout/payment/**"],
      estimate: l("2 Tage", "2 days"),
      subtasks: [s(l("Zahlungsformular", "Payment form")), s(l("3-D-Secure-Weiterleitung", "3-D Secure redirect")), s(l("Fehlerfälle", "Error cases"))],
      createdMin: 2 * DAY,
      updatedMin: 2 * DAY,
    },
    {
      key: "t-coupons",
      kind: "aufgabe",
      title: l("Checkout v2: Gutscheincodes", "Checkout v2: coupon codes"),
      description: l("Gutscheinfeld im Warenkorb mit Prüfung gegen die API.", "Coupon field in the cart, validated against the API."),
      stage: "erledigt",
      priority: "p2",
      baustelle: B.checkout,
      fileScope: ["src/app/checkout/CouponField.tsx"],
      estimate: "3 h",
      subtasks: [s(l("Feld und Prüfung", "Field and validation"), { session: "coupon-codes", min: 3 * DAY + HOUR }), s(l("Tests", "Tests"), { session: "coupon-codes", min: 3 * DAY })],
      sessions: ["coupon-codes"],
      createdMin: 5 * DAY,
      updatedMin: 3 * DAY,
    },
    {
      key: "t-passkey-register",
      kind: "aufgabe",
      title: l("Passkey-Login: Registrierung", "Passkey login: registration"),
      description: l("Challenge erzeugen, speichern, Antwort prüfen. Abnahme: Registrierung mit zwei Geräten klappt.", "Create, store and verify a challenge. Acceptance: registering two devices works."),
      stage: "pruefen",
      priority: "p1",
      baustelle: B.passkeys,
      fileScope: ["src/auth/**", "src/db/migrations/**"],
      estimate: l("1 Tag", "1 day"),
      subtasks: [
        s(l("Challenge-Endpunkte", "Challenge endpoints"), { session: "passkey-register", min: 2 * HOUR }, 2),
        s(l("Migration 0043", "Migration 0043"), { session: "passkey-register", min: 2 * HOUR }),
        s(l("Tests", "Tests"), { session: "passkey-register", min: 100 }),
      ],
      sessions: ["passkey-register"],
      startedBy: "passkey-register",
      createdMin: 4 * DAY,
      updatedMin: 95,
    },
    {
      key: "t-passkey-login",
      kind: "aufgabe",
      title: l("Passkey-Login: Anmeldung mit Rückfall per E-Mail-Link", "Passkey login: sign-in with email link fallback"),
      description: l("Anmeldung per Passkey, auf geteilten Geräten per E-Mail-Link.", "Sign in with a passkey, on shared devices with an email link."),
      stage: "geplant",
      priority: "p1",
      baustelle: B.passkeys,
      fileScope: ["src/auth/**"],
      estimate: l("1 Tag", "1 day"),
      createdMin: 4 * DAY,
      updatedMin: 4 * DAY,
    },
    {
      key: "t-offline-queue",
      kind: "aufgabe",
      title: l("Offline-Warteschlange für Bestellungen", "Offline queue for orders"),
      description: l("Bestellungen ohne Netz speichern und später senden, ohne Doppelungen.", "Store orders while offline and send them later, without duplicates."),
      stage: "laeuft",
      priority: "p1",
      baustelle: B.offline,
      fileScope: ["src/sync/**", "src/api/client.ts"],
      estimate: l("2 Tage", "2 days"),
      subtasks: [
        s(l("Persistente Warteschlange", "Persistent queue"), { session: "offline-queue", min: 50 }, 2),
        s(l("Backoff", "Backoff"), { session: "offline-queue", min: 45 }),
        s(l("Idempotenz-Schlüssel im Client", "Idempotency key in the client"), undefined, 2),
        s(l("Konflikt-Tests", "Conflict tests")),
      ],
      sessions: ["offline-queue", "sync-conflicts"],
      startedBy: "offline-queue",
      createdMin: 7 * DAY,
      updatedMin: 2,
    },
    {
      key: "t-export-limit",
      kind: "aufgabe",
      title: l("Rate-Limit für /export", "Rate limit for /export"),
      description: l("Ziel: /export höchstens 5× pro Stunde je Konto. Abnahme: 6. Aufruf liefert 429 mit Retry-After.", "Goal: /export at most 5× per hour per account. Acceptance: the 6th call returns 429 with Retry-After."),
      stage: "geplant",
      priority: "p0",
      baustelle: B.api,
      fileScope: ["src/routes/export.ts", "src/middleware/rateLimit.ts"],
      estimate: "2 h",
      modelSuggestion: "claude-sonnet-5",
      from: "rate-limit-audit",
      createdMin: 4 * HOUR,
      updatedMin: 4 * HOUR,
    },
    {
      key: "t-error-codes",
      kind: "aufgabe",
      title: l("Fehlercodes vereinheitlichen (422 bei Validierung)", "Unify error codes (422 for validation)"),
      description: l("Alle Validierungsfehler als 422 mit `code` und JSON-Körper. Abnahme: Vertragstests grün.", "All validation errors as 422 with `code` and a JSON body. Acceptance: contract tests green."),
      stage: "geplant",
      priority: "p1",
      baustelle: B.api,
      fileScope: ["src/middleware/errors.ts", "src/routes/**"],
      estimate: "4 h",
      from: "rate-limit-audit",
      createdMin: 4 * HOUR,
      updatedMin: 4 * HOUR,
    },
    {
      key: "t-webhooks",
      kind: "aufgabe",
      title: l("Webhooks: Wiederholungen mit Backoff", "Webhooks: retries with backoff"),
      description: l("Fehlgeschlagene Webhooks bis zu 5× wiederholen und protokollieren.", "Retry failed webhooks up to 5× and log every attempt."),
      stage: "erledigt",
      priority: "p2",
      baustelle: B.api,
      fileScope: ["src/webhooks/**"],
      estimate: "3 h",
      subtasks: [s(l("Wiederholungen", "Retries"), { session: "webhook-retries", min: 8 * HOUR }), s(l("Protokoll-Tabelle", "Log table"), { session: "webhook-retries", min: 7 * HOUR + 30 })],
      sessions: ["webhook-retries"],
      createdMin: 3 * DAY,
      updatedMin: 7 * HOUR,
    },
    {
      key: "t-images",
      kind: "aufgabe",
      title: l("Produktbilder responsive ausliefern", "Serve responsive product images"),
      description: l("Bilder in passenden Größen und erst beim Scrollen laden.", "Serve images in fitting sizes and load them on scroll."),
      stage: "laeuft",
      priority: "p2",
      baustelle: B.web,
      fileScope: ["src/lib/images.ts", "src/components/ProductImage.tsx"],
      estimate: "4 h",
      subtasks: [s(l("imageUrl mit Breite", "imageUrl with width"), { session: "product-images", min: 100 }), s(l("Lazy Loading", "Lazy loading")), s(l("Build prüfen", "Check build"))],
      sessions: ["product-images"],
      startedBy: "product-images",
      createdMin: DAY,
      updatedMin: 55,
    },
    {
      key: "t-lcp",
      kind: "aufgabe",
      title: l("Startseite: LCP unter 2 Sekunden", "Home page: LCP under 2 seconds"),
      description: l("Abnahme: Lighthouse zeigt LCP < 2 s auf Mobil.", "Acceptance: Lighthouse shows LCP < 2 s on mobile."),
      stage: "pruefen",
      priority: "p1",
      baustelle: B.web,
      fileScope: ["src/app/page.tsx", "src/lib/images.ts", "next.config.mjs"],
      estimate: "3 h",
      subtasks: [s(l("Ursache finden", "Find the cause"), { session: "lcp-performance", min: 90 }), s(l("Hero-Bild als AVIF", "Hero image as AVIF"), { session: "lcp-performance", min: 70 }), s(l("Messung wiederholen", "Measure again"), { session: "lcp-performance", min: 50 })],
      sessions: ["lcp-performance"],
      startedBy: "lcp-performance",
      createdMin: DAY + 2 * HOUR,
      updatedMin: 48,
    },
    {
      key: "t-search",
      kind: "aufgabe",
      title: l("Suche: Tippfehler-Toleranz und Synonyme", "Search: typo tolerance and synonyms"),
      stage: "erledigt",
      baustelle: B.search,
      fileScope: ["src/search/**"],
      subtasks: [s(l("Index neu", "New index"), { session: "search-index", min: 12 * DAY }), s(l("Synonyme", "Synonyms"), { session: "search-index", min: 12 * DAY })],
      sessions: ["search-index"],
      createdMin: 16 * DAY,
      updatedMin: 12 * DAY,
    },
    {
      key: "t-dark-mode",
      kind: "aufgabe",
      title: l("Dark Mode für das Händler-Dashboard", "Dark mode for the merchant dashboard"),
      stage: "erledigt",
      baustelle: B.web,
      sessions: ["dashboard-dark-mode"],
      subtasks: [s(l("Farb-Tokens", "Color tokens"), { session: "dashboard-dark-mode", min: 10 * DAY }), s(l("Schalter", "Toggle"), { session: "dashboard-dark-mode", min: 10 * DAY })],
      createdMin: 14 * DAY,
      updatedMin: 10 * DAY,
    },
    {
      key: "t-onboarding",
      kind: "aufgabe",
      title: l("Onboarding auf 3 Schritte kürzen", "Cut onboarding to 3 steps"),
      stage: "erledigt",
      baustelle: B.web,
      sessions: ["onboarding-flow"],
      createdMin: 25 * DAY,
      updatedMin: 21 * DAY,
    },
    {
      key: "t-push-eta",
      kind: "aufgabe",
      title: l("Push: voraussichtliche Lieferzeit", "Push: estimated delivery time"),
      description: l("Push-Nachricht, sobald sich die Lieferzeit ändert.", "Push message whenever the delivery time changes."),
      stage: "geplant",
      priority: "p3",
      baustelle: B.mobile,
      createdMin: 20 * DAY,
      updatedMin: 20 * DAY,
    },
    {
      key: "t-log-compress",
      kind: "aufgabe",
      title: l("Log-Rotation mit Komprimierung", "Log rotation with compression"),
      description: l("Ziel: Logs auf Produktion komprimieren. Abnahme: Log-Ordner < 500 MB, Rotation täglich.", "Goal: compress logs on production. Acceptance: log folder < 500 MB, daily rotation."),
      stage: "geplant",
      priority: "p2",
      baustelle: B.infra,
      fileScope: ["ops/logrotate/atlas"],
      estimate: "1 h",
      from: "backups-logs",
      createdMin: 5 * DAY,
      updatedMin: 5 * DAY,
    },
    {
      key: "t-preview-cleanup",
      kind: "aufgabe",
      title: l("Vorschau-Umgebungen nach dem Merge löschen", "Remove preview environments after merge"),
      stage: "erledigt",
      baustelle: B.infra,
      sessions: ["preview-envs"],
      createdMin: 19 * DAY,
      updatedMin: 18 * DAY,
    },
    // ── bugs ──
    {
      key: "b-android-map",
      kind: "bug",
      title: l("Android 15: Absturz beim Öffnen der Karte", "Android 15: crash when opening the map"),
      description: l("Standort-Berechtigung wird abgefragt, bevor die Karte bereit ist.", "The location permission is requested before the map is ready."),
      stage: "laeuft",
      priority: "p0",
      baustelle: B.mobile,
      fileScope: ["app/(tabs)/map.tsx"],
      estimate: "2 h",
      subtasks: [s(l("Ursache finden", "Find the cause"), { session: "android-map-crash", min: 3 * HOUR }), s(l("Fix", "Fix"), { session: "android-map-crash", min: 2 * HOUR + 40 }), s(l("Release-Build testen", "Test the release build"))],
      sessions: ["android-map-crash"],
      startedBy: "android-map-crash",
      createdMin: 5 * HOUR,
      updatedMin: 2 * HOUR + 30,
    },
    {
      key: "b-rounding",
      kind: "bug",
      title: l("Preisberechnung: Rundungsfehler bei 19 % Steuer", "Pricing: rounding error at 19 % tax"),
      stage: "erledigt",
      priority: "p1",
      baustelle: B.api,
      sessions: ["pricing-tests"],
      createdMin: DAY + 5 * HOUR,
      updatedMin: DAY + 4 * HOUR,
    },
    {
      key: "b-hyphen-search",
      kind: "bug",
      title: l("Suche findet „T-Shirt“ nicht mit Bindestrich", "Search doesn't find “T-shirt” with a hyphen"),
      description: l("„tshirt“ und „t shirt“ liefern Treffer, „t-shirt“ nicht.", "“tshirt” and “t shirt” return results, “t-shirt” doesn't."),
      stage: "geplant",
      priority: "p2",
      baustelle: B.search,
      createdMin: 3 * DAY,
      updatedMin: 3 * DAY,
    },
    {
      key: "b-duplicate-orders",
      kind: "bug",
      title: l("Doppelte Bestellung bei schlechtem Netz", "Duplicate order on bad networks"),
      stage: "erledigt",
      priority: "p0",
      baustelle: B.api,
      sessions: ["idempotency-keys"],
      createdMin: 3 * DAY,
      updatedMin: 2 * DAY,
    },
    // ── audit findings ──
    ...(
      [
        ["API-RL-01", l("/export hat kein Rate-Limit", "/export has no rate limit"), "p0", "geplant"],
        ["API-RL-02", l("Validierung liefert 400 statt 422", "Validation returns 400 instead of 422"), "p1", "geplant"],
        ["API-RL-03", l("Fehler als Klartext statt JSON", "Errors as plain text instead of JSON"), "p2", "geplant"],
        ["API-RL-04", l("/users/search ohne Limit", "/users/search without a limit"), "p1", "geplant"],
        ["API-RL-05", l("Retry-After fehlt bei 429", "Retry-After missing on 429"), "p3", "geplant"],
      ] as const
    ).map(([id, title, priority, stage]): DemoEntry => ({
      key: `a-${id}`,
      kind: "audit",
      title,
      stage,
      priority,
      findingId: id,
      baustelle: B.api,
      from: "rate-limit-audit",
      createdMin: 4 * HOUR,
      updatedMin: 4 * HOUR,
    })),
    ...(
      [
        ["WEB-A11Y-01", l("Menü-Knopf ohne Beschriftung", "Menu button without a label"), "p1", "geplant"],
        ["WEB-A11Y-02", l("Fokus verschwindet im Untermenü", "Focus disappears in the submenu"), "p1", "geplant"],
        ["WEB-A11Y-03", l("Kontrast der Fußzeile nur 3,9:1", "Footer contrast only 3.9:1"), "p3", "erledigt"],
      ] as const
    ).map(([id, title, priority, stage]): DemoEntry => ({
      key: `a-${id}`,
      kind: "audit",
      title,
      stage,
      priority,
      findingId: id,
      baustelle: B.web,
      from: "a11y-review",
      createdMin: 4 * DAY,
      updatedMin: stage === "erledigt" ? 2 * DAY : 4 * DAY,
    })),
    {
      key: "a-API-PRIV-01",
      kind: "audit",
      title: l("Export enthält interne Notizen und IP-Adressen", "Export contains internal notes and IP addresses"),
      stage: "erledigt",
      priority: "p0",
      findingId: "API-PRIV-01",
      baustelle: B.api,
      from: "export-privacy-audit",
      createdMin: 15 * DAY,
      updatedMin: 15 * DAY,
    },
    // ── ideas ──
    { key: "i-share-wishlist", kind: "idee", title: l("Merkliste per Link teilen", "Share the wishlist via link"), stage: "eingang", baustelle: B.web, createdMin: 6 * HOUR, updatedMin: 6 * HOUR },
    {
      key: "i-price-alert",
      kind: "idee",
      title: l("Preisalarm für gemerkte Produkte", "Price alert for saved products"),
      description: l("Offen: per Push oder E-Mail? Ab welcher Preissenkung?", "Open: push or email? From which price drop?"),
      stage: "in_klaerung",
      baustelle: B.mobile,
      createdMin: 3 * DAY,
      updatedMin: DAY,
    },
    {
      key: "i-weekly-stats",
      kind: "idee",
      title: l("Händler-Statistik als Wochen-E-Mail", "Merchant statistics as a weekly email"),
      description: l("Konzept fertig: Umsatz, Top-Produkte, Retouren – jeden Montag 8 Uhr.", "Concept ready: revenue, top products, returns – every Monday at 8 am."),
      stage: "konzept_fertig",
      baustelle: B.api,
      createdMin: 9 * DAY,
      updatedMin: 2 * DAY,
    },
    { key: "i-voice-search", kind: "idee", title: l("Sprachsuche in der App", "Voice search in the app"), stage: "eingang", baustelle: B.mobile, createdMin: 2 * DAY, updatedMin: 2 * DAY },
    // ── decisions, questions, problems ──
    {
      key: "d-challenge-store",
      kind: "entscheidung",
      title: l("Passkey-Challenge: Redis oder Postgres?", "Passkey challenge: Redis or Postgres?"),
      description: l("Redis hat TTL eingebaut, Postgres bräuchte einen Aufräum-Job.", "Redis has a built-in TTL, Postgres would need a cleanup job."),
      stage: "geplant",
      baustelle: B.passkeys,
      from: "passkey-register",
      createdMin: 20,
      updatedMin: 20,
    },
    {
      key: "q-release-scope",
      kind: "frage",
      title: l("Release 2.3: Offline-Sync mit rein oder in 2.4?", "Release 2.3: include offline sync or move it to 2.4?"),
      stage: "geplant",
      baustelle: B.mobile,
      from: "roadmap-q4",
      createdMin: DAY + 6 * HOUR,
      updatedMin: DAY + 6 * HOUR,
    },
    {
      key: "p-slow-deploy",
      kind: "problem",
      title: l("Staging-Deploy dauert 14 Minuten", "Staging deploy takes 14 minutes"),
      description: l("Docker-Build ohne Cache; Abhängigkeiten werden jedes Mal neu geladen.", "Docker build without cache; dependencies are downloaded every time."),
      stage: "geplant",
      priority: "p2",
      baustelle: B.infra,
      createdMin: 6 * HOUR,
      updatedMin: 6 * HOUR,
    },
  ];
}

export function demoEntryLinks(): DemoEntryLink[] {
  return [
    { from: "t-payment", to: "t-stepper", relation: "vorgaenger" },
    { from: "d-challenge-store", to: "t-passkey-login", relation: "blockiert" },
    { from: "t-passkey-login", to: "t-passkey-register", relation: "vorgaenger" },
    { from: "t-export-limit", to: "a-API-RL-01", relation: "entstand_aus" },
    { from: "t-error-codes", to: "a-API-RL-02", relation: "entstand_aus" },
    { from: "t-error-codes", to: "a-API-RL-03", relation: "verwandt" },
    { from: "t-log-compress", to: "p-slow-deploy", relation: "verwandt" },
    { from: "q-release-scope", to: "t-offline-queue", relation: "entscheidung" },
    { from: "b-hyphen-search", to: "t-search", relation: "verwandt" },
    { from: "b-duplicate-orders", to: "t-offline-queue", relation: "verwandt" },
    { from: "t-lcp", to: "t-images", relation: "verwandt" },
    { from: "i-price-alert", to: "t-push-eta", relation: "verwandt" },
    { from: "t-coupons", to: "t-stepper", relation: "verwandt" },
  ];
}

// ─────────────────────────────── inbox & approvals ───────────────────────────────

export interface DemoInboxItem {
  key: string;
  kind: "frage" | "plan" | "eskalation";
  title: L;
  body?: L;
  options: { id: string; label: L; detail?: L }[];
  status: "open" | "answered" | "dismissed";
  answer?: { optionId: string | null; text: string | null };
  session?: string;
  entry?: string;
  baustelle?: string;
  createdBy: "haiku" | "session" | "regeln";
  estimateMinutes: number;
  yesNo?: boolean;
  escalation?: "produkt" | "datenverlust" | "budget" | "build_rot" | "fremder_bereich";
  createdMin: number;
  answeredMin?: number;
}

export function demoInbox(): DemoInboxItem[] {
  const yes = { id: "ja", label: l("Ja", "Yes") };
  const no = { id: "nein", label: l("Nein", "No") };
  return [
    {
      key: "q-challenge",
      kind: "frage",
      title: l("Passkey-Challenge in Redis oder Postgres speichern?", "Store the passkey challenge in Redis or Postgres?"),
      body: l(
        "Die Session „Passkey-Login“ wartet auf deine Wahl. Redis räumt abgelaufene Challenges selbst weg, Postgres bräuchte einen Aufräum-Job.",
        "The “Passkey login” session is waiting for your choice. Redis removes expired challenges by itself, Postgres would need a cleanup job.",
      ),
      options: [
        { id: "redis", label: l("Redis (empfohlen)", "Redis (recommended)"), detail: l("TTL eingebaut, schon im Einsatz", "Built-in TTL, already in use") },
        { id: "postgres", label: l("Postgres", "Postgres"), detail: l("Ein Speicher weniger, braucht Aufräum-Job", "One store less, needs a cleanup job") },
      ],
      status: "open",
      session: "passkey-register",
      entry: "d-challenge-store",
      baustelle: "passkeys",
      createdBy: "session",
      estimateMinutes: 1,
      createdMin: 20,
    },
    {
      key: "q-audit-first",
      kind: "frage",
      title: l("Welcher Audit-Befund zuerst: /export-Limit oder 422-Codes?", "Which audit finding first: /export limit or 422 codes?"),
      options: [
        { id: "export", label: l("/export-Limit", "/export limit"), detail: l("teuer und leicht zu missbrauchen", "expensive and easy to abuse") },
        { id: "codes", label: l("422-Codes", "422 codes") },
        { id: "spaeter", label: l("Beides nach Release 2.3", "Both after release 2.3") },
      ],
      status: "open",
      session: "rate-limit-audit",
      baustelle: "atlas-api",
      createdBy: "session",
      estimateMinutes: 2,
      createdMin: 32,
    },
    {
      key: "plan-offline",
      kind: "plan",
      title: l("Plan: Offline-Sync in drei Schritten fertigstellen", "Plan: finish offline sync in three steps"),
      body: l(
        "1. Idempotenz-Schlüssel im Client (läuft gerade). 2. Konflikt-Tests für gleichzeitiges Löschen. 3. Release-Build auf beiden Plattformen. Geschätzt 1,5 Tage.",
        "1. Idempotency key in the client (running now). 2. Conflict tests for concurrent deletes. 3. Release build on both platforms. Estimated 1.5 days.",
      ),
      options: [
        { id: "freigeben", label: l("Freigeben", "Approve") },
        { id: "aendern", label: l("Ändern", "Change") },
      ],
      status: "open",
      entry: "t-offline-queue",
      baustelle: "offline-sync",
      createdBy: "haiku",
      estimateMinutes: 3,
      createdMin: 55,
    },
    {
      key: "esc-build",
      kind: "eskalation",
      title: l("Build rot: Passkey-Tests (1 von 42 fehlgeschlagen)", "Build red: passkey tests (1 of 42 failed)"),
      body: l("Der Test „finish registration rejects reused challenge“ schlägt fehl. Die Session wartet gerade.", "The test “finish registration rejects reused challenge” fails. The session is waiting right now."),
      options: [
        { id: "session", label: l("Session reparieren lassen", "Let the session fix it") },
        { id: "ignorieren", label: l("Ignorieren", "Ignore") },
      ],
      status: "open",
      session: "passkey-register",
      baustelle: "passkeys",
      createdBy: "regeln",
      estimateMinutes: 1,
      escalation: "build_rot",
      createdMin: 40,
    },
    {
      key: "q-staging",
      kind: "frage",
      title: l("Staging-Deploy mit Migration 0042 jetzt starten?", "Start the staging deploy with migration 0042 now?"),
      options: [yes, no],
      status: "answered",
      answer: { optionId: "ja", text: null },
      session: "deploy-staging",
      baustelle: "atlas-infra",
      createdBy: "session",
      estimateMinutes: 1,
      yesNo: true,
      createdMin: 6 * HOUR + 5,
      answeredMin: 6 * HOUR,
    },
    {
      key: "q-dark-default",
      kind: "frage",
      title: l("Dark Mode standardmäßig nach Systemeinstellung?", "Dark mode by default following the system setting?"),
      options: [yes, no],
      status: "answered",
      answer: { optionId: "ja", text: null },
      session: "dashboard-dark-mode",
      baustelle: "atlas-web",
      createdBy: "session",
      estimateMinutes: 1,
      yesNo: true,
      createdMin: 10 * DAY + HOUR,
      answeredMin: 10 * DAY + 50,
    },
  ];
}

export interface DemoApproval {
  status: "pending" | "approved" | "denied" | "consumed";
  rule: string;
  reason: L;
  tool: string;
  command: string;
  session?: string;
  worktree?: string;
  createdMin: number;
  decidedMin?: number;
}

export function demoApprovals(): DemoApproval[] {
  const checkout = WORKTREES.find((w) => w.slug === "checkout-v2");
  return [
    {
      status: "pending",
      rule: "git_push",
      reason: l("Push auf einen geteilten Branch braucht deine Freigabe.", "Pushing to a shared branch needs your approval."),
      tool: "Bash",
      command: "git push origin feat/checkout-v2",
      session: "checkout-stepper",
      worktree: checkout ? worktreePath(checkout) : undefined,
      createdMin: 6,
    },
    {
      status: "pending",
      rule: "migration",
      reason: l("Datenbank-Migrationen laufen nur mit Freigabe.", "Database migrations only run with approval."),
      tool: "Bash",
      command: "pnpm db:migrate --to 0043_passkeys",
      session: "passkey-register",
      createdMin: 14,
    },
    {
      status: "consumed",
      rule: "deploy",
      reason: l("Deploy braucht deine Freigabe.", "Deploys need your approval."),
      tool: "Bash",
      command: "./scripts/deploy.sh staging atlas-api",
      session: "deploy-staging",
      createdMin: 6 * HOUR + 2,
      decidedMin: 6 * HOUR,
    },
    {
      status: "denied",
      rule: "delete_outside_worktree",
      reason: l("Löschen außerhalb der eigenen Arbeitskopie ist gesperrt.", "Deleting outside the own worktree is blocked."),
      tool: "Bash",
      command: "rm -rf ../atlas-api/tmp",
      session: "product-images",
      createdMin: 90,
      decidedMin: 88,
    },
  ];
}

// ─────────────────────────────── builds, deploys, conflicts, lessons ───────────────────────────────

export interface DemoBuild {
  kind: "ios" | "backend" | "nyxos";
  command: string;
  status: "green" | "red" | "running";
  exitCode: number | null;
  log: string;
  trigger: "stop_hook" | "manual";
  session?: string;
  folder: string;
  startedMin: number;
  durSec: number;
}

export function demoBuilds(lang: Lang): DemoBuild[] {
  const wt = (slug: string) => {
    const w = WORKTREES.find((x) => x.slug === slug);
    return w ? worktreePath(w) : REPOS.web.root;
  };
  const ok = (n: number) => `Test Files  ${Math.ceil(n / 6)} passed\n     Tests  ${n} passed\n  Duration  ${(n / 9).toFixed(1)}s`;
  const failLog =
    lang === "de"
      ? " FAIL  src/auth/passkeys.test.ts > finish registration > rejects reused challenge\n AssertionError: expected 200 to be 400\n Test Files  1 failed | 6 passed\n      Tests  1 failed | 41 passed"
      : " FAIL  src/auth/passkeys.test.ts > finish registration > rejects reused challenge\n AssertionError: expected 200 to be 400\n Test Files  1 failed | 6 passed\n      Tests  1 failed | 41 passed";
  return [
    { kind: "backend", command: "pnpm test", status: "red", exitCode: 1, log: failLog, trigger: "stop_hook", session: "passkey-register", folder: wt("passkeys"), startedMin: 41, durSec: 38 },
    { kind: "backend", command: "pnpm test", status: "red", exitCode: 1, log: failLog, trigger: "stop_hook", session: "passkey-register", folder: wt("passkeys"), startedMin: 2 * HOUR + 12, durSec: 40 },
    { kind: "backend", command: "pnpm test", status: "green", exitCode: 0, log: ok(118), trigger: "stop_hook", session: "webhook-retries", folder: REPOS.api.root, startedMin: 7 * HOUR, durSec: 52 },
    { kind: "backend", command: "pnpm test", status: "green", exitCode: 0, log: ok(112), trigger: "manual", folder: REPOS.api.root, startedMin: DAY + 4 * HOUR, durSec: 49 },
    { kind: "ios", command: "eas build --platform ios --profile preview --local", status: "green", exitCode: 0, log: "✔ Build finished\n  Artifact: build-1742.ipa (48.2 MB)", trigger: "stop_hook", session: "sync-conflicts", folder: wt("offline-sync"), startedMin: 6 * DAY + HOUR, durSec: 412 },
    { kind: "ios", command: "eas build --platform ios --profile preview --local", status: "green", exitCode: 0, log: "✔ Build finished\n  Artifact: build-1729.ipa (48.0 MB)", trigger: "manual", folder: REPOS.mobile.root, startedMin: 9 * DAY, durSec: 398 },
    { kind: "backend", command: "pnpm test", status: "green", exitCode: 0, log: ok(104), trigger: "stop_hook", session: "idempotency-keys", folder: REPOS.api.root, startedMin: 2 * DAY, durSec: 47 },
  ];
}

export interface DemoDeploy {
  containerName: string;
  imageId: string;
  gitRev: string;
  source: "deploy.sh" | "docker-events";
  createdMin: number;
}

export function demoDeploys(): DemoDeploy[] {
  return [
    { containerName: "nyxos-server", imageId: "sha256:4f1c9e2a7b3d", gitRev: "b7e4a19", source: "deploy.sh", createdMin: 2 * DAY + 3 * HOUR },
    { containerName: "nyxos-server", imageId: "sha256:91ad0c55e6f2", gitRev: "3c0f8d2", source: "deploy.sh", createdMin: 6 * DAY },
    { containerName: "nyxos-server", imageId: "sha256:0be73a18c4d9", gitRev: "e51a7c0", source: "deploy.sh", createdMin: 13 * DAY },
  ];
}

export interface DemoReservation {
  pathGlob: string;
  label: L;
  session?: string;
  createdMin: number;
  untilMin: number | null;
}

export function demoReservations(): DemoReservation[] {
  const checkout = WORKTREES.find((w) => w.slug === "checkout-v2");
  return [
    {
      pathGlob: `${checkout ? worktreePath(checkout) : REPOS.web.root}/src/app/checkout/**`,
      label: l("Checkout v2 – Schritt-Leiste", "Checkout v2 – step bar"),
      session: "checkout-stepper",
      createdMin: 90,
      untilMin: -120,
    },
    { pathGlob: `${REPOS.api.root}/src/db/migrations/**`, label: l("Migrationen nur eine Session gleichzeitig", "Migrations: one session at a time"), createdMin: 5 * DAY, untilMin: null },
  ];
}

export function demoConflictEvents(): { kind: "kollision" | "merge"; folder: string; path: string; min: number }[] {
  const folder = `${REPOS.web.root}/src/lib`;
  return [
    { kind: "kollision", folder, path: `${folder}/images.ts`, min: 45 },
    { kind: "kollision", folder, path: `${folder}/api.ts`, min: 3 * DAY },
    { kind: "kollision", folder, path: `${folder}/api.ts`, min: 5 * DAY },
    { kind: "merge", folder: `${REPOS.web.root}/src/search`, path: `${REPOS.web.root}/src/search/index.ts`, min: 2 * DAY },
  ];
}

export function demoRules(lang: Lang): { kind: string; condition: unknown; action: unknown; origin: string; hitCount: number; createdMin: number; lastHitMin: number | null }[] {
  const folder = `${REPOS.web.root}/src/lib`;
  return [
    {
      kind: "konflikt",
      condition: { folder },
      action: { type: "single-session-per-folder", message: pick(l("Dort nur eine Session gleichzeitig", "Only one session at a time there"), lang) },
      origin: pick(l("Gelernt aus 3 Konflikten in 7 Tagen in atlas-web/src/lib", "Learned from 3 conflicts in 7 days in atlas-web/src/lib"), lang),
      hitCount: 2,
      createdMin: 3 * DAY,
      lastHitMin: 45,
    },
    {
      kind: "reservierung",
      condition: { folder: `${REPOS.api.root}/src/db/migrations` },
      action: { type: "single-session-per-folder", message: pick(l("Migrationen immer nur in einer Session", "Migrations only ever in one session"), lang) },
      origin: pick(l("Von Alex angelegt", "Created by Alex"), lang),
      hitCount: 1,
      createdMin: 5 * DAY,
      lastHitMin: 2 * HOUR,
    },
  ];
}

