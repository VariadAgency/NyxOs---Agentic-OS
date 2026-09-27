// Small building blocks of the onboarding wizard (same calm POS look as the rest: dark cards, one accent per state).
import { t } from "@nyxos/shared";
import { useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";

export type Tone = "ok" | "wait" | "bad" | "mut";

const PILL: Record<Tone, string> = {
  ok: "border-a-ok/40 bg-a-ok/10 text-a-ok",
  wait: "border-a-wait/40 bg-a-wait/10 text-a-wait",
  bad: "border-a-bad/40 bg-a-bad/10 text-a-bad",
  mut: "border-a-line bg-a-p2 text-a-mut",
};
const DOT: Record<Tone, string> = { ok: "bg-a-ok", wait: "bg-a-wait", bad: "bg-a-bad", mut: "bg-a-dim" };

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 text-label font-medium", PILL[tone])}>
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", DOT[tone])} />
      {children}
    </span>
  );
}

export function StepHeader({ title, lead }: { title: string; lead: ReactNode }) {
  return (
    <header className="grid gap-2">
      <h1 className="font-display text-title font-semibold tracking-tight text-a-ink">{title}</h1>
      <p className="max-w-prose text-headline text-a-mut">{lead}</p>
    </header>
  );
}

/** One section of a step: a calm card with a title line and an optional status on the right. */
export function Block({ title, status, children, className, badge }: { title: string; status?: ReactNode; badge?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("grid gap-3 rounded-xl border border-a-line bg-a-p p-4", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 className="text-headline font-semibold text-a-ink">{title}</h2>
        {badge}
        {status && <div className="ml-auto">{status}</div>}
      </div>
      {children}
    </section>
  );
}

/** Terminal command with a copy button. */
export function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-a-line bg-a-bg px-2.5 py-1.5">
      <span aria-hidden className="font-mono text-caption text-a-mut">
        $
      </span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-caption text-a-ink">{command}</code>
      <Button variant="ghost" className="shrink-0" onClick={() => void copy()} aria-label={t("Befehl kopieren: {command}", { command })}>
        {copied ? t("Kopiert") : t("Kopieren")}
      </Button>
    </div>
  );
}

/** Numbered how-to list in simple words. */
export function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="grid gap-1.5">
      {items.map((item, i) => (
        <li key={i} className="grid grid-cols-[22px_minmax(0,1fr)] items-start gap-2 text-callout text-a-ink">
          <span aria-hidden className="mt-px grid h-5.5 w-5.5 place-items-center rounded-full bg-a-p3 font-mono text-label text-a-mut">
            {i + 1}
          </span>
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ol>
  );
}

/** Segmented choice (two to four options). */
export function Segmented<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex w-fit flex-wrap gap-1 rounded-xl border border-a-line bg-a-p p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-lg px-3.5 py-1.5 text-callout transition-colors duration-150 disabled:opacity-50",
            value === o.value ? "bg-a-p3 font-medium text-a-ink shadow-card" : "text-a-mut hover:text-a-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ErrorLine({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return (
    <p role="alert" className="text-callout text-a-bad">
      {text}
    </p>
  );
}
