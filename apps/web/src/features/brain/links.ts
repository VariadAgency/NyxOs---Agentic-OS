// Wohin führt ein Knoten? (Doppelklick = öffnen, Seitenblatt-Knopf „Öffnen")
import { t, type GraphNode } from "@nyxos/shared";

export type OpenTarget = { kind: "route"; to: string; label: string } | { kind: "external"; href: string; label: string } | null;

export function openTarget(n: GraphNode): OpenTarget {
  const r = n.ref;
  switch (r.kind) {
    case "session":
      return { kind: "route", to: `/sessions/${r.art}/${r.baustelleSlug ?? "_"}/${r.sessionId}`, label: t("Session öffnen") };
    case "art":
      return { kind: "route", to: `/sessions/${r.art}`, label: t("Sessions dieser Art") };
    case "entry":
      // `EntryOverlay` ist global gemountet (App.tsx) und liest `?e=` unabhängig
      // vom Pfad — `/tasks` reicht als Basis, auch für Ideen/Audits (derselbe Eintrags-Stapel).
      return { kind: "route", to: `/tasks?e=${encodeURIComponent(r.id)}`, label: t("Eintrag öffnen") };
    case "commit":
    case "branch":
      return null; // noch keine eigene Großansicht für Commits/Zweige
    case "note":
      if (!r.path) return null;
      // Ohne Vault-Namen öffnet Obsidian die Datei im zuletzt genutzten Vault.
      return {
        kind: "external",
        href: `obsidian://open?${r.vault ? `vault=${encodeURIComponent(r.vault)}&` : ""}file=${encodeURIComponent(r.path.replace(/\.md$/i, ""))}`,
        label: t("In Obsidian öffnen"),
      };
    default:
      return null;
  }
}
