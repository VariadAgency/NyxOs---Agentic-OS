// Register of all settings areas – the ONE place overview, subpages, search, old links (`legacy.ts`), routes
// (`routes.tsx`) and ⌘K read from. A new area = one entry here:
//   { id: "example", path: "/settings/example", title, icon: "✱", tone: "teal", group: "system", summary, lead, keywords, panels: [{ id: "example", title, Component: ExamplePanel }] },
// An area shows at most ~3 blocks; rarely used ones get `advanced: true` (collapsed behind „Erweitert“).
// All texts and keywords go through `t()`: the search then finds the words of the chosen language. Paths and ids stay
// as they are (old links must keep working). `modes`/`local` adapt an area to local mode (`sectionsForMode`).
import { t, type AppMode } from "@nyxos/shared";
import { HaikuSettingsPanel } from "../haiku/HaikuSettingsPanel";
import { HostingSettings } from "../hosting/HostingSettings";
import { IdeaLinksPanel } from "../idealink/IdeaLinksPanel";
import { NightSettingsPanel } from "../night/NightSettingsPanel";
import { NyxCompanionSettings } from "../nyx/NyxCompanionSettings";
// Notifications (Wann · Wie · Nyx prüft/schreibt · Wege · Verlauf) – replaces the former push and away panels.
import { NotificationNyxPanel, NotificationSettings, NotificationStylePanel } from "../notifications/NotificationSettings";
// Focus button (auto / away / do not disturb) – the same choice as at the bottom left of the sidebar.
import { FocusSettingsPanel } from "../focus/FocusControl";
import { SupportPanel } from "../support/SupportPanel";
import { TelegramSettingsPanel } from "../telegram/TelegramSettingsPanel";
import { TemporarySettingsPanel } from "../temporary/TemporarySettingsPanel";
import { UsageSettingsSheet } from "../usage/UsageSettingsSheet";
import { ContextGuardSettings } from "../context-guard/ContextGuardSettings";
import { AccessPanel } from "./access/AccessPanel";
import { AuthSettingsPanel } from "./AuthSettingsPanel";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { ConnectorsPanel } from "./ConnectorsPanel";
import { LearnbookPanel } from "./LearnbookPanel";
import { ModelsPanel } from "./ModelsPanel";
import { NyxAccessPanel } from "./nyx/NyxAccessPanel";
import { NyxAboutPanel, NyxPersonalityPanel } from "./nyx/NyxProfilePanels";
import { NyxVoiceSettings } from "./nyx/NyxVoiceSettings";
import { SessionStateSettingsPanel } from "./SessionStateSettingsPanel";
import {
  useAboutSectionStatus,
  useAccessSectionStatus,
  useAuthSectionStatus,
  useCompanionSectionStatus,
  useConnectionsSectionStatus,
  useEngineSectionStatus,
  useIdeaLinksSectionStatus,
  useModelsSectionStatus,
  useNightSectionStatus,
  usePersonalitySectionStatus,
  usePushSectionStatus,
  useRulesSectionStatus,
  useSupportSectionStatus,
  useVoiceSectionStatus,
} from "./sectionStatus";
import type { SettingsGroup, SettingsSection } from "./types";

export type { SettingsGroup, SettingsPanelDef, SettingsSection, SectionStatus } from "./types";

export const SETTINGS_PATH = "/settings";
export const NYX_SETTINGS_PATH = "/einstellungen/nyx";
export const INFO_SETTINGS_PATH = "/einstellungen/info";

// Small wrappers: existing panels without their own page header (the subpage has it).
const UsageSettingsSection = () => <UsageSettingsSheet variant="section" />;
const IdeaLinksSection = () => <IdeaLinksPanel embedded />;
const EngineSection = () => <HaikuSettingsPanel embedded />;
const TelegramSection = () => <TelegramSettingsPanel bare />;
const ConnectionsSection = () => <ConnectionsPanel bare />;

/** Groups of the overview „Allgemein“ (order = display). */
export const GENERAL_GROUPS: readonly SettingsGroup[] = [
  { id: "du", title: t("Du") },
  { id: "arbeiten", title: t("Arbeiten") },
  { id: "ki", title: t("Nyx & Modelle") },
  { id: "system", title: t("System") },
  { id: "hilfe", title: t("Hilfe & Feedback") },
];

export const GENERAL_SECTIONS: readonly SettingsSection[] = [
  {
    id: "konto",
    path: "/settings/konto",
    title: t("Konto & Anmeldung"),
    icon: "◈",
    tone: "acc",
    group: "du",
    summary: t("Anmelden, Passkeys, weitere Geräte verbinden"),
    lead: t("Mit deinem Passkey meldest du dich an – auf jedem Gerät einmal Touch ID."),
    keywords: [t("Anmeldung"), t("Anmelden"), t("Abmelden"), t("Überall abmelden"), t("Passkey"), t("Touch ID"), t("Einrichtungs-Code"), t("Neues Gerät"), t("iPhone verbinden")],
    panels: [{ id: "anmeldung", title: t("Anmeldung"), keywords: [t("Passkey"), t("Code erzeugen"), t("Passkeys verwalten")], Component: AuthSettingsPanel }],
    useStatus: useAuthSectionStatus,
    // Local mode: sign-in only via the one-time link of `nyxos open` – no passkeys, no second device.
    local: {
      summary: t("Angemeldet auf diesem Rechner, abmelden"),
      lead: t("Ob dieser Browser angemeldet ist – und wie du dich ab- und wieder anmeldest."),
      keywords: [t("Anmeldung"), t("Anmelden"), t("Abmelden"), "nyxos open"],
      panels: [{ id: "anmeldung", title: t("Anmeldung"), Component: AuthSettingsPanel }],
    },
  },
  {
    id: "mitteilungen",
    path: "/settings/mitteilungen",
    title: t("Mitteilungen"),
    icon: "✉",
    tone: "wait",
    group: "du",
    summary: t("Wann und wie NyxOS dich erreicht – Rechner, Browser, Handy, Telegram"),
    lead: t("Wann NyxOS dich meldet, wie die Mitteilung geschrieben ist und ob Nyx sie vorher prüft oder selbst schreibt."),
    keywords: [t("Benachrichtigung"), t("Push"), t("Fokus"), t("Nicht stören"), t("Ich bin weg")],
    panels: [
      { id: "fokus", title: t("Fokus"), keywords: [t("Fokus"), t("Nicht stören"), t("Ich bin weg"), t("Automatisch")], Component: FocusSettingsPanel },
      {
        id: "push",
        title: t("Mitteilungen"),
        keywords: [t("Push")],
        // Every keyword group jumps to its spot on the long page (before, everything landed at the top).
        spots: [
          { anchor: "wann", keywords: [t("Wann"), t("Anlässe"), t("Immer"), t("Nur wenn ich weg bin"), t("Unter-Agenten"), t("Kontext-Wächter melden")] },
          { anchor: "wege", keywords: [t("Rechner"), t("Browser"), t("Handy"), t("Test-Mitteilung")] },
          { anchor: "verlauf", keywords: [t("Verlauf"), t("Passt"), t("Brauche ich nicht"), t("Regel-Vorschlag")] },
          { anchor: "erweitert-ruhezeit", keywords: [t("Ruhezeit"), t("Nachtruhe")] },
          { anchor: "erweitert-abstand", keywords: [t("Mindestabstand"), t("Bündelung"), t("Wartezeit"), t("Sammel-Mitteilung")] },
          { anchor: "erweitert-weg", keywords: [t("Wenn ich weg bin"), t("Abwesenheit"), t("Weg-Erkennung")] },
          { anchor: "erweitert-vorlagen", keywords: [t("Vorlage"), t("Platzhalter")] },
          { anchor: "erweitert-iphone", keywords: [t("iPhone"), "ntfy", t("QR-Code")] },
          { anchor: "erweitert-klick", keywords: [t("Klick-Adresse")] },
        ],
        Component: NotificationSettings,
      },
    ],
    useStatus: usePushSectionStatus,
  },
  {
    // „Wie geschrieben?“ and „Nyx“ as own subpages – the notifications page only shows one row each with a summary.
    // Panel id `wie` = the old anchor (`/settings/mitteilungen#wie`); `#nyx` leads here via `parentAnchors`.
    id: "mitteilungen-stil",
    path: "/settings/mitteilungen-stil",
    parent: "mitteilungen",
    title: t("Wie geschrieben?"),
    icon: "✎",
    tone: "wait",
    group: "du",
    summary: t("Stil der Mitteilungen mit Vorschau"),
    lead: t("So klingt eine Mitteilung. Der Name ist immer der Titel der Session oder die Baustelle – nie der rohe Prompt."),
    keywords: [t("Stil"), t("Wie geschrieben"), t("Vorschau"), t("Knapp"), t("Ausführlich"), t("Mit Zusammenhang")],
    panels: [{ id: "wie", title: t("Wie geschrieben?"), keywords: [t("Beispiel"), t("Sperrbildschirm")], Component: NotificationStylePanel }],
  },
  {
    id: "mitteilungen-nyx",
    path: "/settings/mitteilungen-nyx",
    parent: "mitteilungen",
    title: t("Nyx prüft & schreibt"),
    icon: "◎",
    tone: "violet",
    group: "du",
    summary: t("Nyx sieht Mitteilungen vorher an oder schreibt sie selbst"),
    lead: t("Nyx kann jede Mitteilung vorher ansehen und selbst schreiben. Jede Entscheidung steht mit Grund im Verlauf."),
    keywords: [t("Nyx prüft"), t("Nyx schreibt"), t("Was mir wichtig ist"), t("Dringendes")],
    parentAnchors: ["nyx"],
    panels: [{ id: "nyx-pruefen", title: t("Nyx prüft & schreibt"), Component: NotificationNyxPanel }],
  },
  {
    // Own subpage (before: a second, long block below „Mitteilungen“ – duplicate of the row in „Wege“).
    id: "telegram",
    path: "/settings/telegram",
    parent: "mitteilungen",
    title: "Telegram",
    icon: "✈",
    tone: "teal",
    group: "du",
    summary: t("Mit Nyx vom Handy schreiben, Freigaben unterwegs beantworten"),
    lead: t("Mit Nyx vom Handy aus sprechen: schreiben, Sprachnachrichten schicken, Sessions wählen und starten, /compact, Freigaben per Knopf."),
    keywords: [t("Telegram-Bot"), t("Kopplung"), t("Kopplungs-Code"), t("Bot-Token"), "BotFather"],
    panels: [{ id: "telegram", title: "Telegram", Component: TelegramSection }],
  },
  {
    id: "sessions",
    path: "/settings/sessions",
    title: t("Sessions"),
    icon: "▣",
    tone: "done",
    group: "arbeiten",
    summary: t("Zustände, Kontext-Wächter und Wegwerf-Chats"),
    lead: t("Wie NyxOS Sessions einsortiert, wann es zum Komprimieren rät und wie lange Wegwerf-Chats bleiben."),
    keywords: [t("Session")],
    panels: [
      { id: "zustaende", title: t("Zustände"), keywords: [t("Erledigt"), t("Wartet"), t("Zustand")], Component: SessionStateSettingsPanel },
      { id: "kontext-waechter", title: t("Kontext-Wächter"), keywords: [t("Kontext"), t("Komprimieren"), "compact", t("Schwelle"), t("Prozent")], Component: ContextGuardSettings },
      { id: "wegwerf-chats", title: t("Wegwerf-Chats"), keywords: [t("Temporär"), t("Wegwerf"), t("Löschen nach Stunden")], Component: TemporarySettingsPanel },
    ],
  },
  {
    id: "nutzung",
    path: "/settings/nutzung",
    title: t("Nutzung & Nachtmodus"),
    icon: "◔",
    tone: "claude",
    group: "arbeiten",
    summary: t("Ziele, Warnschwellen und der Nachtlauf"),
    lead: t("Wie viel du nutzen willst, wann NyxOS warnt und wann nachts gearbeitet wird."),
    keywords: [t("Verbrauch"), t("Tokens")],
    panels: [
      { id: "nutzung", title: t("Nutzung"), keywords: [t("Ziele"), t("Warnschwelle"), t("Zeitraum"), t("Limit")], Component: UsageSettingsSection },
      { id: "nachtmodus", title: t("Nachtmodus"), keywords: [t("Nachtlauf"), t("Nacht"), t("Budget in der Nacht")], Component: NightSettingsPanel },
    ],
    useStatus: useNightSectionStatus,
  },
  {
    id: "lernbuch",
    path: "/settings/lernbuch",
    title: t("Lernbuch"),
    icon: "✎",
    tone: "ok",
    group: "arbeiten",
    summary: t("Regeln, die NyxOS aus Wiederholungen gelernt hat"),
    lead: t("Jede Regel ist abschaltbar – abgeschaltet wirkt sie nicht mehr."),
    keywords: [t("Regeln"), t("gelernt")],
    panels: [{ id: "lernbuch", title: t("Lernbuch"), Component: LearnbookPanel }],
    useStatus: useRulesSectionStatus,
  },
  {
    // Also in local mode: reachable for others once NyxOS is shared in the tailnet (NYXOS_ALLOWED_HOSTS, `tailscale serve`).
    id: "ideen-links",
    path: "/settings/ideen-links",
    title: t("Ideen-Links"),
    icon: "✦",
    tone: "gold",
    group: "arbeiten",
    summary: t("Links, über die andere dir Ideen schicken"),
    lead: t("Ein Link pro Person: Wer ihn hat, kann Nyx eine Idee erzählen – mehr sieht die Person nicht."),
    keywords: [t("Link"), t("Idee einreichen"), t("Mini-Seite")],
    panels: [{ id: "ideen-links", title: t("Ideen-Links"), Component: IdeaLinksSection }],
    aliases: ["/einstellungen/ideen-links"],
    useStatus: useIdeaLinksSectionStatus,
  },
  {
    id: "nyx",
    path: NYX_SETTINGS_PATH,
    href: NYX_SETTINGS_PATH,
    title: "Nyx",
    icon: "◎",
    tone: "nyx",
    group: "ki",
    summary: t("Persönlichkeit, Stimme, Begleiter und was Nyx darf"),
    lead: "",
    keywords: [t("Assistent"), t("Persönlichkeit"), t("Stimme"), t("Vorlesen"), t("Zuhören"), t("Regler"), t("Vorlagen")],
    panels: [],
  },
  {
    id: "modelle",
    path: "/settings/modelle",
    title: t("Modelle & Konnektoren"),
    icon: "⬡",
    tone: "violet",
    group: "ki",
    summary: t("Welches Modell was macht, dazu MCP-Konnektoren"),
    lead: t("Jede Aufgabe von Nyx hat ein Modell. Ohne eigene Wahl gilt der Standard."),
    keywords: [t("Modell"), t("Anbieter"), t("Rollen"), "Claude", "OpenAI", "Ollama", "LM Studio"],
    panels: [
      { id: "modelle", title: t("Modelle"), keywords: [t("Rolle"), t("Standard-Modell"), t("Anbieter hinzufügen")], Component: ModelsPanel },
      { id: "konnektoren", title: t("Konnektoren"), keywords: ["MCP", t("Konnektor"), t("Werkzeuge")], Component: ConnectorsPanel, advanced: true },
    ],
    useStatus: useModelsSectionStatus,
  },
  {
    id: "betrieb",
    path: "/settings/betrieb",
    title: t("Betrieb & Zugriff"),
    icon: "☁",
    tone: "teal",
    group: "system",
    summary: t("Wo NyxOS läuft und ob alle Verbindungen stehen"),
    lead: t("Wo NyxOS läuft, wie du es vom Handy erreichst – und ob jede Verbindung steht."),
    keywords: [t("Server"), t("Hosting"), t("Brücke"), "Tailscale", t("Datenbank"), t("Status")],
    panels: [
      {
        id: "betrieb",
        title: t("Wo NyxOS läuft"),
        keywords: [t("Eigener Server"), t("Anbieter"), t("Autostart"), "Tailscale", "Cloudflare Tunnel", t("Domain"), "HTTPS", t("Vom Handy erreichen"), t("Nyx hilft")],
        Component: HostingSettings,
      },
    ],
    useStatus: useConnectionsSectionStatus,
    // Also in local mode: „Auf diesem Rechner“ is the current state there, the phone ways share it in the tailnet.
    local: {
      summary: t("Läuft auf diesem Rechner – vom Handy erreichen und alle Verbindungen"),
      keywords: [t("Dieser Rechner"), t("Brücke"), t("Autostart"), "Tailscale", t("Vom Handy erreichen"), t("Datenbank"), t("Status")],
    },
  },
  {
    // Own subpage (before, the long check list hung at the bottom of „Betrieb & Zugriff“ – ~4000 px on a phone).
    // Target of the status line „Alle Verbindungen ansehen“.
    id: "verbindungen",
    path: "/settings/verbindungen",
    parent: "betrieb",
    title: t("Verbindungen"),
    icon: "⇄",
    tone: "teal",
    group: "system",
    summary: t("Jede Verbindung von NyxOS, echt geprüft"),
    lead: t("Jede Verbindung von NyxOS, vom Server echt geprüft — mit Antwortzeit. Ist etwas gestört, steht darunter, warum und was hilft. „Nur du“ heißt: Das kannst nur du lösen, der Befehl steht zum Kopieren bereit."),
    keywords: [t("Verbindung prüfen"), t("Jetzt prüfen"), t("gestört"), t("Brücke"), t("Datenbank")],
    panels: [{ id: "verbindungen", title: t("Verbindungen"), Component: ConnectionsSection }],
    useStatus: useConnectionsSectionStatus,
    local: {
      lead: t("Jede Verbindung von NyxOS auf diesem Rechner, echt geprüft — mit Antwortzeit. Ist etwas gestört, steht darunter, warum und was hilft. „Nur du“ heißt: Das kannst nur du lösen, der Befehl steht zum Kopieren bereit. „Wartet“ heißt: Nichts ist kaputt, es kam nur noch nichts an."),
    },
  },
  {
    id: "zugaenge",
    path: "/settings/zugaenge",
    title: t("Zugänge & Schlüssel"),
    icon: "⚿",
    tone: "gold",
    group: "system",
    summary: t("Schlüssel und Tokens für Modelle, Telegram und mehr"),
    lead: t("Gespeichert wird verschlüsselt; angezeigt werden nur die letzten 4 Zeichen."),
    keywords: [t("Schlüssel"), t("Token"), t("API-Key"), "Anthropic", "OpenAI", "ElevenLabs", t("Alles auf einmal einrichten")],
    panels: [{ id: "zugaenge", title: t("Zugänge"), Component: AccessPanel }],
    useStatus: useAccessSectionStatus,
  },
  {
    id: "info",
    path: INFO_SETTINGS_PATH,
    href: INFO_SETTINGS_PATH,
    title: t("Info & Hilfe"),
    icon: "ⓘ",
    tone: "indigo",
    group: "hilfe",
    summary: t("Version, Updates, Sprache und Hilfe"),
    lead: "",
    keywords: [t("Version"), t("Update"), t("Sprache"), "Language", t("Hilfe"), t("Einrichtung erneut starten"), t("Datenordner")],
    panels: [],
  },
  {
    id: "unterstuetzen",
    path: "/settings/unterstuetzen",
    title: t("Feedback & Unterstützen"),
    icon: "♡",
    tone: "conf",
    group: "hilfe",
    summary: t("Fehler melden, Idee schicken oder das Projekt mit Tokens unterstützen."),
    lead: t("Alles bleibt in NyxOS: Meldungen gehen über deinen eigenen Server raus, Bezahlen passiert eingebettet."),
    keywords: [t("Fehler melden"), t("Bug"), t("Idee schicken"), t("Wunsch"), t("Buy me Tokens"), t("Spenden"), t("Postausgang")],
    panels: [{ id: "unterstuetzen", title: t("Feedback & Unterstützen"), Component: SupportPanel }],
    useStatus: useSupportSectionStatus,
  },
];

/** Groups of the Nyx overview. */
export const NYX_GROUPS: readonly SettingsGroup[] = [
  { id: "wer", title: t("So ist Nyx") },
  { id: "was", title: t("Was Nyx tut") },
];

export const NYX_SECTIONS: readonly SettingsSection[] = [
  {
    id: "persoenlichkeit",
    path: "/einstellungen/nyx/persoenlichkeit",
    title: t("Persönlichkeit"),
    icon: "✧",
    tone: "nyx",
    group: "wer",
    summary: t("Vorlagen, Regler und Charakter"),
    lead: t("Schieb die Regler – der Beispielsatz ändert sich sofort. Gilt im Browser, per Stimme und in Telegram."),
    keywords: [t("Vorlage"), t("Regler"), t("Länge"), t("Tempo"), t("Humor"), t("Charakter"), t("Ton"), t("Anrede"), t("Seele"), t("du oder Sie")],
    panels: [{ id: "persoenlichkeit", title: t("Persönlichkeit"), Component: NyxPersonalityPanel }],
    useStatus: usePersonalitySectionStatus,
  },
  {
    id: "ueber-dich",
    path: "/einstellungen/nyx/ueber-dich",
    title: t("Über dich"),
    icon: "☺",
    tone: "teal",
    group: "wer",
    summary: t("Was Nyx über dich wissen soll"),
    lead: t("Leere Felder lässt Nyx einfach weg."),
    keywords: [t("Profil"), t("Name"), t("Rolle"), t("Projekte"), t("Arbeitsweise"), t("Vorlieben"), t("No-Gos")],
    panels: [{ id: "ueber-dich", title: t("Über dich"), Component: NyxAboutPanel }],
    useStatus: useAboutSectionStatus,
  },
  {
    id: "stimme",
    path: "/einstellungen/nyx/stimme",
    title: t("Stimme"),
    icon: "♪",
    tone: "violet",
    group: "wer",
    summary: t("Welche Stimme, wie schnell, wie Nyx Wörter ausspricht"),
    lead: t("Jede Stimme kannst du vorher anhören. Fällt ElevenLabs aus, spricht automatisch die eigene Stimme."),
    keywords: [t("Stimme"), t("Sprechtempo"), "ElevenLabs", t("Hörprobe"), t("Aussprache"), t("Stimme importieren"), t("Stimme klonen"), t("Stimmpaket")],
    panels: [{ id: "stimme", title: t("Stimme"), Component: NyxVoiceSettings }],
    useStatus: useVoiceSectionStatus,
  },
  {
    id: "begleiter",
    path: "/einstellungen/nyx/begleiter",
    title: t("Begleiter"),
    icon: "◉",
    tone: "acc",
    group: "was",
    summary: t("Nyx in der Leiste: zuhören und vorlesen"),
    lead: t("Nyx sitzt oben in der Leiste – so hört und spricht Nyx dort."),
    keywords: [t("Leiste"), t("Zuhören"), t("Mikrofon"), t("Vorlesen"), t("Dauer-Zuhören")],
    panels: [{ id: "begleiter", title: t("Begleiter"), Component: NyxCompanionSettings }],
    anchors: ["nyx"],
    useStatus: useCompanionSectionStatus,
  },
  {
    id: "zugriff",
    path: "/einstellungen/nyx/zugriff",
    title: t("Zugriff & Freigaben"),
    icon: "⛨",
    tone: "ok",
    group: "was",
    summary: t("Was Nyx allein darf und was nur nach deinem Okay"),
    lead: t("Nyx kann NyxOS für dich bedienen. Riskantes nur nach deinem Tipp auf „Ausführen“, Anmeldung und Schlüssel nie."),
    keywords: [t("Freigabe"), t("Ausführen"), t("Rechte"), t("darf Nyx"), t("Sicherheit")],
    panels: [{ id: "zugriff", title: t("Zugriff & Freigaben"), Component: NyxAccessPanel }],
  },
  {
    id: "motor",
    path: "/einstellungen/nyx/motor",
    title: t("Motor & Verbrauch"),
    icon: "⏻",
    tone: "gold",
    group: "was",
    summary: t("Modell, Tages-Budget und Zeiten für Briefing und Rundgang"),
    lead: t("Womit Nyx denkt, wie viel pro Tag erlaubt ist und wann Briefing, Recap und Rundgang laufen."),
    keywords: [t("Motor"), t("Max-Plan"), t("Budget"), t("Tagesgrenze"), t("Briefing-Zeit"), t("Recap"), t("Rundgang"), t("Letzte Aufrufe"), t("Motor testen")],
    panels: [{ id: "motor", title: t("Motor & Verbrauch"), Component: EngineSection }],
    aliases: ["/einstellungen/haiku"],
    useStatus: useEngineSectionStatus,
  },
];

export const ALL_SECTIONS: readonly SettingsSection[] = [...GENERAL_SECTIONS, ...NYX_SECTIONS];

/**
 * The areas for a run mode: areas that do not exist there are left out, local texts/blocks replace the defaults.
 * Overview, search, subpages and ⌘K all go through here, so a filtered area disappears everywhere at once.
 */
export function sectionsForMode(sections: readonly SettingsSection[], mode: AppMode): SettingsSection[] {
  return sections.filter((s) => !s.modes || s.modes.includes(mode)).map((s) => (mode === "local" && s.local ? { ...s, ...s.local } : s));
}

/** Only areas with an own subpage (without the rows „Nyx“ and „Info & Hilfe“, which lead to other pages). */
export function findSection(sections: readonly SettingsSection[], id: string | undefined): SettingsSection | undefined {
  return sections.find((s) => s.id === id && !s.href);
}

/** ⌘K: every subpage + the Nyx overview + Info & Hilfe (the overview „Einstellungen“ is already a tab in the palette). */
export interface SettingsPaletteItem {
  id: string;
  label: string;
  icon: string;
  words: string;
  path: string;
}

export function settingsPaletteItems(mode: AppMode = "server"): SettingsPaletteItem[] {
  const general = sectionsForMode(GENERAL_SECTIONS, mode);
  const own = (s: SettingsSection, prefix: string): SettingsPaletteItem => ({
    id: `set-${prefix}${s.id}`,
    label: prefix ? t("Nyx: {title}", { title: s.title }) : s.title,
    icon: s.icon,
    words: [t("Einstellungen"), "settings", s.id, s.summary, ...s.keywords, ...s.panels.flatMap((p) => [p.title, ...(p.keywords ?? []), ...(p.spots ?? []).flatMap((x) => x.keywords)])]
      .join(" ")
      .toLowerCase(),
    path: s.path,
  });
  // Single spots („Ruhezeit“) as an own row that jumps exactly there – otherwise ⌘K landed at the top of the long
  // notifications page and the quiet hours sat collapsed below.
  const spots = (s: SettingsSection): SettingsPaletteItem[] =>
    s.panels.flatMap((p) =>
      (p.spots ?? []).map((spot) => ({
        id: `set-${s.id}-${spot.anchor}`,
        label: `${s.title} · ${spot.keywords[0] ?? spot.anchor}`,
        icon: s.icon,
        words: spot.keywords.join(" ").toLowerCase(),
        path: `${s.path}#${spot.anchor}`,
      })),
    );
  const info = general.find((s) => s.id === "info");
  return [
    ...general.filter((s) => !s.href).flatMap((s) => [own(s, ""), ...spots(s)]),
    {
      id: "set-nyx",
      label: t("Nyx-Einstellungen"),
      icon: "◎",
      words: [t("Einstellungen"), "settings nyx", t("Übersicht"), t("Persönlichkeit"), t("Stimme")].join(" ").toLowerCase(),
      path: NYX_SETTINGS_PATH,
    },
    ...sectionsForMode(NYX_SECTIONS, mode).map((s) => own(s, "nyx-")),
    ...(info ? [{ id: "set-info", label: info.title, icon: info.icon, words: [t("Einstellungen"), "settings info", info.summary, ...info.keywords].join(" ").toLowerCase(), path: INFO_SETTINGS_PATH }] : []),
  ];
}
