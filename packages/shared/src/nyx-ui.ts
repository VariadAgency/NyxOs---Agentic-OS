// Vertrag „Plattform steuern“ (GOAL.md → Verträge → `nyx.ui`).
// Server → Browser über den bestehenden `/live`-WebSocket: `{type:"nyx.ui", requestId, …Befehl}`.
// Browser → Server als Antwort: `nyx.ui.result` (Klick/Tippen/…) bzw. `nyx.ui.screen` (read_screen).
// Nyx bedient alles, was der Nutzer in NyxOS kann. Riskant ist nur die Freigabe-Liste aus CLAUDE.md – Löschen, Merge,
// Push, Deploy, Migration, Session endgültig schließen – plus Freigaben/Entscheidungen selbst (im DOM `data-nyx-risk`).
// Solche Ziele klickt Nyx nie: der Browser zeigt nur mit Glow darauf, der Nutzer bestätigt selbst.
import { z } from "zod";
import { t } from "./i18n/index.js";

/** Interne Route der Web-App (nie eine fremde Adresse). */
export const NyxUiRouteSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  // Kein `//host` und kein Backslash: Browser lesen `/\\evil.com` wie `//evil.com`.
  .regex(/^\/(?![/\\])[^\s\\]*$/, { error: () => t("Nur Seiten innerhalb von NyxOS (beginnt mit /)") });

export const NyxUiTargetActionSchema = z.enum(["click", "focus", "type", "scroll", "highlight"]);
export type NyxUiTargetAction = z.infer<typeof NyxUiTargetActionSchema>;

export const NyxUiCommandSchema = z.union([
  z.object({
    action: z.literal("navigate"),
    route: NyxUiRouteSchema,
    /** Klickpfad aus der NyxOS-Karte (data-nyx-Kennungen ab der Leiste, z. B. `nav:settings`, `settings:mitteilungen`,
     * `settings-sub:telegram`). Der Browser klickt ihn sichtbar ab – nie ein stiller Routensprung. */
    via: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
  }),
  z.object({
    action: NyxUiTargetActionSchema,
    /** `data-nyx`-Kennung (auch mit `*` am Ende = erstes passendes), `item:<art>[:<rang>|:<text>]` (Listeneintrag,
     * z. B. `item:session` = neueste Session) oder sichtbare Beschriftung. */
    target: z.string().trim().min(1).max(200),
    text: z.string().max(2000).optional(),
    /** nach dem Tippen abschicken (Enter). Riskante Felder tippt Nyx ohnehin nie. */
    submit: z.boolean().optional(),
  }),
  /** Auswahl treffen – `<select>`, Radio-Gruppe (role=radiogroup) oder Schalter (role=switch/checkbox, `option`
   * „an“/„aus“). `option` = sichtbare Beschriftung oder Wert, unscharf. */
  z.object({
    action: z.literal("select"),
    target: z.string().trim().min(1).max(200),
    option: z.string().trim().min(1).max(200),
  }),
  z.object({ action: z.literal("read_screen") }),
]);
export type NyxUiCommand = z.infer<typeof NyxUiCommandSchema>;

/** Server → Browser. `requestId` fehlt nur bei Befehlen, auf die niemand wartet. */
export type NyxUiMessage = NyxUiCommand & { type: "nyx.ui"; requestId?: string };

/** Ein sichtbares, steuerbares Element (Ergebnis von `read_screen`). */
export const NyxScreenElementSchema = z.object({
  id: z.string().max(200),
  label: z.string().max(200),
  /** button | link | input | select | switch | tab | row | other */
  kind: z.string().max(20),
  risk: z.boolean(),
  /** Auswahl (select/radiogroup/switch) – die Möglichkeiten (gekürzt) und was gerade gewählt ist. */
  options: z.array(z.string().max(80)).max(20).optional(),
  value: z.string().max(80).optional(),
});
export type NyxScreenElement = z.infer<typeof NyxScreenElementSchema>;

export const NyxUiScreenSchema = z.object({
  route: z.string().max(500),
  title: z.string().max(300),
  elements: z.array(NyxScreenElementSchema).max(400),
});
export type NyxUiScreen = z.infer<typeof NyxUiScreenSchema>;

/** Browser → Server (WebSocket `/live` oder `POST /api/nyx/ui/reply`). */
export const NyxUiReplySchema = z.union([
  z.object({
    type: z.literal("nyx.ui.result"),
    requestId: z.string().min(8).max(64),
    ok: z.boolean(),
    /** true = riskantes Ziel, nur gezeigt statt geklickt. */
    risky: z.boolean().optional(),
    detail: z.string().max(500).optional(),
    route: z.string().max(500).optional(),
  }),
  NyxUiScreenSchema.extend({ type: z.literal("nyx.ui.screen"), requestId: z.string().min(8).max(64) }),
  // Jedes Fenster bestätigt sofort, dass der Befehl ankam (und ob es sichtbar ist). So weiß der Server,
  // ob niemand zuhört (Verbindung weg), nur Hintergrund-Fenster offen sind oder ein sichtbares Fenster hängt.
  z.object({
    type: z.literal("nyx.ui.ack"),
    requestId: z.string().min(8).max(64),
    tabId: z.string().min(4).max(64),
    visible: z.boolean(),
    route: z.string().max(500).optional(),
  }),
]);
export type NyxUiReply = z.infer<typeof NyxUiReplySchema>;
export type NyxUiResult = Extract<NyxUiReply, { type: "nyx.ui.result" }>;
export type NyxUiAck = Extract<NyxUiReply, { type: "nyx.ui.ack" }>;

/** Server → genau ein Hintergrund-Fenster: „kein sichtbares Fenster da – führ du den Befehl aus“. */
export interface NyxUiRunMessage {
  type: "nyx.ui.run";
  requestId: string;
  tabId: string;
}

/** Wörter, bei denen ein Ziel als riskant gilt, auch wenn es (noch) kein `data-nyx-risk` trägt – genau die Freigabe-Liste
 * (CLAUDE.md: „Freigaben bleiben beim Nutzer“): Löschen/Entfernen, Deploy, Merge, Push, Migration, Freigeben, Verwerfen,
 * Zurücksetzen, „endgültig“ (Session endgültig schließen), Prozess/Session beenden und Übernehmen (beendet ggf. einen
 * fremden Prozess). Nicht mehr riskant: Schließen/Abbrechen von Dialogen, Senden, Antworten, Archivieren, Starten –
 * Entscheidungs-Karten bleiben über `data-nyx-risk` gesperrt. Nur Wortanfänge zählen („Stempush“ ist kein Treffer). */
export const NYX_RISK_WORDS =
  /(?:^|[^\p{L}])(lösch|loesch|entfern|delete|remove|deploy|merge|push|migration|migrier|freigeb|verwerf|zurücksetz|zuruecksetz|endgültig|endgueltig|beenden|übernehm|uebernehm)/iu;

export function isRiskyLabel(label: string): boolean {
  return NYX_RISK_WORDS.test(label);
}
