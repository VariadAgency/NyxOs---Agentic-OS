// Nyx steuert NyxOS (Vertrag `nyx.ui`, GOAL.md → Verträge).
//
// Der Server kann den Browser nicht selbst bedienen. Er schickt einen Befehl über den bestehenden
// `/live`-WebSocket an alle offenen NyxOS-Fenster; das sichtbare Fenster führt ihn aus (Nyx-Cursor
// fliegt hin) und antwortet mit `nyx.ui.result` bzw. `nyx.ui.screen` (WebSocket oder
// `POST /api/nyx/ui/reply`). Die erste Antwort gewinnt, alles andere wird ignoriert.
//
// Riskant ist nur die Freigabe-Liste (Löschen, Merge, Push, Deploy, Migration, Session endgültig schließen,
// Freigaben/Entscheidungen). Solche Ziele klickt Nyx NIE: das Werkzeug
// schickt dann nur `highlight`, der Browser zeigt mit Glow darauf und der Nutzer entscheidet selbst.
// Der Browser prüft das zusätzlich am echten Element (`data-nyx-risk`) – doppelt hält besser.
//
// Nyx-Kern baut später darum herum; hier nur die kleine, klare Grundlage.
import { randomBytes } from "node:crypto";
import { isRiskyLabel, NyxUiCommandSchema, NyxUiReplySchema, NyxUiRouteSchema, type NyxUiCommand, type NyxUiScreen } from "@nyxos/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../app.js";
import type { ToolRegistry } from "../haiku/tools.js";
import { isOwnerTurn } from "./appApi/internal.js";
import { clickPathFor } from "./map/index.js";

export type NyxUiOutcome =
  | { ok: true; route?: string; detail?: string; screen?: NyxUiScreen }
  | { ok: false; reason: string; risky?: boolean; route?: string };

interface Pending {
  resolve: (o: NyxUiOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  grace: ReturnType<typeof setTimeout> | null;
  action: NyxUiCommand["action"];
  startedAt: number;
  /** Fenster, die den Befehl bestätigt haben (tabId → sichtbar?), in Reihenfolge der Bestätigung. */
  acks: Map<string, boolean>;
  /** An dieses Hintergrund-Fenster ging `nyx.ui.run`. */
  ranHidden: string | null;
}

export interface NyxUiBridgeOptions {
  hub: { broadcast(message: unknown): void; readonly size: number };
  /** Wie lange auf den Browser gewartet wird (Cursor-Flug + Klick dauern ~1–3 s). */
  timeoutMs?: number;
  /** Kein sichtbares Fenster hat so lange nach dem Senden bestätigt → das erste Hintergrund-Fenster führt aus. */
  hiddenGraceMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export const NYX_UI_NO_VIEWER = "Gerade ist kein NyxOS-Fenster offen – Der Nutzer muss NyxOS im Browser öffnen.";
/** Kein Fenster hat den Befehl bestätigt: die Live-Verbindung des Browsers ist weg (Tunnel, Schlaf, alter Tab). */
export const NYX_UI_NO_ANSWER = "Der Befehl ist bei NyxOS nicht angekommen – die Live-Verbindung des Browsers ist wohl kurz weg. Neu laden hilft; NyxOS verbindet sich aber auch von selbst neu.";
/** Ein Fenster hat bestätigt, aber kein Ergebnis geschickt. */
export const NYX_UI_STUCK = "NyxOS hat den Befehl bekommen, ist damit aber nicht fertig geworden.";

/** So viele abgelaufene Anfragen merkt sich die Brücke, um zu späte Antworten im Log zu erkennen. */
const EXPIRED_KEEP = 50;

export class NyxUiBridge {
  private readonly pending = new Map<string, Pending>();
  private readonly expired = new Map<string, { action: string; startedAt: number }>();
  private readonly timeoutMs: number;
  private readonly hiddenGraceMs: number;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;

  constructor(private readonly opts: NyxUiBridgeOptions) {
    this.timeoutMs = opts.timeoutMs ?? 12_000;
    this.hiddenGraceMs = opts.hiddenGraceMs ?? 700;
    this.log = opts.log ?? (() => {});
  }

  get hasViewers(): boolean {
    return this.opts.hub.size > 0;
  }

  /** Schickt einen Befehl an die offenen Fenster und wartet auf die erste Antwort. */
  send(cmd: NyxUiCommand): Promise<NyxUiOutcome> {
    if (!this.hasViewers) return Promise.resolve({ ok: false, reason: NYX_UI_NO_VIEWER });
    const requestId = randomBytes(12).toString("hex");
    return new Promise<NyxUiOutcome>((resolve) => {
      const timer = setTimeout(() => this.expire(requestId), this.timeoutMs);
      const grace = setTimeout(() => this.runInHidden(requestId), this.hiddenGraceMs);
      this.pending.set(requestId, { resolve, timer, grace, action: cmd.action, startedAt: Date.now(), acks: new Map(), ranHidden: null });
      this.opts.hub.broadcast({ type: "nyx.ui", requestId, ...cmd });
    });
  }

  /** Nur Hintergrund-Fenster haben bestätigt: das erste führt aus (Seite ist da, wenn der Nutzer zurückkommt). */
  private runInHidden(requestId: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    p.grace = null;
    if (p.ranHidden || [...p.acks.values()].some(Boolean)) return;
    const tabId = p.acks.keys().next().value;
    if (tabId === undefined) return;
    p.ranHidden = tabId;
    this.opts.hub.broadcast({ type: "nyx.ui.run", requestId, tabId });
  }

  private expire(requestId: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    if (p.grace) clearTimeout(p.grace);
    const visible = [...p.acks.values()].filter(Boolean).length;
    this.log("nyx-ui-zeitlimit", { action: p.action, bestaetigt: p.acks.size, sichtbar: visible, hintergrundAusgefuehrt: p.ranHidden !== null, fenster: this.opts.hub.size });
    this.expired.set(requestId, { action: p.action, startedAt: p.startedAt });
    if (this.expired.size > EXPIRED_KEEP) this.expired.delete(this.expired.keys().next().value as string);
    p.resolve({ ok: false, reason: p.acks.size === 0 ? NYX_UI_NO_ANSWER : NYX_UI_STUCK });
  }

  /** Antwort aus dem Browser. `true` = eine offene Anfrage wurde damit beantwortet. */
  receive(raw: unknown): boolean {
    const parsed = NyxUiReplySchema.safeParse(raw);
    if (!parsed.success) return false;
    const reply = parsed.data;
    const p = this.pending.get(reply.requestId);
    if (!p) {
      const late = this.expired.get(reply.requestId);
      if (late && reply.type !== "nyx.ui.ack") {
        this.expired.delete(reply.requestId);
        this.log("nyx-ui-spaet", { action: late.action, ms: Date.now() - late.startedAt });
      }
      return false;
    }
    if (reply.type === "nyx.ui.ack") {
      if (!p.acks.has(reply.tabId)) p.acks.set(reply.tabId, reply.visible);
      // Bestätigung kam erst nach der Karenz (langsamer POST) – sonst führte niemand aus und Nyx wartete 12 s.
      if (p.grace === null) this.runInHidden(reply.requestId);
      return true;
    }
    this.pending.delete(reply.requestId);
    clearTimeout(p.timer);
    if (p.grace) clearTimeout(p.grace);
    if (reply.type === "nyx.ui.screen") {
      p.resolve({ ok: true, route: reply.route, screen: { route: reply.route, title: reply.title, elements: reply.elements } });
    } else if (reply.ok) {
      p.resolve({ ok: true, route: reply.route, detail: reply.detail });
    } else {
      if (!reply.risky) this.log("nyx-ui-fehlgeschlagen", { action: p.action, detail: reply.detail ?? null, ms: Date.now() - p.startedAt });
      p.resolve({ ok: false, reason: reply.detail ?? "Das hat im Browser nicht geklappt.", risky: reply.risky, route: reply.route });
    }
    return true;
  }
}

const RISKY_HINT = "Riskanter Knopf – Nyx zeigt nur darauf (Glow). Der Nutzer klickt selbst, wenn er will.";

function toToolResult(o: NyxUiOutcome): Record<string, unknown> {
  if (o.ok) return { erledigt: true, ...(o.route ? { route: o.route } : {}), ...(o.detail ? { hinweis: o.detail } : {}) };
  if (o.risky) return { erledigt: false, riskant: true, hinweis: RISKY_HINT };
  return { erledigt: false, hinweis: o.reason };
}

/** Klicken/Tippen/Wählen verändert NyxOS – in automatischen Läufen (geplante Aufgabe …) nur lesen, wie app_api. */
const AUTO_RUN_HINT = "In einem automatischen Lauf (geplante Aufgabe, ohne den Nutzer) bediene ich NyxOS nicht – nur lesen (ui_read_screen). Schlag es dem Nutzer vor.";
const autoRunRefusal = () => ({ erledigt: false, abgelehnt: true, hinweis: AUTO_RUN_HINT });

/** Seite, die das Vorlesen von selbst startet. */
export const briefingReadRoute = (art?: "briefing" | "recap") => `/briefing?vorlesen=1${art ? `&art=${art}` : ""}`;

/** Navigation immer mit Klickpfad aus der NyxOS-Karte – der Browser klickt ihn sichtbar ab. */
export function navigateCommand(route: string): NyxUiCommand {
  const via = clickPathFor(route);
  return via.length ? { action: "navigate", route, via } : { action: "navigate", route };
}

/** Werkzeuge im bestehenden Haiku-Werkzeugkasten (nur Umfang „full“, nie im Ideen-Link). */
export function registerNyxUiTools(reg: ToolRegistry, bridge: NyxUiBridge): void {
  reg.register({
    name: "ui_navigate",
    description:
      "Öffnet in NyxOS (im Browser des Nutzers) eine Seite, z. B. /sessions, /git, /tasks, /inbox, /audits, /files, /settings, /usage, /gehirn. Auch tiefe Ziele wie /skills/<key> oder /ideas/<id>. Der Nyx-Cursor klickt sich sichtbar hin (Leiste → Zeile/Kachel → Unterseite, Klickpfad aus der NyxOS-Karte), nie ein stiller Sprung. Nur interne Pfade. Wo etwas liegt, sagt nyxos_karte. Einstellungen haben Unterseiten: /settings/konto, /settings/mitteilungen (darunter /settings/mitteilungen-stil, /settings/mitteilungen-nyx, /settings/telegram), /settings/sessions, /settings/nutzung, /settings/lernbuch, /settings/ideen-links, /settings/modelle, /settings/betrieb (darunter /settings/verbindungen), /settings/zugaenge, /settings/unterstuetzen; Info & Hilfe: /einstellungen/info; Nyx: /einstellungen/nyx (Übersicht) und /einstellungen/nyx/persoenlichkeit, …/ueber-dich, …/stimme, …/begleiter, …/zugriff, …/motor. Ein Anker springt an den Abschnitt (z. B. /settings/mitteilungen#erweitert-ruhezeit).",
    scopes: ["full"],
    input: z.object({ route: NyxUiRouteSchema }),
    handler: async (a) => toToolResult(await bridge.send(navigateCommand(a.route))),
  });
  reg.register({
    name: "ui_click",
    description:
      "Klickt in NyxOS sichtbar mit dem Nyx-Cursor auf ein Element (echter Klick; wartet bis zu 4 s, bis es nach einem Seitenwechsel erscheint): `target` = data-nyx-Kennung aus ui_read_screen (z. B. „nav:git“, „recent“, „session-row:<id>“), ein Listeneintrag `item:<art>[:<rang>|:<text>]` mit art = session | task | audit | decision | idea | repo (z. B. „item:session“ = neueste Session, „item:session:2“ = drittneueste, „item:task:heatmap“ = Aufgabe per Text) oder die sichtbare Beschriftung. Mehrstufig: erst ui_click „nav:ses“ (oder ui_navigate), dann „item:session“. Alles andere (Neue Session, Starten, Senden, Schließen eines Dialogs, …) klickt Nyx wirklich. Nur die Freigabe-Liste (Löschen, Merge, Push, Deploy, Migration, Session endgültig schließen, Freigaben/Entscheidungen) klickt Nyx nie – er zeigt nur darauf.",
    scopes: ["full"],
    input: z.object({ target: z.string().trim().min(1).max(200) }),
    handler: async (a, ctx) => {
      if (!isOwnerTurn(ctx)) return autoRunRefusal();
      // Listeneinträge öffnen nur – ihr Suchtext („item:task:push-fix“) ist keine Knopf-Beschriftung; der Browser prüft das Element.
      if (!a.target.startsWith("item:") && isRiskyLabel(a.target)) {
        await bridge.send({ action: "highlight", target: a.target });
        return { erledigt: false, riskant: true, hinweis: RISKY_HINT };
      }
      return toToolResult(await bridge.send({ action: "click", target: a.target }));
    },
  });
  reg.register({
    name: "ui_type",
    description:
      "Tippt in NyxOS sichtbar Text in ein Eingabefeld (`target` = data-nyx-Kennung wie „suche“ oder Beschriftung; der Cursor klickt erst hinein). Das Suchfeld wird ersetzt, andere Felder weitergeschrieben. `submit: true` drückt danach Enter (nur wenn der Nutzer das will).",
    scopes: ["full"],
    input: z.object({ target: z.string().trim().min(1).max(200), text: z.string().min(1).max(2000), submit: z.boolean().optional() }),
    handler: async (a, ctx) => {
      if (!isOwnerTurn(ctx)) return autoRunRefusal();
      return toToolResult(await bridge.send({ action: "type", target: a.target, text: a.text, ...(a.submit ? { submit: true } : {}) }));
    },
  });
  // Auswahl treffen – Auswahlliste, Radio-Gruppe oder Schalter (z. B. Werkzeug/Modell/Ordner im Dialog „Neue Session“).
  reg.register({
    name: "ui_select",
    description:
      "Trifft in NyxOS sichtbar eine Auswahl: `target` = data-nyx-Kennung oder Beschriftung einer Auswahlliste, Radio-Gruppe oder eines Schalters (z. B. „new-session:model“, „Modell“); `option` = sichtbare Beschriftung oder Wert der Wahl (unscharf, z. B. „Opus 5.5“, „Codex“), bei Schaltern „an“/„aus“. Passt nichts, nennt die Antwort die Möglichkeiten. ui_read_screen zeigt die Optionen.",
    scopes: ["full"],
    input: z.object({ target: z.string().trim().min(1).max(200), option: z.string().trim().min(1).max(200) }),
    handler: async (a, ctx) => {
      if (!isOwnerTurn(ctx)) return autoRunRefusal();
      if (isRiskyLabel(a.target)) {
        await bridge.send({ action: "highlight", target: a.target });
        return { erledigt: false, riskant: true, hinweis: RISKY_HINT };
      }
      return toToolResult(await bridge.send({ action: "select", target: a.target, option: a.option }));
    },
  });
  // „Lies mir das Briefing vor“ – öffnet das Briefing, die Seite startet das Vorlesen selbst
  // (Server-Stimme, der erwähnte Abschnitt leuchtet). Ohne offenes NyxOS-Fenster sagt das Werkzeug das ehrlich.
  reg.register({
    name: "briefing_vorlesen",
    description:
      "Liest der Nutzer das Briefing (oder abends den Recap) in NyxOS vor: öffnet die Briefing-Seite und startet das Vorlesen – der gerade erwähnte Abschnitt wird hervorgehoben. Für „Lies mir das Briefing vor“.",
    scopes: ["full"],
    input: z.object({ art: z.enum(["briefing", "recap"]).optional() }),
    handler: async (a) => toToolResult(await bridge.send(navigateCommand(briefingReadRoute(a.art)))),
  });
  reg.register({
    name: "ui_read_screen",
    description:
      "Was der Nutzer in NyxOS gerade sieht: Route, Titel und die steuerbaren Elemente (data-nyx-Kennung, Beschriftung, Art, riskant ja/nein; bei Auswahlen auch optionen und wert), dazu die Listeneinträge nach Rang (`item:<art>:<rang>`, neueste zuerst). Vor ui_click nutzen, wenn das Ziel unklar ist.",
    scopes: ["full"],
    input: z.object({}),
    handler: async () => {
      const o = await bridge.send({ action: "read_screen" });
      if (!o.ok || !o.screen) return toToolResult(o);
      return { route: o.screen.route, titel: o.screen.title, elemente: o.screen.elements.map((e) => ({ id: e.id, label: e.label, art: e.kind, riskant: e.risk, ...(e.options ? { optionen: e.options } : {}), ...(e.value !== undefined ? { wert: e.value } : {}) })) };
    },
  });
}

/** Kleine Routen: Antwort-Rückweg ohne WebSocket, Befehl/Bildschirm für den Nyx-Kern und Tests. */
export function registerNyxUiRoutes(app: Hono<Env>, deps: { bridge: NyxUiBridge }): void {
  const { bridge } = deps;
  app.post("/api/nyx/ui/reply", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!NyxUiReplySchema.safeParse(body).success) return c.json({ error: "Ungültige Antwort" }, 400);
    return c.json({ accepted: bridge.receive(body) });
  });
  app.post("/api/nyx/ui/command", async (c) => {
    const parsed = NyxUiCommandSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Ungültiger Befehl", issues: parsed.error.issues.slice(0, 3) }, 400);
    // Navigation ohne Klickpfad bekommt den aus der NyxOS-Karte (wie ui_navigate).
    const cmd = parsed.data.action === "navigate" && !parsed.data.via ? navigateCommand(parsed.data.route) : parsed.data;
    // Gleiche Sperre wie im Werkzeug: riskante Ziele nur zeigen.
    if ((cmd.action === "click" || cmd.action === "select") && !cmd.target.startsWith("item:") && isRiskyLabel(cmd.target)) return c.json({ ...(await bridge.send({ action: "highlight", target: cmd.target })), ok: false, risky: true });
    return c.json(await bridge.send(cmd));
  });
  app.get("/api/nyx/ui/screen", async (c) => c.json(await bridge.send({ action: "read_screen" })));
}
