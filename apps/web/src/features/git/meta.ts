// Farben und Texte der Git-Seite. Jede Art hat ihre eigene Farbe aus den Tokens (app.css) —
// App-Repo, Worktrees, NyxOS und weitere Repos sollen auf einen Blick verschieden aussehen.
// Tailwind findet Klassen nur als wörtliche Zeichenketten, deshalb stehen sie hier ausgeschrieben.
import { locale, t, type AttributionConfidence, type GitActionRowKind, type RepoKind } from "@nyxos/shared";
import { sessionLabel } from "../../lib/sessionLabel";

export interface FamilyMeta {
  label: string;
  /** Ein Satz, was das ist — ohne Fachwörter. */
  hint: string;
  color: string;
  text: string;
  soft: string;
  ring: string;
  bar: string;
}

export const FAMILY: Record<RepoKind, FamilyMeta> = {
  app: { label: t("App-Repo"), hint: t("Das Haupt-Repo deines Projekts."), color: "var(--a-teal)", text: "text-a-teal", soft: "bg-a-teal/10", ring: "border-a-teal/35", bar: "bg-a-teal" },
  worktree: { label: t("Worktrees"), hint: t("Eigene Arbeitskopien des App-Repos, je Auftrag eine."), color: "var(--a-violet)", text: "text-a-violet", soft: "bg-a-violet/10", ring: "border-a-violet/35", bar: "bg-a-violet" },
  nyxos: { label: "NyxOS", hint: t("Dieses Werkzeug. Jeder Agent arbeitet in seiner eigenen Arbeitskopie."), color: "var(--a-lime)", text: "text-a-lime", soft: "bg-a-lime/10", ring: "border-a-lime/35", bar: "bg-a-lime" },
  other: { label: t("Weitere Repos"), hint: t("Andere Repos, in denen Sessions gearbeitet haben."), color: "var(--a-indigo)", text: "text-a-indigo", soft: "bg-a-indigo/10", ring: "border-a-indigo/35", bar: "bg-a-indigo" },
};

export const CONFIDENCE: Record<AttributionConfidence, { label: string; cls: string; hint: string }> = {
  sicher: { label: t("sicher"), cls: "bg-a-ok/12 text-a-ok", hint: t("Die Session hat den Git-Befehl selbst ausgeführt, kurz vorher, im selben Ordner.") },
  wahrscheinlich: { label: t("wahrscheinlich"), cls: "bg-a-acc/12 text-a-acc", hint: t("Ein passender Git-Befehl, aber nicht ganz eindeutig (Zeit, Ordner oder mehrere Sessions).") },
  vermutet: { label: t("vermutet"), cls: "bg-a-wait/12 text-a-wait", hint: t("Kein Git-Befehl gefunden — die Session war nur zur selben Zeit im selben Ordner aktiv.") },
  keine: { label: t("ohne Session"), cls: "bg-a-indigo/12 text-a-indigo", hint: t("Keine Session passt — vermutlich von Hand gemacht.") },
};

export const ACTION: Record<GitActionRowKind, { cls: string; icon: string }> = {
  merge: { cls: "bg-a-violet/12 text-a-violet", icon: "⤵" },
  pull: { cls: "bg-a-acc/12 text-a-acc", icon: "↓" },
  push: { cls: "bg-a-ok/12 text-a-ok", icon: "↑" },
  reset: { cls: "bg-a-bad/12 text-a-bad", icon: "↺" },
  checkout: { cls: "bg-a-done/12 text-a-done", icon: "⇄" },
  rebase: { cls: "bg-a-wait/12 text-a-wait", icon: "≋" },
  "cherry-pick": { cls: "bg-a-conf/12 text-a-conf", icon: "◆" },
  revert: { cls: "bg-a-bad/12 text-a-bad", icon: "⟲" },
  amend: { cls: "bg-a-wait/12 text-a-wait", icon: "✎" },
  commit: { cls: "bg-a-indigo/12 text-a-indigo", icon: "●" },
  worktree: { cls: "bg-a-violet/12 text-a-violet", icon: "⊕" },
  other: { cls: "bg-a-indigo/12 text-a-indigo", icon: "·" },
  "probe-merge": { cls: "bg-a-lime/12 text-a-lime", icon: "✓" },
  catchup: { cls: "bg-a-lime/12 text-a-lime", icon: "⤓" },
  reservation: { cls: "bg-a-indigo/12 text-a-indigo", icon: "⚑" },
};

export const GROUP_META: Record<string, { label: string; bar: string; text: string }> = {
  code: { label: t("Code"), bar: "bg-a-acc", text: "text-a-acc" },
  doku: { label: t("Doku"), bar: "bg-a-done", text: "text-a-done" },
  projekt: { label: t("Projekt"), bar: "bg-a-wait", text: "text-a-wait" },
  verschoben: { label: t("Verschoben"), bar: "bg-a-conf", text: "text-a-conf" },
};

export function toolColor(tool: string): string {
  return tool === "codex" ? "var(--a-codex)" : "var(--a-claude)";
}

/** Anzeigename einer Session – dieselbe Regel wie überall (`sessionLabel`), nie eine Kurz-ID. */
export function sessionName(s: { title: string | null; tool: string; key: string; cwd?: string | null; lastActivityAt?: string | null }): string {
  return sessionLabel({ title: s.title, tool: s.tool, cwd: s.cwd ?? null, lastActivityAt: s.lastActivityAt ?? null });
}

/** Link zur Session im Sessions-Tab (dasselbe Muster wie in der Aufgaben-Großansicht). */
export function sessionHref(key: string): string {
  return `/sessions/_/_/${encodeURIComponent(key)}`;
}

const nf = new Intl.NumberFormat(locale());
export function num(n: number): string {
  return nf.format(n);
}

/** Letzter Pfadteil — Ordnernamen statt ganzer Pfade in Listen (voller Pfad im `title`). */
export function lastPart(path: string | null): string {
  if (!path) return "";
  return path.split("/").filter(Boolean).pop() ?? path;
}
