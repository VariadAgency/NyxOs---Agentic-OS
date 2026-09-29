// Zwei Knöpfe im Session-Kopf — „Kontext komprimieren“ (schickt `/compact`, nur wenn
// die Session wartet, über den Weg des Kontext-Wächters) und „Session zusammenfassen & prüfen“
// (Haiku prüft den Verlauf, das Ergebnis hängt an der Session). Gesperrt heißt nie „weg“: der Knopf
// bleibt sichtbar und sagt, warum er gerade nicht geht.
// Bei genug Platz stehen beide Knöpfe direkt in der Zeile, sonst im Menü „⋯“ — so bricht die Zeile
// nie um. Der Kopf MISST den Platz (`useFitLevel`) und sagt per `inline`, was passt; weitere
// Kopf-Aktionen („Prozess beenden“, „Schließen“) kommen bei wenig Platz als `extra` mit ins Menü.
import { t } from "@nyxos/shared";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { useTooltip } from "../../components/ui/Tooltip";
import type { Session } from "../../lib/api";
import { cn } from "../../lib/cn";
import { friendlyError } from "../../lib/friendlyError";
import { useContextGuardSession } from "../context-guard/api";
import { useBridgeStatus } from "../terminal/terminalApi";
import { useCompactWhenWaiting, useSessionAudits, useStartAudit } from "./api";
import { IconAudit, IconCompress, IconMore } from "./icons";

interface ActionState {
  disabledReason: string | null;
  run: () => void;
  pending: boolean;
}

type Notice = (text: string, tone: "ok" | "bad") => void;

function useCompactAction(session: Session, notice: Notice): ActionState & { hint: boolean } {
  const bridge = useBridgeStatus();
  const compact = useCompactWhenWaiting(session.id);
  const guard = useContextGuardSession(session.id);
  const who = session.tool === "codex" ? "Codex" : "Claude";
  const inNyxOS = !!session.attachable && !!session.tmuxName;
  const reason = !(bridge.data?.online ?? false)
    ? t("Die Brücke ist gerade nicht verbunden.")
    : !inNyxOS
      ? t("Die Session läuft nicht in NyxOS – übernimm sie zuerst.")
      : session.state !== "waiting"
        ? t("{who} arbeitet gerade – komprimieren geht, sobald die Session auf dich wartet.", { who })
        : compact.isPending
          ? t("Wird geschickt …")
          : null;
  const run = () =>
    compact.mutate(undefined, {
      onSuccess: (r) => notice(r.sent ? t("Komprimieren ist unterwegs – der Verlauf zeigt gleich „Kontext komprimiert“.") : (r.reason ?? t("Die Session arbeitet gerade – versuch es, sobald sie wartet.")), r.sent ? "ok" : "bad"),
      onError: (e) => notice(friendlyError(e, t("Komprimieren hat nicht geklappt – bitte noch einmal versuchen.")), "bad"),
    });
  // Kontext-Wächter meldet „Komprimieren empfohlen“ → Knopf hervorheben (dieselbe Abfrage wie das Badge).
  return { disabledReason: reason, run, pending: compact.isPending, hint: guard.data?.hint ?? false };
}

function useAuditAction(session: Session, notice: Notice): ActionState {
  const audits = useSessionAudits(session.id);
  const start = useStartAudit(session.id);
  const engine = audits.data?.engine;
  const running = audits.data?.audits[0]?.status === "running" || start.isPending;
  const reason = !engine
    ? t("Einen Moment – ich prüfe, ob Nyx bereit ist.")
    : engine.state === "waiting_token"
      ? t("Wartet auf Nyx-Token: Sobald du ihn einmal hinterlegt hast (Einstellungen → Nyx), geht die Prüfung.")
      : engine.state === "off"
        ? t("Nyx ist ausgeschaltet – in Einstellungen → Nyx einschalten.")
        : !engine.ready
          ? (engine.reason ?? t("Nyx ist gerade nicht bereit."))
          : running
            ? t("Die Prüfung läuft gerade – das Ergebnis erscheint rechts.")
            : null;
  // Solange ein Lauf offen ist (oder der Start unterwegs), löst ein weiterer Klick nichts aus.
  const run = () => {
    if (running) return;
    start.mutate(undefined, {
      onSuccess: () => notice(t("Nyx prüft die Session – das Ergebnis erscheint rechts bei den Infos."), "ok"),
      onError: (e) => notice(friendlyError(e, t("Die Prüfung ließ sich nicht starten – bitte noch einmal versuchen.")), "bad"),
    });
  };
  return { disabledReason: reason, run, pending: running };
}

/** Knopf mit Hinweis — der Hinweis hängt an einer Hülle, damit er auch bei gesperrtem Knopf erscheint. */
function InlineAction({ label, icon, state, warn }: { label: string; icon: ReactNode; state: ActionState; warn?: boolean }) {
  const tip = useTooltip(state.disabledReason ?? label);
  return (
    <span className="inline-flex" {...tip.triggerProps}>
      <Button variant={warn && !state.disabledReason ? "warn" : "ghost"} disabled={!!state.disabledReason} onClick={state.run} className="h-(--a-ctl-h) py-0">
        {icon}
        {label}
      </Button>
      {tip.tooltip}
    </span>
  );
}

function MenuAction({ label, icon, state, onDone }: { label: string; icon: ReactNode; state: ActionState; onDone: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={!!state.disabledReason}
      onClick={() => {
        state.run();
        onDone();
      }}
      className="grid w-full grid-cols-[18px_1fr] items-start gap-x-2 rounded-md px-2.5 py-2 text-left hover:bg-a-p3 disabled:cursor-not-allowed disabled:hover:bg-transparent"
    >
      <span className={cn("mt-px", state.disabledReason ? "text-a-mut" : "text-a-acc")}>{icon}</span>
      <span className={cn("text-caption font-medium", state.disabledReason ? "text-a-mut" : "text-a-ink")}>{label}</span>
      {state.disabledReason && <span className="col-start-2 mt-0.5 text-caption leading-snug text-a-mut">{state.disabledReason}</span>}
    </button>
  );
}

/** Zusätzlicher Menüeintrag aus dem Kopf, z. B. „Schließen“ bei wenig Platz. */
export interface ExtraMenuAction {
  label: string;
  icon?: ReactNode;
  disabledReason?: string | null;
  onSelect: () => void;
}

export function SessionActions({ session, inline = true, extra = [] }: { session: Session; inline?: boolean; extra?: ExtraMenuAction[] }) {
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice: Notice = (text, tone) => {
    setNotice({ text, tone });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 6000);
  };
  useEffect(() => () => void (noticeTimer.current && clearTimeout(noticeTimer.current)), []);
  const compact = useCompactAction(session, showNotice);
  const audit = useAuditAction(session, showNotice);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const moreTip = useTooltip(open ? null : t("Weitere Aktionen"));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const compactLabel = t("Kontext komprimieren");
  const auditLabel = t("Session zusammenfassen & prüfen");

  const showMenu = !inline || extra.length > 0;
  return (
    <div className="relative flex shrink-0 items-center">
      {inline && (
        <div className="flex items-center gap-1">
          <InlineAction label={compactLabel} icon={<IconCompress size={14} />} state={compact} warn={compact.hint} />
          <InlineAction label={auditLabel} icon={<IconAudit size={14} />} state={audit} />
        </div>
      )}
      {showMenu && (
        <div ref={wrap} className="relative">
          <Button variant="ghost" aria-label={t("Weitere Aktionen")} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="h-(--a-ctl-h) w-(--a-ctl-h) px-0 py-0" {...moreTip.triggerProps}>
            <IconMore size={16} />
            {!inline && compact.hint && !compact.disabledReason && <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-a-wait" aria-hidden="true" />}
          </Button>
          {moreTip.tooltip}
          {open && (
            <div role="menu" aria-label={t("Weitere Aktionen")} className="absolute top-full right-0 z-30 mt-1.5 grid w-80 gap-0.5 rounded-lg border border-a-line bg-a-p2 p-1.5 shadow-xl shadow-black/40">
              {!inline && <MenuAction label={compactLabel} icon={<IconCompress size={15} />} state={compact} onDone={() => setOpen(false)} />}
              {!inline && <MenuAction label={auditLabel} icon={<IconAudit size={15} />} state={audit} onDone={() => setOpen(false)} />}
              {extra.map((x) => (
                <MenuAction
                  key={x.label}
                  label={x.label}
                  icon={x.icon ?? <span aria-hidden="true">·</span>}
                  state={{ disabledReason: x.disabledReason ?? null, run: x.onSelect, pending: false }}
                  onDone={() => setOpen(false)}
                />
              ))}
            </div>
          )}
        </div>
      )}
      {notice && !open && (
        <p role="status" className={cn("absolute top-full right-0 z-30 mt-1.5 w-72 rounded-md border bg-a-p2 px-2.5 py-2 text-caption leading-snug shadow-lg shadow-black/40", notice.tone === "ok" ? "border-a-acc/40 text-a-ink" : "border-a-wait/40 text-a-wait")}>
          {notice.text}
        </p>
      )}
    </div>
  );
}
