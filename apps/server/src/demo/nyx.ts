// Demo mode: how Nyx answers in the demo instance.
// - "ai": this computer has a signed-in Claude program → Nyx runs normally (read-only tools, see readonly.ts).
// - "scripted": no AI available → a small stand-in engine answers the suggested questions with prepared texts
//   about the invented "Atlas" workspace (German and English), everything else with a friendly default.
// The stand-in is a real `HaikuEngine`, so the answer takes the normal chat path (thread, stream, sources, status).
import { spawn } from "node:child_process";
import { getLang, modelName, pick, type Lang } from "@nyxos/shared";
import { gte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { haikuSettings, usageDaily } from "../db/schema.js";
import type { EngineAvailability, EngineEvent, EngineRequest, HaikuEngine } from "../haiku/engine.js";
import { messageLanguage } from "../nyx/prompt.js";
import { addDays, localDay } from "../usage/periods.js";
import { demoSessionId } from "./build-sessions.js";
import { l, type L } from "./text.js";

export type DemoEngineKind = "ai" | "scripted";

/** Marker Nyx uses for a source; the runtime turns it into a numbered, clickable reference. */
const session = (key: string) => `[[session:${demoSessionId(key)}]]`;

interface DemoTopic {
  question: L;
  /** Lower-case word stems; a message matches a topic by how many of them it contains. */
  keywords: string[];
  answer: (db: Db) => Promise<L>;
}

const fixed = (text: L) => async () => text;

/** Money in the language's usual way ("12,40 $" / "$12.40"). */
function usd(n: number, lang: Lang): string {
  return lang === "de" ? `${n.toFixed(2).replace(".", ",")} $` : `$${n.toFixed(2)}`;
}

async function costAnswer(db: Db): Promise<L> {
  const today = localDay(new Date());
  const weekStart = addDays(today, -6);
  const rows = await db
    .select({ day: usageDaily.day, model: usageDaily.model, cost: sql<number>`coalesce(sum(${usageDaily.cost}), 0)::float8` })
    .from(usageDaily)
    .where(gte(usageDaily.day, addDays(today, -29)))
    .groupBy(usageDaily.day, usageDaily.model);
  const sum = (from: string) => rows.filter((r) => r.day >= from).reduce((a, r) => a + Number(r.cost), 0);
  const day = sum(today);
  const week = sum(weekStart);
  const month = sum(addDays(today, -29));
  const byModel = new Map<string, number>();
  for (const r of rows) if (r.day >= weekStart && r.model) byModel.set(r.model, (byModel.get(r.model) ?? 0) + Number(r.cost));
  const [top] = [...byModel.entries()].sort((a, b) => b[1] - a[1]);
  const share = top && week > 0 ? Math.round((top[1] / week) * 100) : null;
  const text = (lang: Lang) => {
    const head =
      lang === "de"
        ? `Heute bisher **${usd(day, lang)}**, in den letzten 7 Tagen **${usd(week, lang)}** (im Schnitt ${usd(week / 7, lang)} pro Tag), in 30 Tagen ${usd(month, lang)}.`
        : `So far today **${usd(day, lang)}**, in the last 7 days **${usd(week, lang)}** (on average ${usd(week / 7, lang)} a day), in 30 days ${usd(month, lang)}.`;
    const model =
      top && share !== null
        ? lang === "de"
          ? ` Den größten Teil der Woche macht ${modelName(top[0])} aus (${share} %).`
          : ` Most of the week is ${modelName(top[0])} (${share} %).`
        : "";
    const tail = lang === "de" ? " Die Beträge sind der API-Gegenwert; Einzelheiten je Modell und Projekt stehen im Tab „Nutzung“." : " The amounts are the API equivalent; details per model and project are in the “Usage” tab.";
    return head + model + tail;
  };
  return { de: text("de"), en: text("en") };
}

const TOPICS: DemoTopic[] = [
  {
    question: l("Was wartet heute auf mich?", "What is waiting for me today?"),
    keywords: ["heute", "wartet", "warten", "ansteh", "steht an", "today", "waiting", "wait", "on my plate", "brauch", "need me"],
    answer: fixed(
      l(
        `Drei Dinge brauchen dich:\n\n1. Die Passkey-Session will wissen, ob die Challenge in **Redis oder Postgres** liegen soll ${session("passkey-register")} – ich würde Redis nehmen.\n2. Das **API-Audit** fragt, welcher Befund zuerst drankommt: das Limit für /export oder die 422-Codes ${session("rate-limit-audit")}.\n3. Die **Android-Session ist abgestürzt**, der Fix für den Kartenstart liegt aber schon da ${session("android-map-crash")}.\n\nAußerdem wartet die LCP-Session auf dein Okay ${session("lcp-performance")}. Checkout v2 und die Offline-Warteschlange laufen von selbst weiter.`,
        `Three things need you:\n\n1. The passkey session wants to know whether the challenge should live in **Redis or Postgres** ${session("passkey-register")} – I'd go with Redis.\n2. The **API audit** asks which finding comes first: the /export limit or the 422 codes ${session("rate-limit-audit")}.\n3. The **Android session crashed**, but the fix for the map start is already written ${session("android-map-crash")}.\n\nThe LCP session is also waiting for your okay ${session("lcp-performance")}. Checkout v2 and the offline queue keep running on their own.`,
      ),
    ),
  },
  {
    question: l("Welche Session ist abgestürzt und warum?", "Which session crashed and why?"),
    keywords: ["absturz", "abgestürzt", "abgestuerzt", "crash", "kaputt", "fehler", "broken", "failed", "android", "karte", "map"],
    answer: fixed(
      l(
        `Die Session **„Absturz beim Kartenstart auf Android beheben“** ${session("android-map-crash")}. Die App fragt die Standort-Berechtigung ab, bevor die Karte bereit ist – auf Android 15 stürzt sie dabei ab. Die Session hatte den Fix schon in \`app/(tabs)/map.tsx\` geschrieben (Berechtigung erst nach \`mapReady\`) und den Release-Build gestartet, dann brach sie ab. Der Fix ist noch nicht committet. Mein Vorschlag: Session fortsetzen und nur den Build wiederholen.`,
        `The session **“Fix crash when the map starts on Android”** ${session("android-map-crash")}. The app asks for the location permission before the map is ready – on Android 15 that crashes it. The session had already written the fix in \`app/(tabs)/map.tsx\` (ask only after \`mapReady\`) and started the release build, then it stopped. The fix is not committed yet. My suggestion: resume the session and just repeat the build.`,
      ),
    ),
  },
  {
    question: l("Was hat das Team diese Woche geschafft?", "What did the team get done this week?"),
    keywords: ["geschafft", "erledigt", "fertig", "woche", "done", "finished", "week", "shipped", "achieved", "accomplish", "erreicht"],
    answer: fixed(
      l(
        `Eine ganze Menge:\n\n- **Webhooks** werden jetzt bis zu 5× mit Backoff wiederholt, jeder Versuch steht im Protokoll ${session("webhook-retries")}.\n- **Staging** läuft mit v2.3.0-rc2, Migration 0042 ging in 3 Sekunden durch ${session("deploy-staging")}.\n- **Doppelte Bestellungen** sind per Idempotenz-Schlüssel verhindert ${session("idempotency-keys")}.\n- **Preisberechnung**: 14 neue Tests, dabei ein Rundungsfehler bei 19 % Steuer gefunden und behoben ${session("pricing-tests")}.\n- **Gutscheincodes** im Checkout sind fertig ${session("coupon-codes")}.\n\nDazu kamen die Recherche zu AVIF und die Roadmap für Q4.`,
        `Quite a lot:\n\n- **Webhooks** are now retried up to 5× with backoff, every attempt is logged ${session("webhook-retries")}.\n- **Staging** runs v2.3.0-rc2, migration 0042 went through in 3 seconds ${session("deploy-staging")}.\n- **Duplicate orders** are prevented with idempotency keys ${session("idempotency-keys")}.\n- **Price calculation**: 14 new tests, which found and fixed a rounding bug at 19 % tax ${session("pricing-tests")}.\n- **Coupon codes** in checkout are done ${session("coupon-codes")}.\n\nOn top of that: the AVIF research and the Q4 roadmap.`,
      ),
    ),
  },
  {
    question: l("Wo gibt es Konflikte?", "Where are there conflicts?"),
    keywords: ["konflikt", "kollision", "gleiche datei", "gleichzeitig", "conflict", "collision", "same file", "overlap", "clash"],
    answer: fixed(
      l(
        `Ein echter Konflikt, zwei Dateien: **Produktbilder** ${session("product-images")} und **LCP unter 2 Sekunden** ${session("lcp-performance")} schreiben gleichzeitig in \`src/lib/images.ts\` und \`next.config.mjs\` im Web-Projekt – die eine baut responsive Größen ein, die andere stellt auf AVIF um. Mein Vorschlag: erst die Produktbilder fertig werden lassen, danach die LCP-Session neu aufsetzen. Frühere Überschneidungen (z. B. \`tokens.css\`, \`deploy.sh\`) sind erledigt. Alles Weitere steht im Tab „Konflikte“.`,
        `One real conflict, two files: **Product images** ${session("product-images")} and **home page LCP under 2 seconds** ${session("lcp-performance")} are writing \`src/lib/images.ts\` and \`next.config.mjs\` in the web project at the same time – one adds responsive sizes, the other switches to AVIF. My suggestion: let the product images finish first, then rebase the LCP session. Earlier overlaps (e.g. \`tokens.css\`, \`deploy.sh\`) are resolved. Everything else is in the “Conflicts” tab.`,
      ),
    ),
  },
  {
    question: l("Welche Aufgaben sind startklar?", "Which tasks are ready to start?"),
    keywords: ["startklar", "bereit", "starten", "aufgabe", "als nächstes", "naechst", "nächst", "ready", "start", "task", "next", "backlog"],
    answer: fixed(
      l(
        `Drei Aufgaben sind startklar – Ziel, Abnahme und Dateien sind klar, eine Session kann sofort loslegen:\n\n- **Rate-Limit für /export** – der kritischste Befund aus dem API-Audit ${session("rate-limit-audit")}.\n- **Fehlercodes vereinheitlichen (422 bei Validierung)** – ebenfalls aus dem Audit, die Web-App reagiert auf diese Codes.\n- **Log-Rotation mit Komprimierung** – aus dem Server-Check: 2,1 GB Logs könnten auf etwa 300 MB schrumpfen ${session("backups-logs")}.\n\nAls Nächstes wird **Checkout v2: Zahlungsschritt mit 3-D-Secure** reif, sobald die Schritt-Leiste fertig ist ${session("checkout-stepper")}. Starten kannst du Aufgaben im Tab „Aufgaben“ mit einem Klick.`,
        `Three tasks are ready – goal, acceptance and files are clear, a session can start right away:\n\n- **Rate limit for /export** – the most critical finding of the API audit ${session("rate-limit-audit")}.\n- **Unify error codes (422 for validation)** – also from the audit, the web app reacts to these codes.\n- **Log rotation with compression** – from the server check: 2.1 GB of logs could shrink to about 300 MB ${session("backups-logs")}.\n\nNext up is **Checkout v2: payment step with 3-D Secure**, once the step bar is done ${session("checkout-stepper")}. You start tasks in the “Tasks” tab with one click.`,
      ),
    ),
  },
  {
    question: l("Was kostet uns das gerade?", "What is this costing us right now?"),
    keywords: ["kost", "kosten", "geld", "ausgaben", "budget", "token", "preis", "teuer", "cost", "spend", "money", "price", "expensive", "usage", "nutzung"],
    answer: costAnswer,
  },
  {
    question: l("Was läuft gerade?", "What is running right now?"),
    keywords: ["läuft", "laeuft", "aktiv", "aktuell", "running", "active", "right now", "currently", "status", "überblick", "overview"],
    answer: fixed(
      l(
        `Zwei Sessions arbeiten gerade: **Checkout v2** baut die Schritt-Leiste und das Adressformular ${session("checkout-stepper")}, und die **Offline-Warteschlange** kümmert sich um doppelte Bestellungen ${session("offline-queue")}. Drei warten auf dich (Passkeys, API-Audit, LCP), eine ruht (Produktbilder) und eine ist abgestürzt (Android-Karte) ${session("android-map-crash")}.`,
        `Two sessions are working right now: **Checkout v2** is building the step bar and the address form ${session("checkout-stepper")}, and the **offline queue** is handling duplicate orders ${session("offline-queue")}. Three are waiting for you (passkeys, API audit, LCP), one is idle (product images) and one crashed (Android map) ${session("android-map-crash")}.`,
      ),
    ),
  },
  {
    question: l("Redis oder Postgres für die Passkeys?", "Redis or Postgres for the passkeys?"),
    keywords: ["passkey", "redis", "postgres", "challenge", "webauthn", "login", "anmeldung"],
    answer: fixed(
      l(
        `Redis. Die Challenge lebt nur 5 Minuten, Redis löscht sie per TTL von selbst, und ihr nutzt Redis schon für Sessions ${session("passkey-register")}. Postgres ginge auch, bräuchte aber einen Aufräum-Job und eine weitere Migration. Einziger Haken: fällt Redis aus, kann sich niemand neu registrieren – bestehende Logins wären nicht betroffen.`,
        `Redis. The challenge only lives 5 minutes, Redis deletes it by itself with a TTL, and you already use Redis for sessions ${session("passkey-register")}. Postgres would work too but needs a cleanup job and another migration. The only catch: if Redis is down nobody can register a new passkey – existing logins are not affected.`,
      ),
    ),
  },
];

/** The suggested questions, in the app language (`GET /api/demo/questions`). */
export function demoQuestions(lang: Lang = getLang()): string[] {
  return TOPICS.map((topic) => pick(topic.question, lang));
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[„“”"'’?!.,:;()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Best matching topic for a message (a suggested question in either language, else most keyword hits), or null. */
function matchTopic(message: string): DemoTopic | null {
  const text = normalize(message);
  if (!text) return null;
  const exact = TOPICS.find((topic) => normalize(topic.question.de) === text || normalize(topic.question.en) === text);
  if (exact) return exact;
  let best: { topic: DemoTopic; score: number } | null = null;
  for (const topic of TOPICS) {
    const questionWords = new Set([...normalize(topic.question.de).split(" "), ...normalize(topic.question.en).split(" ")].filter((w) => w.length > 3));
    const words = text.split(" ");
    // Keywords are word stems: they must start a word ("kost" finds "kostet", "map" does not find "roadmap").
    const score = topic.keywords.filter((k) => ` ${text}`.includes(` ${k}`)).length * 2 + words.filter((w) => questionWords.has(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { topic, score };
  }
  return best?.topic ?? null;
}

const DEMO_NOTE = l(
  "_Vorbereitete Demo-Antwort. Wenn du NyxOS einrichtest, beantwortet Nyx jede Frage mit deiner KI._",
  "_Prepared demo answer. Once you set up NyxOS, Nyx answers every question with your AI._",
);

function fallback(lang: Lang): string {
  const list = demoQuestions(lang)
    .map((q) => `- ${q}`)
    .join("\n");
  return lang === "de"
    ? `In der Demo habe ich nur vorbereitete Antworten – echte KI ist hier nicht angeschlossen. Diese Fragen kann ich dir beantworten:\n\n${list}\n\nSobald du NyxOS einrichtest, beantwortet Nyx alles mit deiner KI.`
    : `In the demo I only have prepared answers – no real AI is connected here. I can answer these questions:\n\n${list}\n\nOnce you set up NyxOS, Nyx answers everything with your AI.`;
}

/** Prepared answer for a chat message (language of the message, else the app language). */
export async function scriptedAnswer(db: Db, message: string, appLang: Lang = getLang()): Promise<string> {
  const lang = messageLanguage(message, appLang);
  const topic = matchTopic(message);
  if (!topic) return fallback(lang);
  return `${pick(await topic.answer(db), lang)}\n\n${pick(DEMO_NOTE, lang)}`;
}

/** Nyx' stand-in engine in the demo without AI: answers chat turns with prepared texts, streamed in small pieces. */
export class ScriptedDemoEngine implements HaikuEngine {
  readonly kind = "api" as const;

  constructor(
    private readonly db: Db,
    private readonly opts: { chunkDelayMs?: number } = {},
  ) {}

  async available(): Promise<EngineAvailability> {
    return { ok: true, state: "ready", reason: null, model: null };
  }

  async *run(req: EngineRequest): AsyncIterable<EngineEvent> {
    const text = await scriptedAnswer(this.db, req.question ?? req.prompt);
    const delay = this.opts.chunkDelayMs ?? 12;
    // Word by word, like a real answer – the UI shows it growing.
    for (const piece of text.match(/\S+\s*/g) ?? []) {
      if (req.signal.aborted) break;
      yield { type: "delta", text: piece };
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
    yield { type: "result", text, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }, model: null, sessionId: null, isError: false, error: null };
  }
}

/** Rule added to Nyx' system prompt in the demo (only matters when a real AI answers). */
export const DEMO_SYSTEM_NOTE =
  "DEMO: Das hier ist die NyxOS-Demo mit erfundenen Daten (Projekt „Atlas“, Nutzer Alex). Du kannst alles lesen und erklären, aber nichts ändern: keine Einträge, Freigaben, Fragen, Pläne, Erinnerungen oder Aufgaben anlegen, nichts starten oder schließen. Bittet der Nutzer darum, sag freundlich, dass das nach dem Einrichten von NyxOS geht.";

/**
 * Engine for the demo: `NYXOS_DEMO_NYX=ai|scripted` forces it; otherwise "ai" when the Claude program on this
 * computer is signed in (`claude auth status`), else "scripted". Never throws, gives up after `timeoutMs`.
 */
export async function detectDemoEngine(opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<DemoEngineKind> {
  const env = opts.env ?? process.env;
  const forced = env.NYXOS_DEMO_NYX;
  if (forced === "ai" || forced === "scripted") return forced;
  const bin = env.CLAUDE_BIN ?? "claude";
  return new Promise<DemoEngineKind>((resolve) => {
    let out = "";
    let done = false;
    const finish = (kind: DemoEngineKind) => {
      if (done) return;
      done = true;
      resolve(kind);
    };
    try {
      const child = spawn(bin, ["auth", "status", "--json"], { env, stdio: ["ignore", "pipe", "ignore"] });
      child.stdout.on("data", (b: Buffer) => {
        if (out.length < 10_000) out += b.toString("utf8");
      });
      child.on("error", () => finish("scripted"));
      child.on("close", (code) => {
        let loggedIn: boolean;
        try {
          loggedIn = code === 0 && (JSON.parse(out) as { loggedIn?: unknown }).loggedIn === true;
        } catch {
          loggedIn = false;
        }
        finish(loggedIn ? "ai" : "scripted");
      });
      setTimeout(() => {
        child.kill("SIGKILL");
        finish("scripted");
      }, opts.timeoutMs ?? 8000).unref();
    } catch {
      finish("scripted");
    }
  });
}

/** After seeding: Nyx is "on" in the demo (the seed keeps it off so no AI run happens while seeding). */
export async function enableDemoNyx(db: Db): Promise<void> {
  await db.insert(haikuSettings).values({ id: 1, engine: "claude-cli" }).onConflictDoUpdate({ target: haikuSettings.id, set: { engine: "claude-cli" } });
}
