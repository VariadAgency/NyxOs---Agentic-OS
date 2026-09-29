// „Steuerung“ in den Session-Infos (rechte Spalte + Handy-Blatt „⋯“): Modell wechseln, Denkaufwand,
// Kontext komprimieren. Angeboten wird nur, was das Werkzeug wirklich kann (Server: `sessionControlsFor`).
// Alles geht über die sichere Zustellung: arbeitet die Session, wartet der Befehl auf ihre nächste Pause.
// `/compact` steht NUR hier (nicht mehr im Session-Kopf) und nutzt den Weg des Kontext-Wächters.
import { effortLabel, t, type EffortLevel, type SessionControlRequest } from "@nyxos/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import type { Session } from "../../lib/api";
import { cn } from "../../lib/cn";
import { friendlyError } from "../../lib/friendlyError";
import { useCompactNow, useContextGuardSession } from "../context-guard/api";
import { IconChip, IconCompress } from "../session-chat/icons";
import { currentModel, modelLabel } from "../session-chat/model";
import { useSessionControls, useSetSessionControl } from "./api";

type Notice = { text: string; tone: "ok" | "wait" | "bad" };
const NOTICE_MS = 8000;

/** Warum hier gerade nichts in die Session gehen kann (sonst `null`). */
export function controlsBlockedReason(session: Pick<Session, "status" | "attachable" | "tmuxName">): string | null {
  if (session.status !== "running") return t("Die Session ist beendet – Steuerung geht nur bei laufenden Sessions.");
  if (!session.attachable || !session.tmuxName) return t("Die Session läuft nicht in NyxOS – übernimm sie zuerst.");
  return null;
}

const ROW_BTN = "min-h-9 pointer-coarse:min-h-11";

function Label({ children }: { children: string }) {
  return <h6 className="font-mono text-label font-semibold tracking-wide text-a-mut uppercase">{children}</h6>;
}

export function SessionControls({ session }: { session: Session }) {
  const model = currentModel(session);
  const controls = useSessionControls(session.id, model);
  const set = useSetSessionControl(session.id);
  const compact = useCompactNow(session.id);
  const guard = useContextGuardSession(session.id);
  const qc = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickedEffort, setPickedEffort] = useState<EffortLevel | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const show = (n: Notice) => {
    setNotice(n);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  };
  const blocked = controlsBlockedReason(session);

  const send = (req: SessionControlRequest) =>
    set.mutate(req, {
      onSuccess: (r) => {
        show({ text: r.message, tone: r.status === "sent" ? "ok" : "wait" });
        if (req.kind === "effort") setPickedEffort(req.level);
        if (req.kind === "model") setPickerOpen(false);
      },
      onError: (e) => show({ text: friendlyError(e, t("Das hat gerade nicht geklappt – bitte noch einmal versuchen.")), tone: "bad" }),
    });

  const runCompact = () =>
    compact.mutate(undefined, {
      onSuccess: (r) => show(r.sent ? { text: t("Komprimieren ist unterwegs – der Verlauf zeigt gleich „Kontext komprimiert“."), tone: "ok" } : { text: t("Komprimieren kommt, sobald die Session auf dich wartet."), tone: "wait" }),
      onError: (e) => show({ text: friendlyError(e, t("Komprimieren hat nicht geklappt – bitte noch einmal versuchen.")), tone: "bad" }),
      onSettled: () => void qc.invalidateQueries({ queryKey: ["deliveries", session.id] }),
    });

  const view = controls.data;
  const current = view?.model.options.find((m) => m.current);
  const busy = set.isPending || compact.isPending;

  return (
    <section aria-label={t("Steuerung")} data-testid="session-controls" className="grid min-w-0 gap-3 rounded-lg border border-a-line bg-a-p p-3">
      <div className="flex items-center gap-2">
        <h5 className="font-mono text-label font-semibold tracking-wide text-a-mut uppercase">{t("Steuerung")}</h5>
        {blocked && <span className="min-w-0 text-caption leading-snug text-a-mut">· {blocked}</span>}
      </div>

      {controls.isPending ? (
        <Skeleton className="h-16" />
      ) : controls.isError || !view ? (
        <div className="flex flex-wrap items-center gap-2 text-caption text-a-wait">
          {t("Die Steuerung ließ sich nicht laden.")}
          <Button variant="ghost" onClick={() => void controls.refetch()} className={ROW_BTN}>
            {t("Erneut versuchen")}
          </Button>
        </div>
      ) : (
        <>
          {/* Modell */}
          <div className="grid gap-1.5">
            <Label>{t("Modell")}</Label>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="inline-flex min-w-0 items-center gap-1.5 text-caption text-a-ink" title={model ?? undefined}>
                <IconChip size={14} className="shrink-0 text-a-magenta" />
                <span className="truncate">{current?.name.replace(/^Claude /, "") ?? (model ? modelLabel(model) : t("Noch unbekannt"))}</span>
              </span>
              {view.model.canSwitch && (
                <Button variant="ghost" aria-expanded={pickerOpen} aria-controls="session-model-picker" disabled={!!blocked} title={blocked ?? undefined} onClick={() => setPickerOpen((v) => !v)} className={cn(ROW_BTN, "ml-auto")}>
                  {pickerOpen ? t("Zuklappen") : t("Wechseln")}
                </Button>
              )}
            </div>
            {!view.model.canSwitch && view.model.reason && <p className="text-caption leading-snug text-a-mut">{view.model.reason}</p>}
            {pickerOpen && view.model.canSwitch && (
              <ul id="session-model-picker" aria-label={t("Mögliche Modelle")} className="grid gap-1">
                {view.model.options.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      disabled={m.current || busy || !!blocked}
                      aria-current={m.current || undefined}
                      aria-label={`${m.name.replace(/^Claude /, "")}${m.current ? ` (${t("aktiv")})` : ""}${m.hint ? ` – ${m.hint}` : ""}`}
                      onClick={() => send({ kind: "model", model: m.id })}
                      title={m.id}
                      className={cn(
                        ROW_BTN,
                        "grid w-full grid-cols-[1fr_auto] items-center gap-x-2 rounded-md border px-2.5 py-1.5 text-left transition-colors",
                        m.current ? "border-a-acc/40 bg-a-acc/10" : "border-a-line hover:bg-a-p2 disabled:cursor-not-allowed disabled:opacity-60",
                      )}
                    >
                      <span className="min-w-0 truncate text-caption font-medium text-a-ink">{m.name.replace(/^Claude /, "")}</span>
                      <span className="text-label text-a-mut">{m.current ? t("aktiv") : ""}</span>
                      {m.hint && <span className="col-span-2 text-label leading-snug text-a-mut">{m.hint}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Denkaufwand – nur, wenn Werkzeug + Modell es kennen */}
          <div className="grid gap-1.5">
            <Label>{t("Denkaufwand")}</Label>
            {view.effort.canSet ? (
              <>
                <div role="group" aria-label={t("Denkaufwand")} className="flex flex-wrap gap-1">
                  {view.effort.levels.map((l) => (
                    <Button
                      key={l}
                      variant={pickedEffort === l ? "primary" : "default"}
                      aria-pressed={pickedEffort === l}
                      disabled={busy || !!blocked}
                      onClick={() => send({ kind: "effort", level: l })}
                      className={cn(ROW_BTN, "px-2.5")}
                    >
                      {effortLabel(l)}
                    </Button>
                  ))}
                </div>
                <p className="text-label leading-snug text-a-mut">{t("Die aktuelle Stufe meldet {who} nicht zurück – markiert ist deine letzte Wahl hier.", { who: session.tool === "codex" ? "Codex" : "Claude" })}</p>
              </>
            ) : (
              <p className="text-caption leading-snug text-a-mut">{view.effort.reason}</p>
            )}
          </div>

          {/* Komprimieren (früher im Kopf) */}
          <div className="grid gap-1.5">
            <Label>{t("Kontext")}</Label>
            {view.compact.available ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant={guard.data?.hint && !blocked ? "warn" : "default"} disabled={busy || !!blocked} onClick={runCompact} className={ROW_BTN}>
                  <IconCompress size={14} />
                  {t("Kontext komprimieren")}
                </Button>
                {session.contextPct !== null && <span className="text-caption text-a-mut">{t("{pct} % voll", { pct: session.contextPct })}{guard.data?.hint ? ` – ${t("komprimieren empfohlen")}` : ""}</span>}
              </div>
            ) : (
              <p className="text-caption leading-snug text-a-mut">{view.compact.reason}</p>
            )}
          </div>
        </>
      )}

      {notice && (
        <p role="status" className={cn("rounded-md border px-2.5 py-2 text-caption leading-snug", notice.tone === "ok" ? "border-a-acc/40 text-a-ink" : notice.tone === "wait" ? "border-a-wait/40 text-a-wait" : "border-a-bad/40 text-a-bad")}>
          {notice.text}
        </p>
      )}
    </section>
  );
}
