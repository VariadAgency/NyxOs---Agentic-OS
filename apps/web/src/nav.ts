// Sidebar entries: order and separators. Labels are translated once at load (the language is set before).
import { t } from "@nyxos/shared";

interface NavActive {
  id: string;
  label: string;
  icon: string;
  status: "active";
  path: string;
  /** Counter on the right (open decisions + approvals). */
  badge?: "inbox";
  /** Name in local mode (NyxOS on the user's own computer); the route stays the same. */
  localLabel?: string;
}

interface NavSoon {
  id: string;
  label: string;
  icon: string;
  status: "soon";
  hint: string;
}

export type NavItem = NavActive | NavSoon;

export const NAV_GROUPS: NavItem[][] = [
  // Nyx at the very top (full-screen tab with net, voice and right panel).
  [{ id: "nyx", label: "Nyx", icon: "◎", status: "active", path: "/nyx" }],
  [
    { id: "brief", label: t("Briefing"), icon: "☀", status: "active", path: "/briefing" },
    { id: "inbox", label: t("Entscheidungen"), icon: "⚖", status: "active", path: "/inbox", badge: "inbox" },
    { id: "dash", label: t("Überblick"), icon: "◉", status: "active", path: "/overview" },
    { id: "ses", label: "Sessions", icon: "▣", status: "active", path: "/sessions" },
    { id: "brain", label: t("Gehirn"), icon: "✺", status: "active", path: "/gehirn" },
    { id: "task", label: t("Aufgaben"), icon: "☰", status: "active", path: "/tasks" },
    // Skills appear only ONCE in the sidebar; the agents page links to the library via „Skills →“.
    { id: "agent", label: t("Agenten"), icon: "⚙", status: "active", path: "/agents" },
    { id: "skills", label: "Skills", icon: "❖", status: "active", path: "/skills" },
    { id: "conf", label: t("Konflikte"), icon: "⚠", status: "active", path: "/conflicts" },
  ],
  [
    { id: "git", label: "Git", icon: "⎇", status: "active", path: "/git" },
    { id: "srv", label: t("Server"), localLabel: t("Dieser Rechner"), icon: "☁", status: "active", path: "/server" },
    { id: "use", label: t("Nutzung"), icon: "◔", status: "active", path: "/usage" },
  ],
  [
    { id: "idea", label: t("Ideen"), icon: "✦", status: "active", path: "/ideas" },
    { id: "audits", label: t("Audits"), icon: "⚑", status: "active", path: "/audits" },
    { id: "dateien", label: t("Dateien"), icon: "▤", status: "active", path: "/files" },
  ],
  [{ id: "settings", label: t("Einstellungen"), icon: "⛭", status: "active", path: "/settings" }],
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flat();

/** Label shown for an entry: in local mode „Server“ is „Dieser Rechner“. */
export function navLabel(item: NavItem, local: boolean): string {
  return local && item.status === "active" && item.localLabel ? item.localLabel : item.label;
}

/** Local-mode names by first path segment (e.g. `server` → „Dieser Rechner“). */
export const LOCAL_SEGMENT_LABELS: Record<string, string> = Object.fromEntries(
  NAV_ITEMS.flatMap((item) => (item.status === "active" && item.localLabel ? [[item.path.split("/")[1] ?? "", item.localLabel]] : [])),
);
