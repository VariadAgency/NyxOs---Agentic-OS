// Demo mode: the assistant Nyx (chat threads, memory, plan, schedules, profile), the notes vault
// that feeds the brain graph, agents and skills, and session reviews.
import type { Lang, NyxPersonality, NyxSliders, NyxUserProfile } from "@nyxos/shared";
import { SESSIONS } from "./sessions.js";
import { DAY, HOUR, l, pick, type L } from "./text.js";

export type SourceRef = { kind: "session"; key: string } | { kind: "entry"; key: string };

export interface DemoMessage {
  role: "user" | "assistant";
  text: L;
  sources?: SourceRef[];
  channel?: "web" | "voice";
  /** Minutes after the thread started. */
  at: number;
}

export interface DemoThread {
  key: string;
  title: L;
  topic: string;
  startMin: number;
  messages: DemoMessage[];
  todos?: { content: L; status: "pending" | "in_progress" | "completed" | "cancelled" }[];
}

export function demoThreads(): DemoThread[] {
  return [
    {
      key: "today",
      title: l("Was steht heute an?", "What's on today?"),
      topic: "allgemein",
      startMin: 2 * HOUR + 30,
      messages: [
        { role: "user", text: l("Guten Morgen Nyx, was steht heute an?", "Good morning Nyx, what's on today?"), channel: "voice", at: 0 },
        {
          role: "assistant",
          text: l(
            "Morgen Alex! Drei Dinge brauchen dich: Die Passkey-Session wartet auf deine Wahl zwischen Redis und Postgres [1], das Audit der API hat einen kritischen Befund zu /export [2], und die Android-App ist beim Kartenstart abgestürzt [3]. Der Rest läuft: Checkout v2 und die Offline-Warteschlange sind in Arbeit.",
            "Morning Alex! Three things need you: the passkey session is waiting for your choice between Redis and Postgres [1], the API audit has a critical finding about /export [2], and the Android app crashed while opening the map [3]. The rest is running: checkout v2 and the offline queue are in progress.",
          ),
          sources: [
            { kind: "session", key: "passkey-register" },
            { kind: "entry", key: "a-API-RL-01" },
            { kind: "session", key: "android-map-crash" },
          ],
          channel: "voice",
          at: 1,
        },
        { role: "user", text: l("Was ist mit dem Absturz genau?", "What exactly happened with the crash?"), at: 3 },
        {
          role: "assistant",
          text: l(
            "Die App fragt die Standort-Berechtigung ab, bevor die Karte bereit ist. Die Session hatte den Fix schon geschrieben und den Release-Build gestartet, dann brach sie ab [1]. Der Fix steht ungesichert in `app/(tabs)/map.tsx`. Ich würde die Session fortsetzen und nur den Build wiederholen.",
            "The app asks for the location permission before the map is ready. The session had already written the fix and started the release build, then it stopped [1]. The fix sits uncommitted in `app/(tabs)/map.tsx`. I'd resume the session and just repeat the build.",
          ),
          sources: [{ kind: "session", key: "android-map-crash" }],
          at: 4,
        },
      ],
    },
    {
      key: "passkeys",
      title: l("Passkeys: Redis oder Postgres?", "Passkeys: Redis or Postgres?"),
      topic: "allgemein",
      startMin: 50,
      messages: [
        { role: "user", text: l("Die Passkey-Session fragt, ob die Challenge in Redis oder Postgres soll. Was meinst du?", "The passkey session asks whether the challenge should go into Redis or Postgres. What do you think?"), at: 0 },
        {
          role: "assistant",
          text: l(
            "Redis. Die Challenge lebt nur 5 Minuten, Redis löscht sie mit TTL von selbst, und ihr nutzt Redis schon für Sessions [1]. Postgres ginge, bräuchte aber einen Aufräum-Job und eine weitere Migration. Einziger Haken: fällt Redis aus, kann sich niemand neu registrieren – bestehende Logins wären nicht betroffen.",
            "Redis. The challenge only lives 5 minutes, Redis deletes it by itself with a TTL, and you already use Redis for sessions [1]. Postgres would work but needs a cleanup job and another migration. The only catch: if Redis is down nobody can register a new passkey – existing logins are not affected.",
          ),
          sources: [{ kind: "session", key: "passkey-register" }],
          at: 1,
        },
        { role: "user", text: l("Okay, dann Redis. Kannst du das der Session sagen?", "Okay, Redis then. Can you tell the session?"), at: 4 },
        {
          role: "assistant",
          text: l(
            "Gern – dafür brauche ich deine Bestätigung in „Entscheidungen“, dort steht die Frage der Session schon mit den beiden Optionen [1]. Ein Klick auf „Redis“ und die Antwort geht direkt an die Session.",
            "Sure – I need your confirmation in “Decisions” for that, the session's question is already there with both options [1]. One click on “Redis” and the answer goes straight to the session.",
          ),
          sources: [{ kind: "entry", key: "d-challenge-store" }],
          at: 5,
        },
      ],
    },
    {
      key: "week",
      title: l("Wochenrückblick Atlas", "Atlas weekly review"),
      topic: "allgemein",
      startMin: DAY + 3 * HOUR,
      messages: [
        { role: "user", text: l("Fass mir die letzte Woche zusammen.", "Summarize last week for me."), at: 0 },
        {
          role: "assistant",
          text: l(
            "Kurz: viel geschafft, zwei offene Baustellen.\n\n**Fertig:** Idempotenz-Schlüssel für Bestellungen [1], Webhook-Wiederholungen, Gutscheincodes im Checkout, Preis-Tests (mit einem echten Rundungsfehler gefunden).\n**In Arbeit:** Checkout v2, Passkeys, Offline-Sync.\n**Auffällig:** Die Suche hat einen Merge-Konflikt mit main in `src/lib/api.ts` – der Branch ist 11 Commits hinterher.",
            "Short version: a lot done, two open construction sites.\n\n**Done:** idempotency keys for orders [1], webhook retries, coupon codes in checkout, pricing tests (found a real rounding bug).\n**In progress:** checkout v2, passkeys, offline sync.\n**Worth a look:** search has a merge conflict with main in `src/lib/api.ts` – the branch is 11 commits behind.",
          ),
          sources: [{ kind: "session", key: "idempotency-keys" }],
          at: 1,
        },
        { role: "user", text: l("Wie viel haben wir an Tokens verbraucht?", "How many tokens did we use?"), at: 3 },
        {
          role: "assistant",
          text: l(
            "Die genauen Zahlen stehen unter „Nutzung“ – Claude trägt den Großteil, vor allem Opus in den langen Coding-Sessions. Codex lag diese Woche bei etwa einem Viertel. Das Wochenziel ist noch nicht erreicht.",
            "The exact numbers are under “Usage” – Claude carries most of it, mainly Opus in the long coding sessions. Codex was at about a quarter this week. The weekly goal isn't reached yet.",
          ),
          at: 4,
        },
      ],
    },
    {
      key: "release",
      title: l("Release 2.3 planen", "Plan release 2.3"),
      topic: "allgemein",
      startMin: 3 * DAY + 2 * HOUR,
      messages: [
        { role: "user", text: l("Hilf mir, Release 2.3 zu planen. Was muss rein?", "Help me plan release 2.3. What has to go in?"), at: 0 },
        {
          role: "assistant",
          text: l(
            "Vorschlag, orientiert an der Roadmap-Session [1]: Checkout v2 und Passkeys sind Pflicht, weil sie jeden Kauf betreffen. Offline-Sync ist knapp – ich habe dafür eine offene Frage angelegt [2]. Ich habe dir einen Plan mit vier Schritten angelegt.",
            "Proposal, based on the roadmap session [1]: checkout v2 and passkeys are a must because they affect every purchase. Offline sync is tight – I created an open question for it [2]. I've set up a four-step plan for you.",
          ),
          sources: [
            { kind: "session", key: "roadmap-q4" },
            { kind: "entry", key: "q-release-scope" },
          ],
          at: 2,
        },
      ],
      todos: [
        { content: l("Checkout v2 fertigstellen (Zahlung fehlt)", "Finish checkout v2 (payment missing)"), status: "in_progress" },
        { content: l("Passkey-Registrierung abnehmen", "Sign off passkey registration"), status: "pending" },
        { content: l("Entscheiden: Offline-Sync in 2.3?", "Decide: offline sync in 2.3?"), status: "pending" },
        { content: l("Staging-Deploy mit Migration 0042", "Staging deploy with migration 0042"), status: "completed" },
      ],
    },
  ];
}

export function demoMemory(): { category: "user" | "project" | "preference"; fact: L; createdBy: "nyx" | "user" }[] {
  return [
    { category: "user", fact: l("Alex Rivera leitet die Entwicklung bei Lumen Labs, einem kleinen Studio.", "Alex Rivera leads development at Lumen Labs, a small studio."), createdBy: "user" },
    { category: "user", fact: l("Arbeitet meist morgens konzentriert, Besprechungen am Nachmittag.", "Usually works focused in the morning, meetings in the afternoon."), createdBy: "nyx" },
    { category: "project", fact: l("Atlas besteht aus Web-App (atlas-web), API (atlas-api), Mobile-App (atlas-mobile) und Infrastruktur (atlas-infra).", "Atlas consists of a web app (atlas-web), an API (atlas-api), a mobile app (atlas-mobile) and infrastructure (atlas-infra)."), createdBy: "nyx" },
    { category: "project", fact: l("Release 2.3: Checkout v2 und Passkeys sind Pflicht, Offline-Sync ist offen.", "Release 2.3: checkout v2 and passkeys are a must, offline sync is open."), createdBy: "nyx" },
    { category: "project", fact: l("Migrationen laufen nie ohne Backup und nur in einer Session gleichzeitig.", "Migrations never run without a backup and only in one session at a time."), createdBy: "user" },
    { category: "preference", fact: l("Kurze Antworten, erst das Ergebnis, dann die Begründung.", "Short answers, result first, then the reasoning."), createdBy: "user" },
    { category: "preference", fact: l("Commit-Nachrichten auf Englisch im Conventional-Commits-Stil.", "Commit messages in English, conventional commits style."), createdBy: "nyx" },
  ];
}

export function demoMemorySuggestion(): { action: "add"; category: "preference"; fact: L; reason: L } {
  return {
    action: "add",
    category: "preference",
    fact: l("Bei Architektur-Fragen immer eine klare Empfehlung geben, nicht nur Optionen.", "For architecture questions always give a clear recommendation, not just options."),
    reason: l("Alex hat zweimal nach „Was meinst du?“ gefragt, nachdem nur Optionen kamen.", "Alex asked “What do you think?” twice after only getting options."),
  };
}

export function demoSchedules(): { name: L; prompt: L; mode: "remind" | "run"; kind: "cron" | "event" | "once"; cron?: string; event?: string; deliver: "web"; paused: boolean; nextMin: number | null; lastMin: number | null; lastStatus: string | null; lastOutput: L | null; runCount: number }[] {
  return [
    {
      name: l("Build-Stand am Morgen", "Morning build status"),
      prompt: l("Sag mir um 8 Uhr, welche Builds rot sind.", "Tell me at 8 am which builds are red."),
      mode: "remind",
      kind: "cron",
      cron: "0 8 * * 1-5",
      deliver: "web",
      paused: false,
      nextMin: -(18 * HOUR),
      lastMin: 6 * HOUR,
      lastStatus: "delivered",
      lastOutput: l("1 Build rot: Passkey-Tests.", "1 build red: passkey tests."),
      runCount: 14,
    },
    {
      name: l("Wartende Sessions", "Waiting sessions"),
      prompt: l("Melde dich, wenn eine Session länger als 15 Minuten auf mich wartet.", "Let me know when a session has been waiting for me for more than 15 minutes."),
      mode: "remind",
      kind: "event",
      event: "session_waiting",
      deliver: "web",
      paused: false,
      nextMin: null,
      lastMin: 25,
      lastStatus: "delivered",
      lastOutput: l("„Audit: Rate-Limits“ wartet seit 20 Minuten.", "“Audit: rate limits” has been waiting for 20 minutes."),
      runCount: 31,
    },
    {
      name: l("Freitags-Rückblick", "Friday review"),
      prompt: l("Schreib freitags um 17 Uhr einen Wochenrückblick.", "Write a weekly review on Fridays at 5 pm."),
      mode: "run",
      kind: "cron",
      cron: "0 17 * * 5",
      deliver: "web",
      paused: true,
      nextMin: null,
      lastMin: 8 * DAY,
      lastStatus: "ok",
      lastOutput: null,
      runCount: 3,
    },
  ];
}

export function demoProfile(lang: Lang): { user: NyxUserProfile; personality: NyxPersonality; sliders: NyxSliders } {
  const tr = (de: string, en: string) => pick(l(de, en), lang);
  return {
    user: {
      name: "Alex",
      role: tr("Entwicklungsleitung bei Lumen Labs – baut Atlas (Web-App, API, Mobile-App).", "Head of development at Lumen Labs – builds Atlas (web app, API, mobile app)."),
      projects: tr("Atlas Web, Atlas API, Atlas Mobile, Atlas Infra.", "Atlas Web, Atlas API, Atlas Mobile, Atlas Infra."),
      workStyle: tr("Mehrere Sessions parallel, je Feature ein Worktree. Entscheidet schnell, wenn die Optionen klar sind.", "Several sessions in parallel, one worktree per feature. Decides quickly when the options are clear."),
      likes: tr("Klare Empfehlungen, kurze Antworten, Zahlen mit Quelle.", "Clear recommendations, short answers, numbers with a source."),
      noGos: tr("Deploy, Push oder Migration ohne Freigabe. Lange Einleitungen.", "Deploy, push or migration without approval. Long introductions."),
      notes: "",
    },
    personality: {
      character: tr("Ruhige, direkte Kollegin, die mitdenkt.", "Calm, direct colleague who thinks along."),
      tone: tr("Freundlich und klar, ohne Floskeln.", "Friendly and clear, without filler."),
      address: "du",
      soul: tr(
        "Hilf wirklich, statt nur gefällig zu wirken. Sag deine Meinung und begründe sie kurz. Sieh erst selbst nach, bevor du fragst.",
        "Actually help instead of just being agreeable. Give your opinion and justify it briefly. Look things up yourself before asking.",
      ),
    },
    sliders: { length: 30, speed: 50, expertise: 75, formality: 35, initiative: 65, humor: 30 },
  };
}

// ─────────────────────────────── notes vault (brain graph) ───────────────────────────────

export const VAULT_ROOT = "/Users/demo/Notes/Atlas";

interface NoteSpec {
  key: string;
  folder: L;
  title: L;
  links: string[];
  mentions?: string[];
  tags?: string[];
  excerpt: L;
}

const NOTES: NoteSpec[] = [
  { key: "atlas", folder: l("", ""), title: l("Atlas", "Atlas"), links: ["arch", "roadmap", "checkout", "passkeys", "offline", "search", "team"], tags: ["projekt"], excerpt: l("Startseite des Projekts: Ziele, Teams, wichtigste Links.", "Project home: goals, team, most important links.") },
  { key: "team", folder: l("", ""), title: l("Team", "Team"), links: ["atlas"], excerpt: l("Alex (Entwicklung), Sam (Backend), Nyx (Assistenz).", "Alex (development), Sam (backend), Nyx (assistant).") },
  { key: "arch", folder: l("Architektur", "Architecture"), title: l("Architektur", "Architecture"), links: ["api", "web", "mobile", "db"], tags: ["architektur"], excerpt: l("Drei Apps, eine API, eine Datenbank. Redis für Sessions und Challenges.", "Three apps, one API, one database. Redis for sessions and challenges.") },
  { key: "api", folder: l("Architektur", "Architecture"), title: l("API", "API"), links: ["ratelimits", "errors", "webhooks", "idempotency", "db"], excerpt: l("REST-API mit Hono, Auth über Sessions und bald Passkeys.", "REST API with Hono, auth via sessions and soon passkeys.") },
  { key: "web", folder: l("Architektur", "Architecture"), title: l("Web-App", "Web app"), links: ["checkout", "images", "search", "perf"], excerpt: l("Next.js, Server-Komponenten, Bilder über eigenen Loader.", "Next.js, server components, images via a custom loader.") },
  { key: "mobile", folder: l("Architektur", "Architecture"), title: l("Mobile-App", "Mobile app"), links: ["offline", "push", "map"], excerpt: l("Expo-App für iOS und Android, Offline zuerst.", "Expo app for iOS and Android, offline first.") },
  { key: "db", folder: l("Architektur", "Architecture"), title: l("Datenbank", "Database"), links: ["migrations", "backups"], excerpt: l("Postgres 17, Migrationen nummeriert, tägliches Backup.", "Postgres 17, numbered migrations, daily backup.") },
  { key: "checkout", folder: l("Projekte", "Projects"), title: l("Checkout v2", "Checkout v2"), links: ["web", "dec-coupons", "release"], mentions: ["checkout-stepper", "coupon-codes"], tags: ["release-2.3"], excerpt: l("Neuer Checkout in vier Schritten mit Gutscheinen und 3-D-Secure.", "New four-step checkout with coupons and 3-D Secure.") },
  { key: "passkeys", folder: l("Projekte", "Projects"), title: l("Passkey-Login", "Passkey login"), links: ["api", "dec-challenge", "release"], mentions: ["passkey-register", "passkey-research"], tags: ["release-2.3"], excerpt: l("Anmeldung ohne Passwort, E-Mail-Link als Rückfall.", "Passwordless sign-in, email link as fallback.") },
  { key: "offline", folder: l("Projekte", "Projects"), title: l("Offline-Sync", "Offline sync"), links: ["mobile", "idempotency", "conflicts"], mentions: ["offline-queue", "sync-conflicts"], excerpt: l("Bestellungen und Merkliste funktionieren ohne Netz.", "Orders and wishlist work without a network.") },
  { key: "search", folder: l("Projekte", "Projects"), title: l("Suche", "Search"), links: ["web"], mentions: ["search-index"], excerpt: l("Tippfehler-Toleranz, Synonyme, Ranking.", "Typo tolerance, synonyms, ranking.") },
  { key: "dec-challenge", folder: l("Entscheidungen", "Decisions"), title: l("Challenge-Speicher", "Challenge store"), links: ["passkeys", "arch"], mentions: ["passkey-register"], excerpt: l("Offen: Redis (TTL) oder Postgres (Aufräum-Job).", "Open: Redis (TTL) or Postgres (cleanup job).") },
  { key: "dec-coupons", folder: l("Entscheidungen", "Decisions"), title: l("Gutscheine im Warenkorb", "Coupons in the cart"), links: ["checkout"], excerpt: l("Gutscheine im Warenkorb statt erst bei der Zahlung.", "Coupons in the cart instead of at payment.") },
  { key: "dec-pricing", folder: l("Entscheidungen", "Decisions"), title: l("Preismodell Pro-Plan", "Pro plan pricing"), links: ["roadmap"], mentions: ["pricing-meeting"], excerpt: l("Monatspreis mit Kontingent, darüber pro Bestellung.", "Monthly price with a quota, per order above it.") },
  { key: "roadmap", folder: l("Planung", "Planning"), title: l("Roadmap Q4", "Q4 roadmap"), links: ["checkout", "passkeys", "offline", "search", "release"], mentions: ["roadmap-q4"], excerpt: l("2.3: Checkout, Passkeys, Offline. 2.4: Suche, Dark Mode.", "2.3: checkout, passkeys, offline. 2.4: search, dark mode.") },
  { key: "release", folder: l("Planung", "Planning"), title: l("Release 2.3", "Release 2.3"), links: ["roadmap", "checkout", "passkeys"], excerpt: l("Ziel: Ende des Monats. Freeze eine Woche vorher.", "Target: end of the month. Freeze one week before.") },
  { key: "audit-rl", folder: l("Audits", "Audits"), title: l("Audit Rate-Limits", "Audit rate limits"), links: ["api", "ratelimits", "errors"], mentions: ["rate-limit-audit"], excerpt: l("4 Endpunkte ohne Limit, 7 uneinheitliche Fehlercodes.", "4 endpoints without a limit, 7 inconsistent error codes.") },
  { key: "audit-a11y", folder: l("Audits", "Audits"), title: l("Audit Barrierefreiheit", "Audit accessibility"), links: ["web"], mentions: ["a11y-review"], excerpt: l("5 Befunde in der Navigation.", "5 findings in the navigation.") },
  { key: "audit-priv", folder: l("Audits", "Audits"), title: l("Audit Export-Datenschutz", "Audit export privacy"), links: ["api"], mentions: ["export-privacy-audit"], excerpt: l("Interne Notizen und IP aus dem Export entfernt.", "Internal notes and IP removed from the export.") },
  { key: "ratelimits", folder: l("Wissen", "Knowledge"), title: l("Rate-Limits", "Rate limits"), links: ["api"], excerpt: l("Token-Bucket je Konto, Retry-After immer mitsenden.", "Token bucket per account, always send Retry-After.") },
  { key: "errors", folder: l("Wissen", "Knowledge"), title: l("Fehlercodes", "Error codes"), links: ["api"], excerpt: l("422 für Validierung, immer JSON mit `code`.", "422 for validation, always JSON with `code`.") },
  { key: "webhooks", folder: l("Wissen", "Knowledge"), title: l("Webhooks", "Webhooks"), links: ["api"], mentions: ["webhook-retries"], excerpt: l("5 Versuche: 1 s, 5 s, 30 s, 2 min, 10 min.", "5 attempts: 1 s, 5 s, 30 s, 2 min, 10 min.") },
  { key: "idempotency", folder: l("Wissen", "Knowledge"), title: l("Idempotenz", "Idempotency"), links: ["api", "offline"], mentions: ["idempotency-keys"], excerpt: l("Schlüssel im Header, 24 h gültig.", "Key in a header, valid for 24 h.") },
  { key: "migrations", folder: l("Wissen", "Knowledge"), title: l("Migrationen", "Migrations"), links: ["db", "backups"], mentions: ["deploy-staging"], excerpt: l("Nie ohne Backup. Eine Session gleichzeitig.", "Never without a backup. One session at a time.") },
  { key: "backups", folder: l("Wissen", "Knowledge"), title: l("Backups", "Backups"), links: ["db"], mentions: ["backups-logs"], excerpt: l("Täglich 03:00, 7 Tage aufbewahrt.", "Daily at 03:00, kept for 7 days.") },
  { key: "perf", folder: l("Wissen", "Knowledge"), title: l("Performance", "Performance"), links: ["images", "web"], mentions: ["lcp-performance"], excerpt: l("LCP-Ziel < 2 s auf Mobil.", "LCP target < 2 s on mobile.") },
  { key: "images", folder: l("Wissen", "Knowledge"), title: l("Bildformate", "Image formats"), links: ["perf"], mentions: ["product-images", "avif-research"], excerpt: l("AVIF mit WebP-Rückfall, Kodierung beim Upload.", "AVIF with WebP fallback, encode on upload.") },
  { key: "push", folder: l("Wissen", "Knowledge"), title: l("Push", "Push"), links: ["mobile"], mentions: ["push-notifications"], excerpt: l("Bestellstatus per Push, Lieferzeit folgt.", "Order status via push, delivery time follows.") },
  { key: "map", folder: l("Wissen", "Knowledge"), title: l("Karte", "Map"), links: ["mobile"], mentions: ["android-map-crash"], excerpt: l("Berechtigung erst nach `mapReady` abfragen.", "Ask for the permission only after `mapReady`.") },
  { key: "conflicts", folder: l("Wissen", "Knowledge"), title: l("Konfliktauflösung", "Conflict resolution"), links: ["offline"], mentions: ["sync-conflicts"], excerpt: l("Merkliste: Vereinigung; Mengen: letzte Änderung gewinnt.", "Wishlist: union; quantities: last write wins.") },
];

export interface DemoVaultNote {
  path: string;
  title: string;
  folder: string;
  links: string[];
  mentionKeys: string[];
  tags: string[];
  excerpt: string;
  size: number;
  mtimeMin: number;
}

export function demoVault(lang: Lang): DemoVaultNote[] {
  const byKey = new Map(NOTES.map((n) => [n.key, n]));
  const titleOf = (key: string) => {
    const n = byKey.get(key);
    return n ? pick(n.title, lang) : key;
  };
  return NOTES.map((n, i) => {
    const folder = pick(n.folder, lang);
    const title = pick(n.title, lang);
    const excerpt = pick(n.excerpt, lang);
    return {
      path: folder ? `${folder}/${title}.md` : `${title}.md`,
      title,
      folder,
      links: n.links.map(titleOf),
      mentionKeys: (n.mentions ?? []).filter((k) => SESSIONS.some((s) => s.key === k)),
      tags: n.tags ?? [],
      excerpt,
      size: 400 + excerpt.length * 9,
      mtimeMin: (i * 173) % (20 * DAY),
    };
  });
}

// ─────────────────────────────── agents & skills ───────────────────────────────

export function demoAgents(lang: Lang): { name: string; description: string; source: "user" | "project"; model: string; tools: string[]; color: string; prompt: string }[] {
  const tr = (de: string, en: string) => pick(l(de, en), lang);
  return [
    {
      name: "test-critic",
      description: tr("Prüft Tests auf fehlende Randfälle und gibt ein Urteil: PASS, PASS_WITH_NOTES oder BLOCK.", "Reviews tests for missing edge cases and gives a verdict: PASS, PASS_WITH_NOTES or BLOCK."),
      source: "user",
      model: "claude-sonnet-5",
      tools: ["Read", "Grep", "Glob", "Bash"],
      color: "orange",
      prompt: tr("Du bist ein strenger Test-Kritiker. Suche fehlende Randfälle und schließe mit PASS, PASS_WITH_NOTES oder BLOCK.", "You are a strict test critic. Look for missing edge cases and finish with PASS, PASS_WITH_NOTES or BLOCK."),
    },
    {
      name: "code-reviewer",
      description: tr("Code-Review auf Fehler, Lesbarkeit und Sicherheit.", "Code review for bugs, readability and security."),
      source: "user",
      model: "claude-opus-5-5",
      tools: ["Read", "Grep", "Glob"],
      color: "blue",
      prompt: tr("Prüfe die Änderungen gründlich. Nenne nur echte Probleme, jeweils mit Datei und Zeile.", "Review the changes thoroughly. Only report real problems, each with file and line."),
    },
    {
      name: "explorer",
      description: tr("Liest sich schnell in fremden Code ein und fasst zusammen.", "Quickly reads into unfamiliar code and summarizes."),
      source: "project",
      model: "claude-haiku-4-5",
      tools: ["Read", "Grep", "Glob"],
      color: "green",
      prompt: tr("Finde die relevanten Stellen und fasse sie in höchstens zehn Sätzen zusammen.", "Find the relevant places and summarize them in at most ten sentences."),
    },
    {
      name: "docs-writer",
      description: tr("Schreibt und aktualisiert Doku nach einer Änderung.", "Writes and updates docs after a change."),
      source: "project",
      model: "claude-sonnet-5",
      tools: ["Read", "Edit", "Write"],
      color: "purple",
      prompt: tr("Aktualisiere die Doku passend zur Änderung, kurz und mit Beispielen.", "Update the docs to match the change, short and with examples."),
    },
  ];
}

export function demoSkills(lang: Lang): { key: string; name: string; description: string; source: "user" | "plugin"; plugin: string | null; content: string; improved?: string }[] {
  const tr = (de: string, en: string) => pick(l(de, en), lang);
  const md = (name: string, desc: string, body: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`;
  const skill = (key: string, desc: string, body: string, source: "user" | "plugin" = "user", plugin: string | null = null, improved?: string) => ({
    key,
    name: key,
    description: desc,
    source,
    plugin,
    content: md(key, desc, body),
    improved: improved ? md(key, desc, improved) : undefined,
  });
  return [
    skill(
      "audit",
      tr("Strukturiertes Audit mit Befunden, Schwere und Maßnahmen.", "Structured audit with findings, severity and actions."),
      tr("1. Umfang klären\n2. Befunde mit Datei und Schwere (p0–p3) sammeln\n3. Bericht unter docs/audits/ ablegen", "1. Clarify the scope\n2. Collect findings with file and severity (p0–p3)\n3. Store the report under docs/audits/"),
    ),
    skill(
      "deploy",
      tr("Deploy nach Staging oder Produktion – immer mit Backup vorher.", "Deploy to staging or production – always with a backup first."),
      tr("1. Backup\n2. ./scripts/deploy.sh <umgebung> <dienst>\n3. Health-Check", "1. Backup\n2. ./scripts/deploy.sh <env> <service>\n3. Health check"),
      "user",
      null,
      tr("1. Backup\n2. Migrationen prüfen (nur eine Session!)\n3. ./scripts/deploy.sh <umgebung> <dienst>\n4. Health-Check und Log-Blick", "1. Backup\n2. Check migrations (one session only!)\n3. ./scripts/deploy.sh <env> <service>\n4. Health check and a look at the logs"),
    ),
    skill("tdd", tr("Erst ein roter Test, dann der Fix.", "Red test first, then the fix."), tr("Schreib zuerst einen fehlschlagenden Test, dann den kleinsten Fix, dann aufräumen.", "Write a failing test first, then the smallest fix, then clean up.")),
    skill("frontend-design", tr("Gestaltung von Oberflächen mit Tokens, Zuständen und Barrierefreiheit.", "Interface design with tokens, states and accessibility."), tr("Leere, Lade- und Fehlerzustände immer mitbauen.", "Always build empty, loading and error states."), "plugin", "design-kit"),
    skill("brainstorm", tr("Optionen sammeln, bewerten und eine Empfehlung geben.", "Collect options, rate them and give a recommendation."), tr("Höchstens drei Optionen, jede mit Aufwand und Risiko, am Ende eine Empfehlung.", "At most three options, each with effort and risk, and a recommendation at the end."), "plugin", "thinking"),
    skill("release-notes", tr("Release-Notes aus Commits und Aufgaben schreiben.", "Write release notes from commits and tasks."), tr("Gruppiert nach Neu, Verbessert, Behoben.", "Grouped by new, improved, fixed.")),
  ];
}

export function demoSkillSuggestion(lang: Lang): { skillKey: string; signal: string; problem: string; evidence: string; idea: string } {
  const tr = (de: string, en: string) => pick(l(de, en), lang);
  return {
    skillKey: "deploy",
    signal: "korrektur",
    problem: tr("Nach dem Skill musste die Migration von Hand geprüft werden.", "After the skill the migration had to be checked by hand."),
    evidence: tr("Session „Deploy Staging“: Rückfrage zur Migration 0042 nach dem Deploy-Schritt.", "Session “Deploy staging”: follow-up question about migration 0042 after the deploy step."),
    idea: tr("Schritt „Migrationen prüfen“ vor dem Deploy ergänzen.", "Add a “check migrations” step before the deploy."),
  };
}

export function demoSessionAudits(lang: Lang): { session: string; result: unknown }[] {
  const tr = (de: string, en: string) => pick(l(de, en), lang);
  return [
    {
      session: "webhook-retries",
      result: {
        zusammenfassung: tr("Webhooks werden jetzt bis zu fünfmal wiederholt und jeder Versuch protokolliert.", "Webhooks are now retried up to five times and every attempt is logged."),
        gemacht: [tr("Wiederholungen mit Backoff", "Retries with backoff"), tr("Tabelle webhook_log (Migration 0044)", "Table webhook_log (migration 0044)"), tr("Tests, Commit", "Tests, commit")],
        erledigt: [tr("Webhooks gehen nicht mehr verloren", "Webhooks no longer get lost")],
        offen: [tr("Alte Protokolle nach 30 Tagen löschen", "Delete old log rows after 30 days")],
        qualitaet: { note: "gut", text: tr("Sauber getestet, Test-Kritiker ohne Einwände.", "Well tested, test critic had no objections.") },
        risiken: [tr("Die Protokoll-Tabelle wächst ohne Aufräumen schnell.", "The log table grows quickly without cleanup.")],
      },
    },
    {
      session: "rate-limit-audit",
      result: {
        zusammenfassung: tr("Audit der API: vier Endpunkte ohne Rate-Limit, sieben uneinheitliche Fehlercodes.", "API audit: four endpoints without a rate limit, seven inconsistent error codes."),
        gemacht: [tr("Alle Routen geprüft", "Checked all routes"), tr("Fehlercodes mit docs/errors.md verglichen", "Compared error codes with docs/errors.md"), tr("Bericht geschrieben", "Wrote the report")],
        erledigt: [tr("Bericht unter docs/audits/", "Report in docs/audits/")],
        offen: [tr("Befunde umsetzen (5 Aufgaben)", "Implement the findings (5 tasks)"), tr("Entscheidung: welcher Befund zuerst", "Decision: which finding first")],
        qualitaet: { note: "mittel", text: tr("Gründlich, aber ohne Messung der tatsächlichen Last.", "Thorough, but without measuring the real load.") },
        risiken: [tr("/export ist bis zum Fix leicht zu missbrauchen.", "/export is easy to abuse until it is fixed.")],
      },
    },
  ];
}

/** Nyx calls per day (cost display, "Nyx today" tile): kind, minutes ago, cost in USD. */
export function demoHaikuCalls(): { kind: string; min: number; cost: number; tokensIn: number; tokensOut: number; durationMs: number }[] {
  const out: { kind: string; min: number; cost: number; tokensIn: number; tokensOut: number; durationMs: number }[] = [];
  const kinds = ["chat", "chat", "rundgang", "briefing", "sortierung", "chat", "recap", "rundgang"];
  for (let d = 0; d < 14; d++) {
    const n = d === 0 ? 6 : 4 + ((d * 7) % 5);
    for (let i = 0; i < n; i++) {
      const kind = kinds[(d + i) % kinds.length] ?? "chat";
      const tokensIn = 6_000 + ((d * 131 + i * 977) % 18_000);
      const tokensOut = 300 + ((d * 17 + i * 211) % 1_400);
      out.push({ kind, min: d * DAY + 20 + i * 70, cost: Math.round((tokensIn * 1e-6 + tokensOut * 5e-6) * 10_000) / 10_000, tokensIn, tokensOut, durationMs: 2_000 + ((i * 1_337) % 9_000) });
    }
  }
  return out;
}
