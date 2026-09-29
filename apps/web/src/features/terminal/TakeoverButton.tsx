import { t, tc } from "@nyxos/shared";
import { useState } from "react";
import { friendlyError } from "../../lib/friendlyError";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import type { Session } from "../../lib/api";
import { useBridgeStatus, useTakeover, useTakeoverPreview, type TakeoverPreview } from "./terminalApi";

type Preview = Extract<TakeoverPreview, { attachable: false }>;

interface TakeoverButtonProps {
  session: Pick<Session, "id" | "tool" | "title">;
  /** Nach dem Übernehmen (Session läuft jetzt in der NyxOS), z. B. zum Terminal-Reiter wechseln. */
  onDone?: () => void;
  /** „Nur mitlesen“ gewählt, z. B. zum Chat-Reiter wechseln. */
  onWatch?: () => void;
  className?: string;
  /** Kurze Beschriftung im engen Kopf, der volle Text steht dann im Hinweis. */
  short?: boolean;
}

const toolName = (tool: string) => (tool === "codex" ? "Codex" : "Claude");

/**
 * „In der NyxOS übernehmen“: holt eine Session, die in einem eigenen Fenster auf dem Rechner läuft
 * (Terminal, iTerm, VS Code …), per `--resume` in die NyxOS. Läuft dort noch ein Programm, fragt ein Dialog
 * ehrlich nach: altes Fenster sauber beenden oder nur mitlesen. Beendet wird nur nach Klick und nur genau das
 * Programm, das der Dialog zeigt. Läuft nichts mehr, wird ohne Dialog fortgesetzt.
 *
 * Wiederverwendbar (z. B. im Chat-Eingabefeld): `<TakeoverButton session={session} />`.
 */
export function TakeoverButton({ session, onDone, onWatch, className, short = false }: TakeoverButtonProps) {
  const bridge = useBridgeStatus();
  const online = bridge.data?.online ?? false;
  const preview = useTakeoverPreview();
  const takeover = useTakeover();
  const [dialog, setDialog] = useState<Preview | null>(null);
  const busy = preview.isPending || takeover.isPending;
  const error = (dialog ? null : (preview.error ?? takeover.error)) ?? null;

  const run = (endPids: number[]) =>
    takeover.mutate(
      { session, endPids },
      {
        onSuccess: () => {
          setDialog(null);
          onDone?.();
        },
      },
    );

  const start = () => {
    takeover.reset();
    preview.mutate(session, {
      onSuccess: (p) => {
        if (p.attachable) return onDone?.();
        if (p.inNyxOS || p.processes.length === 0) return run([]);
        setDialog(p);
      },
    });
  };

  return (
    <>
      <Button variant="primary" onClick={start} disabled={!online || busy} aria-label={short && !busy ? t("In NyxOS übernehmen") : undefined} title={online ? (short ? t("In NyxOS übernehmen") : undefined) : t("Die Brücke ist gerade nicht verbunden")} className={className}>
        {busy ? t("Übernehme …") : short ? tc("terminal", "Übernehmen") : t("In NyxOS übernehmen")}
      </Button>
      {error && (
        <span role="alert" className="basis-full text-caption text-a-wait">
          {friendlyError(error, t("Übernehmen hat nicht geklappt – bitte noch einmal versuchen."))}
        </span>
      )}
      {dialog && (
        <TakeoverDialog
          preview={dialog}
          title={session.title}
          pending={takeover.isPending}
          error={takeover.error ? friendlyError(takeover.error, t("Übernehmen hat nicht geklappt – bitte noch einmal versuchen.")) : null}
          onEnd={() => run(dialog.processes.map((p) => p.pid))}
          onWatch={() => {
            setDialog(null);
            onWatch?.();
          }}
          onCancel={() => setDialog(null)}
        />
      )}
    </>
  );
}

function TakeoverDialog(props: { preview: Preview; title: string | null; pending: boolean; error: string | null; onEnd: () => void; onWatch: () => void; onCancel: () => void }) {
  const { preview, pending } = props;
  const tool = toolName(preview.tool);
  const apps = [...new Set(preview.processes.map((p) => p.app).filter((a): a is string => !!a))];
  const appList = apps.join(", ");
  const whereText = props.title
    ? appList
      ? t("läuft mit „{title}“ gerade im Fenster „{apps}“ auf deinem Rechner.", { title: props.title, apps: appList })
      : t("läuft mit „{title}“ gerade in einem eigenen Fenster auf deinem Rechner.", { title: props.title })
    : appList
      ? t("läuft gerade im Fenster „{apps}“ auf deinem Rechner.", { apps: appList })
      : t("läuft gerade in einem eigenen Fenster auf deinem Rechner.");
  const pids = preview.processes.map((p) => p.pid).join(", ");
  const many = preview.processes.length > 1;
  const endFirst = preview.recommended !== "watch";

  const endOption = (
    <OptionButton
      key="end"
      primary={endFirst}
      autoFocus={endFirst}
      disabled={pending}
      onClick={props.onEnd}
      title={pending ? t("Beende altes Fenster …") : t("Altes Fenster beenden und hier weitermachen")}
      text={
        many
          ? t("Beendet sauber nur diese {n} Programme (Nr. {pids}). Der Verlauf bleibt vollständig. Das alte Fenster zeigt danach wieder die normale Eingabezeile – du kannst es schließen.", { n: preview.processes.length, pids })
          : t("Beendet sauber nur dieses eine Programm (Nr. {pids}). Der Verlauf bleibt vollständig. Das alte Fenster zeigt danach wieder die normale Eingabezeile – du kannst es schließen.", { pids })
      }
    />
  );
  const watchOption = (
    <OptionButton
      key="watch"
      primary={!endFirst}
      autoFocus={!endFirst}
      disabled={pending}
      onClick={props.onWatch}
      title={t("Nur mitlesen")}
      text={t("Das alte Fenster läuft weiter. Du siehst den Verlauf hier im Chat live mit, tippen geht weiter nur dort.")}
    />
  );

  return (
    <div className="fixed inset-0 z-50 grid place-items-center cc-scrim cc-sheet-wrap p-4" role="presentation" onClick={props.onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="takeover-title"
        className="cc-sheet grid w-full max-w-md gap-3 rounded-2xl border border-a-line bg-a-p2 p-4 shadow-pop"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && props.onCancel()}
      >
        <h2 id="takeover-title" className="font-display text-callout font-semibold text-a-ink">
          {t("In NyxOS übernehmen?")}
        </h2>
        <p className="text-caption text-a-mut">
          <span className="font-medium" style={{ color: `var(--a-${preview.tool})` }}>
            {tool}
          </span>{" "}
          {whereText}{" "}
          {t("Zwei Programme dürfen nicht gleichzeitig an derselben Session arbeiten, sonst geraten die Verläufe durcheinander. Darum: entweder das alte Fenster beenden oder hier nur mitlesen.")}
        </p>
        {preview.working && (
          <p className="rounded-md border border-a-wait/40 bg-a-wait/10 px-2.5 py-1.5 text-caption text-a-wait">
            {t("{tool} arbeitet gerade an einer Antwort. Beim Beenden bricht diese Antwort ab – der Verlauf bis dahin bleibt.", { tool })}
          </p>
        )}
        <div className="grid gap-2">{endFirst ? [endOption, watchOption] : [watchOption, endOption]}</div>
        {props.error && (
          <p role="alert" className="text-caption text-a-bad">
            {props.error}
          </p>
        )}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={props.onCancel} disabled={pending}>
            {t("Abbrechen")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function OptionButton(p: { title: string; text: string; primary: boolean; autoFocus: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      // Vorauswahl im Dialog (Fokus), ausgelöst wird erst mit Klick/Enter.
      autoFocus={p.autoFocus}
      disabled={p.disabled}
      onClick={p.onClick}
      className={cn(
        "grid gap-0.5 rounded-md border px-3 py-2 text-left transition-colors disabled:opacity-50",
        p.primary ? "border-a-acc bg-a-acc/10 hover:bg-a-acc/20 focus-visible:outline-2 focus-visible:outline-a-acc" : "border-a-line bg-a-p2 hover:bg-a-p3",
      )}
    >
      <span className={cn("text-callout font-medium", p.primary ? "text-a-acc" : "text-a-ink")}>{p.title}</span>
      <span className="text-caption text-a-mut">{p.text}</span>
    </button>
  );
}
