// Gemeinsame Beschriftungen und Helfer für Entscheidungs-Karten und die Großansicht (vorher in InboxView).
import type { Approval, DecisionRefKind, InboxItem } from "@nyxos/shared";
import { t } from "@nyxos/shared";
import { useSessionDetail } from "../../hooks/useSessionApi";
import { sessionLabel } from "../../lib/sessionLabel";

/** Dauer der Ausblende-Bewegung (haiku.css `.cc-leave`) + etwas Luft, bevor neu geladen wird. */
export const LEAVE_MS = 220;

export const KIND_LABEL: Record<InboxItem["kind"], string> = { frage: t("Frage"), plan: t("Plan"), eskalation: t("Eskalation") };

export const ESCALATION_LABEL: Record<string, string> = {
  produkt: t("Produktentscheidung"),
  datenverlust: t("Datenverlust möglich"),
  budget: t("Budget"),
  build_rot: t("Build rot"),
  fremder_bereich: t("Fremder Bereich"),
};

export const CREATED_BY: Record<InboxItem["createdBy"], string> = { haiku: t("von Nyx"), session: t("aus einer Session"), regeln: t("aus den Regeln") };

export const APPROVAL_STATUS: Record<Approval["status"], string> = {
  pending: t("offen"),
  approved: t("freigegeben"),
  denied: t("abgelehnt"),
  consumed: t("freigegeben · genutzt"),
  expired: t("abgelaufen"),
};

export function basename(path: string | null): string | null {
  if (!path) return null;
  return path.split("/").filter(Boolean).pop() ?? null;
}

export function answerLabel(item: InboxItem): string {
  if (item.status === "dismissed") return t("verworfen");
  const opt = item.options.find((o) => o.id === item.answer?.optionId);
  const text = item.answer?.text?.trim();
  return [opt?.label, text].filter(Boolean).join(" · ") || t("beantwortet");
}

export function deliveryText(item: InboxItem): string {
  const parts: string[] = [];
  const d = item.delivery;
  if (d?.toSession === "sent") parts.push(t("an Session geschickt"));
  // Session arbeitete gerade — die Antwort geht raus, sobald sie auf dich wartet.
  else if (d?.toSession === "queued") parts.push(t("geht an die Session, sobald sie auf dich wartet"));
  else if (d?.toSession === "failed") parts.push(t("Session nicht erreicht"));
  if (d?.decisionCommit) parts.push(t("in {file} eingetragen (Commit {sha})", { file: basename(item.decisionFile) ?? "ENTSCHEIDUNGEN.md", sha: d.decisionCommit.slice(0, 7) }));
  if (d?.note) parts.push(d.note);
  return parts.length > 0 ? t("Antwort gespeichert: {details}", { details: parts.join(" · ") }) : t("Antwort gespeichert");
}

/** Erste Zeile der Begründung ohne „Vorschlag von Nyx (nicht aus Regeln):“ (bzw. die englische Fassung). */
export const sortReason = (body: string | null) =>
  (body ?? "")
    .split("\n")[0]
    ?.replace(/^(?:Vorschlag von|Suggestion (?:from|by)) (?:Nyx|Haiku)[^:]*:\s*/i, "")
    .trim() ?? "";

/** Session mit ihrem Namen statt „Session claude:bdccc84e-…“ (aus dem Cache, sonst neutral). */
export function SessionName({ sessionKey }: { sessionKey: string }) {
  const { data } = useSessionDetail(sessionKey);
  return <>{data?.session ? sessionLabel(data.session) : t("eine Session")}</>;
}

// ─── Adresse der Großansicht ───
// Die Adressen `/inbox#inbox-<id>` und `/inbox#approval-<id>` gibt es schon (Überblick, Berichte, Quellen-Chips,
// Telegram) – sie öffnen jetzt die Großansicht. Teilbar, Zurück/Esc schließt.

export interface DecisionRef {
  kind: DecisionRefKind;
  id: number;
}

export const decisionHash = (r: DecisionRef) => `${r.kind === "approval" ? "approval" : "inbox"}-${r.id}`;
export const decisionHref = (r: DecisionRef) => `/inbox#${decisionHash(r)}`;

export function parseDecisionHash(hash: string): DecisionRef | null {
  const m = /^#?(inbox|approval)-(\d{1,12})$/.exec(hash.trim());
  if (!m) return null;
  const id = Number(m[2]);
  return Number.isSafeInteger(id) && id > 0 ? { kind: m[1] === "approval" ? "approval" : "inbox", id } : null;
}

const INTERACTIVE = "a,button,input,textarea,select,label,summary,form,[data-card-ignore],[role=button]";

/**
 * Klick irgendwo auf die Karte (nicht auf Knöpfe, Felder, Links, Nyx' Einschätzung, nicht beim Markieren von
 * Text) öffnet die Großansicht. Tastatur: der Titel ist ein Link.
 */
export function cardClickOpens(open: () => void) {
  return (e: { target: EventTarget | null; defaultPrevented: boolean }) => {
    if (e.defaultPrevented) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest(INTERACTIVE)) return;
    if (typeof window !== "undefined" && (window.getSelection?.()?.toString() ?? "").length > 0) return;
    open();
  };
}
