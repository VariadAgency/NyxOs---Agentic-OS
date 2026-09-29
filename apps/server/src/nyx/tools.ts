// Neue Werkzeuge von Nyx im bestehenden Register (`haiku/tools.ts`, gleiche Umfangs-Prüfung auf dem Server).
// Beschreibungen nach Hermes Agent (`tools/memory_tool.py`, `tools/session_search_tool.py`, `tools/todo_tool.py`,
// `tools/cronjob_tools.py`; MIT, © 2025 Nous Research) übersetzt und gekürzt. Riskantes bleibt Freigabe-Karte
// (`freigabe_anfragen`); diese Werkzeuge schreiben nur Nyx' eigene Daten (Gedächtnis, Liste, Pläne, Ablage).
import {
  BRIDGE_CAP_SIMULATOR,
  NYX_HHMM_RE,
  NyxDeliverSchema,
  NyxMemoryCategorySchema,
  NyxPrecheckSchema,
  NyxScheduleModeSchema,
  NyxScheduleWhenSchema,
  type NyxTaskEvent,
  type SimulatorScreenshotResult,
  t,
} from "@nyxos/shared";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getChanges, resolveSince } from "../changes.js";
import type { Db } from "../db/client.js";
import { haikuThreads } from "../db/schema.js";
import type { ToolRegistry } from "../haiku/tools.js";
import { localStamp } from "../haiku/tools.js";
import { localDay, usageByDay } from "../haiku/settings.js";
import type { LiveHub } from "../live.js";
import type { BridgeHub } from "../terminal/bridgeHub.js";
import { listDeliveries } from "../push/log.js";
import { getUsageComparison } from "../usage/compare.js";
import { getUsageWindows } from "../usage/window.js";
import { applyMemoryOps, createSuggestion, MAX_MEMORY_FAILURES_PER_CALL, MemoryOpSchema } from "./memory.js";
import { getNyxFile, storeNyxFile } from "./files.js";
import { publishNyxTask } from "./live.js";
import { safeLink } from "./links.js";
import { createSchedule, deleteSchedule, getSchedule, listSchedules, patchSchedule, type NyxScheduleRunner } from "./schedules.js";
import { searchChats } from "./sessionSearch.js";
import { scanForThreats } from "./threats.js";
import { formatTodosForTool, getTodos, TodoItemInputSchema, todoTaskEvents, writeTodos } from "./todo.js";

export interface NyxToolDeps {
  hub: LiveHub;
  bridgeHub: BridgeHub | null;
  archiveDir: string | null;
  runner: () => NyxScheduleRunner | null;
  /** Kann eine Meldung gerade wirklich über Telegram raus? (sonst nichts versprechen) */
  telegramReady?: () => Promise<boolean>;
  /** Server-Tab-Stand (wird nach `registerServerRoutes` gesetzt); null = nicht verfügbar. */
  serverSnapshot: () => Promise<unknown> | null;
}

export const NYX_TOOL_NAMES = ["memory", "session_search", "todo", "schedule", "screenshot_simulator", "show_image", "show_link", "nutzung", "server_lage", "was_ist_neu", "mitteilungen_liste"] as const;

/** Aufgaben-Karten nur über den gemeinsamen, geprüften Weg (Tab, Begleiter, Telegram). */
const task = (hub: LiveHub, ev: NyxTaskEvent) => void publishNyxTask(hub, ev);
const newTaskId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

const ScheduleToolSchema = z.object({
  action: z.enum(["list", "create", "update", "pause", "resume", "remove", "run"]),
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(2).max(120).optional(),
  prompt: z.string().trim().min(2).max(2000).optional(),
  mode: NyxScheduleModeSchema.optional(),
  when: NyxScheduleWhenSchema.optional(),
  precheck: NyxPrecheckSchema.nullable().optional(),
  activeHours: z
    .object({ start: z.string().regex(NYX_HHMM_RE), end: z.string().regex(NYX_HHMM_RE) })
    .nullable()
    .optional(),
  deliver: NyxDeliverSchema.optional(),
});

export function registerNyxTools(reg: ToolRegistry, deps: NyxToolDeps): void {
  const memoryFailures = new Map<number, number>();

  reg.register({
    name: "memory",
    description:
      "Dauerhaftes Gedächtnis (gilt in JEDEM künftigen Gespräch, darum klein halten). WIE: alle Änderungen in EINEM Aufruf über operations (je {action: add|replace|remove, category: user|project|preference, content?, old_text?}); der Stapel wird ganz oder gar nicht angewendet, das Zeichen-Budget nur am Endergebnis geprüft – ein Aufruf kann also Altes entfernen/kürzen UND Neues hinzufügen. replace ersetzt den GANZEN Eintrag, old_text ist nur ein kurzer eindeutiger Teil zum Finden. WANN: nur Fakten, die immer gelten (wer der Nutzer ist, feste Umgebungs-Fakten, dauerhafte Vorlieben/Absprachen) oder wenn er „merk dir“ sagt. VOLL: ein add wird mit den aktuellen Einträgen abgelehnt – dann EIN Aufruf, der Veraltetes kürzt/entfernt und das Neue hinzufügt. NICHT: Kleinkram, Nachschlagbares, Aufgaben-Fortschritt, Erledigtes, To-dos. Die Antwort bestätigt den Abschluss – nicht wiederholen.",
    scopes: ["full"],
    input: z.object({ operations: z.array(MemoryOpSchema).min(1).max(12) }),
    handler: async (a, ctx) => {
      const failures = ctx.callId ? (memoryFailures.get(ctx.callId) ?? 0) : 0;
      if (failures >= MAX_MEMORY_FAILURES_PER_CALL) return { ok: false, abschluss: "Hör jetzt auf, das Gedächtnis zu ändern, und antworte dem Nutzer – sag kurz, dass es nicht geklappt hat." };
      const res = await applyMemoryOps(ctx.db, a.operations, { threadId: ctx.threadId, messageId: ctx.messageId, createdBy: "nyx" });
      if (!res.ok && ctx.callId) {
        memoryFailures.set(ctx.callId, failures + 1);
        while (memoryFailures.size > 200) memoryFailures.delete(memoryFailures.keys().next().value as number);
      }
      if (res.ok) {
        if (ctx.threadId) await ctx.db.update(haikuThreads).set({ turnsSinceMemory: 0 }).where(eq(haikuThreads.id, ctx.threadId));
        deps.hub.broadcast({ type: "nyx.memory", what: "entries" });
      }
      return res;
    },
  });

  reg.register({
    name: "memory_suggest",
    description:
      "Schlägt der Nutzer eine Gedächtnis-Änderung vor (er entscheidet). action add = neuer Fakt; replace = bestehenden Eintrag (old_text: eindeutiger Teil) durch fact ersetzen; remove = bestehenden Eintrag vergessen (old_text). category: user | project | preference. grund: ein kurzer Satz, warum.",
    scopes: ["review"],
    input: z.object({ action: z.enum(["add", "replace", "remove"]), category: NyxMemoryCategorySchema, fact: z.string().trim().min(3).max(600), old_text: z.string().trim().min(2).max(300).optional(), grund: z.string().trim().max(300).optional() }),
    handler: async (a, ctx) => {
      const r = await createSuggestion(ctx.db, { action: a.action, category: a.category, fact: a.fact, oldText: a.old_text ?? null, reason: a.grund ?? null, threadId: ctx.threadId });
      if (r.ok && !r.duplicate) deps.hub.broadcast({ type: "nyx.memory", what: "suggestions" });
      return r;
    },
  });

  reg.register({
    name: "session_search",
    description:
      "Durchsucht NUR frühere Chats mit dir (Nyx) – nicht die Claude-/Codex-Sessions (dafür sessions_suchen). Vier Formen: suche → beste Chats mit Ausschnitt (der beste mit Umgebung); faden → ganzen Chat lesen; faden + um_nachricht → um eine Stelle herum lesen; ohne alles → letzte Chats. Filter nach/vor: ISO-Datum oder relativ „24h“, „7d“, „2w“. Für „was hatten wir zu X besprochen“, „wo waren wir bei Y“. Nie aus dem Verlauf allein auf „gibt es nicht“ schließen.",
    scopes: ["full"],
    input: z.object({
      suche: z.string().trim().max(200).optional(),
      faden: z.number().int().positive().optional(),
      um_nachricht: z.number().int().positive().optional(),
      nach: z.string().max(40).optional(),
      vor: z.string().max(40).optional(),
      limit: z.number().int().min(1).max(10).optional(),
    }),
    handler: async (a, { db }) => searchChats(db, { query: a.suche, threadId: a.faden, aroundMessageId: a.um_nachricht, after: a.nach, before: a.vor, limit: a.limit }),
  });

  reg.register({
    name: "todo",
    description:
      "Aufgabenliste für mehrstufige Arbeit (3+ Schritte oder mehrere Bitten). Ohne Eingabe: Liste lesen. todos = [{id, content, status: pending|in_progress|completed|cancelled, evidence?}]; merge: true aktualisiert nach id, sonst wird die Liste ersetzt. Reihenfolge = Priorität. Genau EIN Eintrag in_progress, solange du arbeitest. completed nur nach Prüfung – mit evidence (womit geprüft), nie aus Absicht. Scheitert etwas: cancelled + neuer, geänderter Eintrag. Der Nutzer sieht die Liste live. Gibt immer die ganze Liste zurück.",
    scopes: ["full"],
    input: z.object({ todos: z.array(TodoItemInputSchema).max(50).optional(), merge: z.boolean().optional() }),
    handler: async (a, ctx) => {
      if (!ctx.threadId) return { fehler: "Eine Aufgabenliste gibt es nur in einem Gespräch." };
      if (!a.todos) return formatTodosForTool(await getTodos(ctx.db, ctx.threadId));
      const res = await writeTodos(ctx.db, ctx.threadId, { todos: a.todos, merge: a.merge });
      if (!res.ok) return { fehler: res.error, ...formatTodosForTool(res.list) };
      for (const ev of todoTaskEvents(res.list, res.changed)) task(deps.hub, ev);
      return formatTodosForTool(res.list);
    },
  });

  reg.register({
    name: "schedule",
    description:
      "Geplante Aufgaben. action list zeigt alle (IMMER zuerst, nie Nummern raten). create: name, prompt (für sich allein verständlich – beim Lauf gibt es keinen Chat), mode remind (nur erinnern, kein Modell) | run (du führst es aus und berichtest), when {type:'once', at: ISO mit Zeitzone | inMinutes} | {type:'cron', cron:'Min Std Tag Monat Wochentag' in Zeitzone des Nutzers, z. B. '0 7 * * *' = täglich 07:00} | {type:'event', event: build_red|session_waiting|session_closed|approval_open, filter?}, optional precheck (build_red|sessions_waiting|approvals_open|inbox_open: läuft nur, wenn zutreffend), activeHours {start,end}, deliver web|telegram|both. update/pause/resume/remove/run brauchen id; run startet sofort. Vorhandenes ändern statt Fast-Doppeltes anlegen. Täglicher Bericht = cron + mode run.",
    scopes: ["full"],
    input: ScheduleToolSchema,
    handler: async (a, ctx) => {
      const db: Db = ctx.db;
      if (a.action === "list") {
        const all = await listSchedules(db);
        return { gesamt: all.length, aufgaben: all.map((s) => ({ id: s.id, name: s.name, wann: s.describe, modus: s.mode, pausiert: s.paused, naechster_lauf: localStamp(s.nextRunAt), letzter_lauf: localStamp(s.lastRunAt), letzter_status: s.lastStatus })) };
      }
      // Kein Planen aus einem geplanten Lauf heraus (Hermes „RECURSION“) – serverseitig, nicht nur im Prompt.
      if (ctx.kind === "schedule" && a.action !== "run") return { fehler: "Aus einer geplanten Aufgabe heraus werden keine Pläne angelegt oder geändert." };
      if (ctx.kind === "schedule") return { fehler: "Eine geplante Aufgabe startet keine andere." };
      // Der Auftragstext läuft später unbeaufsichtigt mit vollem Werkzeug-Umfang – darum dieselbe
      // Bedrohungs-Prüfung wie beim Gedächtnis (sonst wird eingeschleuster Fremdtext zur Dauer-Anweisung).
      if (a.action === "create" || a.action === "update") {
        const threats = scanForThreats([a.name ?? "", a.prompt ?? ""].join("\n"), "strict");
        if (threats.length) return { fehler: `Dieser Auftrag sieht nach einer versteckten Anweisung oder einem Geheimnis aus (${threats.join(", ")}) – nicht gespeichert. Der Nutzer kann ihn im Nyx-Tab selbst anlegen.` };
      }
      // „auch in Telegram“ nur, wenn Telegram wirklich zustellen kann – sonst nur im Nyx-Tab.
      const wantsTelegram = a.deliver === "telegram" || a.deliver === "both";
      const telegramOk = wantsTelegram ? ((await deps.telegramReady?.()) ?? false) : true;
      const deliver = wantsTelegram && !telegramOk ? "web" : a.deliver;
      const telegramNote = telegramOk ? {} : { hinweis: "Telegram ist nicht verbunden – diese Meldung kommt nur im Nyx-Tab. Sag dem Nutzer das so und versprich kein Telegram." };
      if (a.action === "create") {
        if (!a.name || !a.prompt || !a.when) return { fehler: "Für create braucht es name, prompt und when." };
        const r = await createSchedule(db, { name: a.name, prompt: a.prompt, mode: a.mode ?? "remind", when: a.when, precheck: a.precheck ?? null, activeHours: a.activeHours ?? null, deliver: deliver ?? "web" }, { createdBy: "nyx", threadId: ctx.threadId });
        if (!r.ok) return { fehler: r.error };
        deps.hub.broadcast({ type: "nyx.schedule", id: r.schedule.id });
        return { angelegt: true, id: r.schedule.id, wann: r.schedule.describe, naechster_lauf: localStamp(r.schedule.nextRunAt), zustellung: r.schedule.deliver, ...telegramNote };
      }
      if (!a.id) return { fehler: "Welche Aufgabe? id fehlt – erst action list." };
      const row = await getSchedule(db, a.id);
      if (!row) return { fehler: `Aufgabe ${a.id} gibt es nicht – erst action list.` };
      if (a.action === "remove") {
        // Was der Nutzer selbst angelegt hat, löscht nur er (Tab oder Freigabe-Karte).
        if (row.createdBy !== "nyx") return { fehler: "Diese Aufgabe hat der Nutzer angelegt – löschen kann nur er (im Nyx-Tab). Pausieren geht." };
        await deleteSchedule(db, a.id);
        deps.hub.broadcast({ type: "nyx.schedule", id: a.id });
        return { entfernt: true };
      }
      if (a.action === "run") {
        const runner = deps.runner();
        if (!runner) return { fehler: "Geplante Aufgaben laufen gerade nicht." };
        // Nicht warten: der Lauf braucht einen Modell-Platz, den dieser Chat gerade selbst hält (Verklemmung).
        runner.runInBackground(a.id);
        return { gestartet: true, hinweis: "Läuft jetzt im Hintergrund – das Ergebnis kommt als Meldung (Nyx-Tab bzw. Telegram). Nicht noch einmal starten." };
      }
      const s = await patchSchedule(db, a.id, {
        ...(a.action === "pause" ? { paused: true } : a.action === "resume" ? { paused: false } : {}),
        ...(a.action === "update" ? { name: a.name, prompt: a.prompt, precheck: a.precheck, activeHours: a.activeHours, deliver } : {}),
      });
      deps.hub.broadcast({ type: "nyx.schedule", id: a.id });
      return s ? { ok: true, id: s.id, wann: s.describe, pausiert: s.paused, naechster_lauf: localStamp(s.nextRunAt), zustellung: s.deliver, ...(a.action === "update" ? telegramNote : {}) } : { fehler: "Nicht gefunden." };
    },
  });

  reg.register({
    name: "screenshot_simulator",
    description: "Macht ein Bildschirmfoto vom laufenden iOS-Simulator auf dem Rechner des Nutzers (über die Brücke) und zeigt es im Nyx-Tab und in Telegram. Läuft kein Simulator, sagt das Ergebnis das ehrlich.",
    scopes: ["full"],
    input: z.object({ titel: z.string().trim().max(120).optional() }),
    handler: async (a, ctx) => {
      const bridge = deps.bridgeHub;
      if (!bridge?.online) return { ok: false, hinweis: "Die Brücke ist gerade nicht verbunden – der Rechner ist aus, schläft oder offline. Sobald er wieder da ist, geht es." };
      if (!bridge.supports(BRIDGE_CAP_SIMULATOR)) return { ok: false, hinweis: "Die Brücke ist noch die ältere Fassung und kann keine Simulator-Bilder. Nach dem nächsten Brücken-Update geht es." };
      if (!deps.archiveDir) return { ok: false, hinweis: "Die Bild-Ablage ist gerade nicht verfügbar." };
      const taskId = newTaskId("simulator");
      const title = a.titel || t("Bild vom Simulator");
      const base = { taskId, title, tool: "screenshot_simulator", where: t("Brücke"), threadId: ctx.threadId ?? null } as const;
      task(deps.hub, { ...base, phase: "started", text: t("Mache ein Bild vom Simulator …") });
      const failed = (hinweis: string) => {
        task(deps.hub, { ...base, phase: "failed", text: hinweis });
        return { ok: false, hinweis };
      };
      const rpc = await bridge.rpc("simulator_screenshot", {}, 45_000);
      if (!rpc.ok) return failed(rpc.code === "timeout" ? t("Der Rechner hat nicht rechtzeitig geantwortet.") : t("Das Bild konnte nicht gemacht werden."));
      const r = rpc.result as SimulatorScreenshotResult;
      if (!r.ok) {
        return failed(
          r.reason === "no_simulator"
            ? t("Gerade läuft kein iOS-Simulator. Starte ihn in Xcode (oder sag mir, welche App ich bauen soll), dann mache ich das Bild.")
            : r.reason === "xcrun_missing"
              ? t("Auf dem Rechner fehlen die Xcode-Werkzeuge (xcrun) – ohne sie gibt es keine Simulator-Bilder.")
              : t("Das Bild konnte nicht gemacht werden."),
        );
      }
      const stamp = localStamp(new Date().toISOString()) ?? "";
      const caption = a.titel || `Simulator${r.device ? ` (${r.device})` : ""} · ${stamp}`;
      // EINE Ablage mit dem Nyx-Tab (`nyx_files`, Reiter „Bilder“, herunterladbar, nur angemeldet).
      const file = await storeNyxFile(ctx.db, deps.archiveDir, deps.hub, {
        bytes: Buffer.from(r.pngB64, "base64"),
        mime: "image/png",
        name: `simulator-${stamp.replace(/[^\dA-Za-z]+/g, "-").replace(/^-|-$/g, "")}.png`,
        title: caption,
        source: "simulator",
        threadId: ctx.threadId,
      });
      task(deps.hub, { ...base, phase: "done", text: caption, image: { fileId: file.id, title: caption } });
      return { ok: true, bild_id: file.id, titel: caption, geraet: r.device, hinweis: "Das Bild ist im Nyx-Tab unter „Bilder“ zu sehen (und geht an Telegram, wenn du dort schreibst)." };
    },
  });

  reg.register({
    name: "show_image",
    description: "Zeigt ein Bild aus der Ablage (bild_id, z. B. von screenshot_simulator oder ein Bild, das der Nutzer gegeben hat) im Nyx-Tab und in Telegram.",
    scopes: ["full"],
    input: z.object({ bild_id: z.number().int().positive(), titel: z.string().trim().max(120).optional() }),
    handler: async (a, ctx) => {
      const file = await getNyxFile(ctx.db, a.bild_id);
      if (!file || file.kind !== "image") return { ok: false, hinweis: "Dieses Bild gibt es nicht in der Ablage." };
      const title = a.titel || file.title || file.name;
      task(deps.hub, { taskId: newTaskId("bild"), phase: "done", title, tool: "show_image", threadId: ctx.threadId ?? null, image: { fileId: file.id, title } });
      return { ok: true, bild_id: file.id };
    },
  });

  reg.register({
    name: "show_link",
    description: "Legt einen Link sichtbar im Nyx-Tab (und in Telegram) ab – für lange Inhalte, statt sie vorzulesen. Nur https-Adressen oder NyxOS-Pfade wie /sessions/….",
    scopes: ["full"],
    input: z.object({ url: z.string().trim().min(1).max(2000), titel: z.string().trim().min(1).max(120) }),
    handler: async (a, ctx) => {
      const url = safeLink(a.url);
      if (!url) return { ok: false, hinweis: "Diese Adresse lege ich nicht ab (nur https oder NyxOS-Pfade)." };
      task(deps.hub, { taskId: newTaskId("link"), phase: "done", title: a.titel, tool: "show_link", threadId: ctx.threadId ?? null, link: { url, title: a.titel }, ...(url.startsWith("/") ? { href: url } : {}) });
      return { ok: true };
    },
  });

  // „Du hast mir gerade eine Mitteilung geschickt – worum ging es?“ Mitteilungen verschickt NyxOS in Nyx' Namen.
  reg.register({
    name: "mitteilungen_liste",
    description:
      "Die zuletzt verschickten Mitteilungen an den Nutzer (Handy über ntfy, Rechner, Browser, Telegram) – die schickt NyxOS in deinem Namen. Je Mitteilung: Zeit, Wege mit Ergebnis, Art, Titel, Text (gekürzt), zugestellt ja/nein, Grund (gesendet, Ruhezeit, Unter-Agent, Anlass aus, von dir weggelassen …), deine Prüfung/dein Text, die Rückmeldung des Nutzers (passt/brauche ich nicht), Sammel-Mitteilung ja/nein. Für „Was hast du mir gerade geschickt?“ und „Warum kam keine Mitteilung?“. Einstellungen dazu: app_api GET/PATCH /api/notifications/settings. Nur lesen.",
    scopes: ["full"],
    input: z.object({ anzahl: z.number().int().min(1).max(30).optional() }),
    handler: async (a, { db }) => {
      const mitteilungen = await listDeliveries(db, a.anzahl ?? 10, localStamp);
      return mitteilungen.length > 0 ? { mitteilungen } : { mitteilungen, hinweis: "Noch keine Mitteilung verschickt." };
    },
  });

  reg.register({
    name: "nutzung",
    description: "Nutzung von Claude und Codex (Tokens, API-Gegenwert) in dieser und der letzten Woche bzw. diesem Monat, dazu Nyx' eigene Läufe heute und das Limit-Fenster (Tokens der letzten 5 Std/7 Tage, Prozent nur wenn der Anbieter sie meldet). Für „Wie viel habe ich diese Woche verbraucht?“ und „Wie viel von meinem Limit?“.",
    scopes: ["full"],
    input: z.object({}),
    handler: async (_a, { db }) => {
      const cmp = await getUsageComparison(db);
      const side = (p: typeof cmp.week) => ({
        zeitraum: `${p.current.fromDay} bis ${p.current.toDay}`,
        tokens_gesamt: p.current.tokens,
        veraenderung_prozent: p.deltaPct,
        je_werkzeug: p.tools.map((t) => ({ werkzeug: t.tool, tokens: t.tokens, gegenwert_usd: Math.round(t.cost * 100) / 100, preise_vollstaendig: t.costComplete, meistes_modell: t.topModel })),
      });
      const today = localDay(new Date());
      const haiku = (await usageByDay(db, 1)).find((u) => u.day === today);
      // „Wie viel von meinem Limit?“ – dieselben Fenster wie die Kachel „Max-Fenster“ (nie geschätzt).
      const windows = await getUsageWindows(db);
      return {
        woche: side(cmp.week),
        monat: side(cmp.month),
        haiku_heute: { laeufe: haiku?.calls ?? 0, gegenwert_usd: haiku?.costUsd ?? 0 },
        limit_fenster: windows.map((w) => ({
          werkzeug: w.tool,
          tokens_5_std: w.tokens5h,
          tokens_7_tage: w.tokens7d,
          spitze_5_std: w.peak5h,
          anbieter_meldet: {
            fuenf_std_prozent: w.reported.fiveHourPct,
            woche_prozent: w.reported.weekPct,
            limit_erreicht: w.reported.limitReached,
            zuruecksetzen: w.reported.resetsAt ? localStamp(w.reported.resetsAt) : null,
            // echte Werte von Anthropic (OAuth-Nutzung) bzw. Codex; Woche mit eigenem Reset.
            woche_zuruecksetzen: w.reported.weekResetsAt ? localStamp(w.reported.weekResetsAt) : null,
            quelle: w.reported.source,
            stand: w.reported.fetchedAt ? localStamp(w.reported.fetchedAt) : null,
          },
        })),
        limit_hinweis: "Prozent vom Abo-Limit nur aus anbieter_meldet. Steht dort null, meldet der Anbieter keinen Wert – dann sag das und nenne nur die Tokens der letzten 5 Stunden/7 Tage, nie eine geschätzte Prozentzahl.",
      };
    },
  });

  // dieselben Gruppen wie die Karte „Seit du weg warst“ (`GET /api/changes`), nur lesend.
  reg.register({
    name: "was_ist_neu",
    description:
      "Was seit einem Zeitpunkt passiert ist (wie die Karte „Seit du weg warst“): wartende/abgestürzte/fertige/neue Sessions, Commits je Repo, Aufträge, Ideen, Freigaben und Fragen, Deploys, Nutzung. Für „Was ist seit gestern passiert?“. seit: „gestern“, „heute“, „8h“, „7d“ oder Datum/Uhrzeit (Zeitzone des Nutzers) wie 2026-09-24 oder 2026-09-24T18:00 (Standard 24h, höchstens 7 Tage). `anzahl` ist die echte Zahl je Gruppe, `eintraege` nur die neuesten. Nur lesen.",
    scopes: ["full"],
    input: z.object({ seit: z.string().trim().max(40).optional() }),
    handler: async (a, { db }) => {
      const now = new Date();
      const resolved = resolveSince(a.seit, now);
      if (!resolved) return { fehler: "Diesen Zeitpunkt verstehe ich nicht. Beispiele: gestern, 8h, 7d oder ein Datum." };
      const r = await getChanges(db, { since: resolved.since, now, capped: resolved.capped });
      // Kompakt für Haiku: je Gruppe nur die neuesten paar Zeilen, die echte Zahl steht in `anzahl`.
      const PER_GROUP = 8;
      if (r.groups.length === 0) return { seit: localStamp(r.since), bis: localStamp(r.until), gekappt_auf_7_tage: r.capped, gruppen: [], hinweis: `Nichts Neues seit ${localStamp(r.since)}.` };
      return {
        seit: localStamp(r.since),
        bis: localStamp(r.until),
        gekappt_auf_7_tage: r.capped,
        hinweis: "Alle Zahlen hier sind NEU seit dem Zeitpunkt, nicht „wartet jetzt“. Was jetzt offen auf den Nutzer wartet, steht nur in inbox_liste.",
        gruppen: r.groups.map((g) => {
          const eintraege = g.items.slice(0, PER_GROUP).map((i) => ({ ...(i.ref ? { ref: i.ref } : {}), text: i.label, info: i.detail, zeit: g.kind === "usage" ? undefined : localStamp(i.at), link: i.path }));
          return { art: g.kind, titel: g.title, anzahl: g.count + g.more, gezeigt: eintraege.length, eintraege };
        }),
      };
    },
  });

  reg.register({
    name: "server_lage",
    description: "Server-Stand wie im Server-Tab: Gesundheit von NyxOS (DB, Archiv), Container (läuft/gestört/Neustart-Schleife), letzte Deploys, NAS-Sicherung, offene Einrichtungs-Schritte. Nur lesen.",
    scopes: ["full"],
    input: z.object({}),
    handler: async () => {
      const p = deps.serverSnapshot();
      if (!p) return { fehler: "Der Server-Stand ist gerade nicht verfügbar." };
      const s = (await p) as {
        nyxosHealthy: boolean;
        health: { ok: boolean };
        docker: { available: boolean; reason: string | null };
        containers: { name: string; state: string; restartLoop: boolean; project: string | null }[];
        deploys: { project: string; containerName: string; createdAt: string }[];
        pending: { title: string }[];
      };
      const gestoert = s.containers.filter((c) => c.state !== "running" || c.restartLoop);
      return {
        nyxos_gesund: s.nyxosHealthy && s.health.ok,
        docker_lesbar: s.docker.available,
        docker_hinweis: s.docker.reason,
        container_gesamt: s.containers.length,
        container_gestoert: gestoert.map((c) => ({ name: c.name, zustand: c.restartLoop ? "Neustart-Schleife" : c.state, projekt: c.project })),
        letzte_deploys: s.deploys.slice(0, 5).map((d) => ({ projekt: d.project, container: d.containerName, zeit: localStamp(d.createdAt) })),
        offen: s.pending.map((x) => x.title),
      };
    },
  });
}
