// Building blocks of the settings page "Mitteilungen".
// Everything with tap targets ≥ 44 px, keyboard and aria-* – the page has to work on a phone (390 px) just as well.
import { t, type NtfyTarget, type PushChannel, type PushChannelResult, type PushSubscribeInfo } from "@nyxos/shared";
import { useQuery } from "@tanstack/react-query";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { encode } from "uqr";
import { cn } from "../../lib/cn";
import { friendlyError } from "../../lib/friendlyError";
import { browserPermission, requestBrowserPermission, type BrowserPermission } from "../push/browserNotify";
import { authFetch } from "../terminal/authClient";

/** Section of the page: heading, one sentence of explanation, content. */
export function Section({ id, title, intro, children }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="grid min-w-0 scroll-mt-4 gap-3">
      <div className="grid gap-1">
        <h2 id={`${id}-title`} className="font-display text-headline font-semibold text-a-ink">
          {title}
        </h2>
        {intro && <p className="text-callout text-a-mut">{intro}</p>}
      </div>
      {children}
    </section>
  );
}

/** German source texts; translated where they are shown (`channelLabel`). */
const CHANNEL_LABEL_DE: Record<PushChannel, { title: string; text: string }> = {
  mac: { title: "Rechner", text: "Mitteilung oben rechts auf deinem Rechner – kommt über die Brücke, braucht nichts weiter." },
  browser: { title: "Browser", text: "Mitteilung, solange ein NyxOS-Fenster offen ist (auch am Handy, wenn NyxOS dort offen ist)." },
  ntfy: { title: "Handy (App ntfy)", text: "Mitteilung aufs Handy, auch wenn NyxOS zu ist." },
};

export function channelLabel(c: PushChannel): { title: string; text: string } {
  const de = CHANNEL_LABEL_DE[c];
  return { title: t(de.title), text: t(de.text) };
}

export function isPushChannel(c: string): c is PushChannel {
  return c in CHANNEL_LABEL_DE;
}

export const BTN =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-a-line bg-a-p px-3 font-mono text-caption text-a-mut transition-colors hover:text-a-ink focus-visible:outline-2 focus-visible:outline-a-acc disabled:opacity-50 sm:min-h-9";
export const BTN_ACCENT = "border-a-acc/40 text-a-acc hover:text-a-acc";
export const FIELD =
  "min-h-11 w-full rounded-lg border border-a-line bg-a-p2 px-2.5 font-mono text-callout text-a-ink focus:border-a-acc focus:outline-none sm:min-h-9";
export const LABEL = "font-mono text-label uppercase tracking-wide text-a-mut";

/**
 * Native select with our own arrow: `appearance-none`, otherwise WebKit ignores the height (tap target ≥ 44 px) and
 * draws its own control. The list itself stays the system one (best on phones).
 */
export function SelectField({ value, onChange, children, testId, className }: { value: string; onChange: (v: string) => void; children: ReactNode; testId?: string; className?: string }) {
  return (
    <span className={cn("relative block w-full sm:w-auto", className)}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
        data-select-field=""
        className="min-h-11 w-full appearance-none rounded-lg border border-a-line bg-a-p2 pr-8 pl-2.5 text-callout text-a-ink focus:border-a-acc focus:outline-none sm:min-h-9"
      >
        {children}
      </select>
      <span aria-hidden className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-a-mut">
        ▾
      </span>
    </span>
  );
}

/** Switch (iOS style). Use it alone only with `label`, otherwise inside `SwitchRow`. */
export function Toggle({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn("relative h-6 w-11 shrink-0 rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-a-acc disabled:opacity-50", on ? "border-a-acc/60 bg-a-acc/30" : "border-a-line bg-a-p")}
    >
      <span className={cn("absolute top-0.5 h-4.5 w-4.5 rounded-full transition-all", on ? "left-5.5 bg-a-acc" : "left-0.5 bg-a-mut")} />
    </button>
  );
}

/** Whole row tappable: title + sentence on the left, switch on the right. */
export function SwitchRow({ title, hint, on, onChange, disabled, testId }: { title: string; hint?: ReactNode; on: boolean; onChange: (v: boolean) => void; disabled?: boolean; testId?: string }) {
  const id = useId();
  return (
    <div className="flex min-h-11 items-start justify-between gap-3 rounded-lg px-1 py-2">
      <div className="min-w-0">
        <label htmlFor={id} className="block cursor-pointer text-callout text-a-ink">
          {title}
        </label>
        {hint && <p className="text-caption text-a-mut">{hint}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={on}
        data-testid={testId}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className="-my-2 -mr-1 flex min-h-11 min-w-14 shrink-0 items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:outline-a-acc disabled:opacity-50"
      >
        <span className={cn("relative h-6 w-11 rounded-full border transition-colors", on ? "border-a-acc/60 bg-a-acc/30" : "border-a-line bg-a-p")}>
          <span className={cn("absolute top-0.5 h-4.5 w-4.5 rounded-full transition-all", on ? "left-5.5 bg-a-acc" : "left-0.5 bg-a-mut")} />
        </span>
      </button>
    </div>
  );
}

/** Choice from a few options (radio group with arrow keys). Full width on the phone. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
  testId,
  compact,
}: {
  label: string;
  options: { value: T; label: string; tone?: "ok" | "wait" | "mut" }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
  testId?: string;
  /** Fixed width from tablet up (in rows next to a text), full width on the phone. */
  compact?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // Arrow keys: select AND move the focus along (otherwise it would stay on the old, no longer focusable button);
  // while saving, no further steps from the outdated value.
  const move = (dir: 1 | -1) => {
    if (disabled) return;
    const i = options.findIndex((o) => o.value === value);
    const n = (i + dir + options.length) % options.length;
    const next = options[n];
    if (!next) return;
    onChange(next.value);
    requestAnimationFrame(() => refs.current[n]?.focus());
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      className={cn("grid w-full auto-cols-fr grid-flow-col gap-0.5 rounded-lg border border-a-line bg-a-p p-0.5", compact && "sm:w-80 sm:shrink-0")}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        }
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {options.map((o, idx) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[idx] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            // aria-disabled instead of disabled: the focus survives saving (keyboard use).
            aria-disabled={disabled || undefined}
            onClick={() => !active && !disabled && onChange(o.value)}
            className={cn(
              "min-h-11 rounded-md px-2.5 text-caption transition-colors focus-visible:outline-2 focus-visible:outline-a-acc aria-disabled:opacity-70 sm:min-h-8",
              active ? "bg-a-p3 font-medium text-a-ink" : "text-a-mut hover:text-a-ink",
            )}
          >
            {active && o.tone && <span aria-hidden className={cn("mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle", o.tone === "ok" ? "bg-a-ok" : o.tone === "wait" ? "bg-a-wait" : "bg-a-mut")} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <code className="min-w-0 break-all rounded bg-a-p px-1.5 py-0.5 font-mono text-callout text-a-ink">{value}</code>
      <button
        type="button"
        className={BTN}
        aria-label={t("{label} kopieren", { label })}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(value)
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {});
        }}
      >
        {copied ? t("Kopiert") : t("Kopieren")}
      </button>
    </span>
  );
}

export function BrowserPermissionRow() {
  const [perm, setPerm] = useState<BrowserPermission>(() => browserPermission());
  if (perm === "granted") return <p className="font-body text-caption text-a-ok">{t("Dieser Browser darf Mitteilungen zeigen.")}</p>;
  if (perm === "unsupported") return <p className="font-body text-caption text-a-mut">{t("Dieser Browser kann keine Mitteilungen zeigen. Am iPhone: NyxOS zum Home-Bildschirm hinzufügen und von dort öffnen.")}</p>;
  if (perm === "denied") return <p className="font-body text-caption text-a-bad">{t("Im Browser blockiert. Erlauben über das Schloss-Symbol neben der Adresse → Mitteilungen → Erlauben.")}</p>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={cn(BTN, BTN_ACCENT)} onClick={() => void requestBrowserPermission().then(setPerm)}>
        {t("Mitteilungen in diesem Browser erlauben")}
      </button>
      <span className="font-body text-caption text-a-mut">{t("Einmal nötig, sonst bleibt der Browser still.")}</span>
    </div>
  );
}

async function fetchSubscribe(): Promise<PushSubscribeInfo> {
  const res = await authFetch("/api/push/subscribe");
  if (!res.ok) throw new Error(t("Handy-Daten konnten nicht geladen werden ({status})", { status: res.status }));
  return res.json();
}

/** QR code as SVG (uqr, MIT, see NOTICE) – without innerHTML, every module a rectangle in the path. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const path = useMemo(() => {
    const qr = encode(text, { ecc: "M", border: 2 });
    let d = "";
    qr.data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
    return { d, size: qr.size };
  }, [text]);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${path.size} ${path.size}`} className="h-44 w-44 rounded-lg bg-white" shapeRendering="crispEdges">
      <path d={path.d} fill="#000" />
    </svg>
  );
}

export function PhoneSetup({ target, onTarget, busy }: { target: NtfyTarget; onTarget: (target: NtfyTarget) => void; busy: boolean }) {
  const info = useQuery({ queryKey: ["push-subscribe", target], queryFn: fetchSubscribe });
  const [showQr, setShowQr] = useState(false);
  const choice = (option: NtfyTarget, text: string) => (
    <button type="button" disabled={busy} aria-pressed={target === option} onClick={() => target !== option && onTarget(option)} className={cn(BTN, "text-left", target === option && "border-a-acc/60 bg-a-acc/10 text-a-acc")}>
      {text}
    </button>
  );
  const subscribeUrl = info.data?.reachable && info.data.serverUrl ? `${info.data.serverUrl.replace(/\/$/, "")}/${info.data.topic}` : null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {choice("ntfy_sh", t("Über ntfy.sh (geht sofort, fremder Server)"))}
        {choice("own", t("Eigener Dienst (braucht Tailscale)"))}
      </div>
      {info.isLoading && <p className="font-body text-caption text-a-mut">{t("Lädt …")}</p>}
      {info.isError && <p className="font-body text-caption text-a-bad">{friendlyError(info.error, t("Handy-Daten konnten nicht geladen werden."))}</p>}
      {info.data && (
        <div className="space-y-2">
          {/* ntfy.sh = someone else's server – so the note is shown as a warning, not grey. */}
          <p className={cn("font-body text-caption", info.data.reachable && info.data.target !== "ntfy_sh" ? "text-a-mut" : "text-a-wait")}>{info.data.note}</p>
          {info.data.reachable && info.data.serverUrl ? (
            <>
              <ol className="list-decimal space-y-1.5 pl-5 font-body text-callout text-a-ink">
                <li>{t("App „ntfy“ aufs Handy laden (App Store oder Google Play).")}</li>
                <li>
                  {t("In der App auf „+“ tippen, „Anderen Server verwenden“ einschalten und eintragen:")}
                  <div className="mt-1">
                    <CopyValue value={info.data.serverUrl} label={t("Server-Adresse")} />
                  </div>
                </li>
                <li>
                  {t("Als Thema eintragen (geheim, nicht weitergeben):")}
                  <div className="mt-1">
                    <CopyValue value={info.data.topic} label={t("Thema")} />
                  </div>
                </li>
                <li>{t("„Abonnieren“ tippen, Mitteilungen erlauben – dann „Test-Mitteilung senden“.")}</li>
              </ol>
              {subscribeUrl && (
                <div className="space-y-2">
                  <button type="button" className={BTN} aria-expanded={showQr} onClick={() => setShowQr((v) => !v)}>
                    {showQr ? t("QR-Code verbergen") : t("Abonnieren per QR-Code")}
                  </button>
                  {showQr && (
                    <div className="flex flex-wrap items-start gap-3">
                      <QrCode text={subscribeUrl} label={t("QR-Code zum Abonnieren in ntfy")} />
                      <p className="max-w-xs font-body text-caption text-a-mut">
                        {t("Mit der Handy-Kamera scannen: öffnet das Thema. Enthält das geheime Thema – nur selbst scannen, nicht zeigen.")}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="font-body text-caption text-a-mut">{t("Solange das so ist, kommen Mitteilungen über deinen Rechner und den Browser.")}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function ResultRow({ r }: { r: PushChannelResult }) {
  const mark = r.skipped ? "–" : r.ok ? "✓" : "✗";
  return (
    <li className="flex min-w-0 items-start gap-2">
      <span className={cn("w-4 shrink-0 font-mono text-callout", r.skipped ? "text-a-mut" : r.ok ? "text-a-ok" : "text-a-bad")}>{mark}</span>
      <span className="min-w-0 font-body text-callout text-a-ink">
        <span className="font-medium">{channelLabel(r.channel).title}:</span> <span className="text-a-mut">{r.detail}</span>
      </span>
    </li>
  );
}

/** "So kommt es an": the notification as on the lock screen (one calm surface, no gradient). */
export function LockscreenCard({ title, body, time, testId, label: labelProp }: { title: string; body: string; time: string; testId?: string; label?: string }) {
  const label = labelProp ?? t("So kommt es an");
  return (
    <figure className="w-full max-w-md space-y-1.5" aria-label={label}>
      <figcaption className={LABEL}>{label}</figcaption>
      <div data-testid={testId} className="rounded-2xl border border-a-line bg-a-p2 px-3.5 py-3">
        <div className="flex items-center gap-2">
          <span aria-hidden className="grid h-5 w-5 place-items-center rounded-md bg-a-nyx font-display text-label font-semibold text-a-on-primary">
            N
          </span>
          <span className="font-mono text-label uppercase tracking-wide text-a-mut">NyxOS</span>
          <span className="ml-auto font-mono text-label text-a-mut">{time}</span>
        </div>
        <p className="mt-1.5 text-callout font-semibold text-a-ink" data-part="title">
          {title}
        </p>
        <p className="whitespace-pre-line text-callout text-a-ink/90" data-part="body">
          {body}
        </p>
      </div>
    </figure>
  );
}
