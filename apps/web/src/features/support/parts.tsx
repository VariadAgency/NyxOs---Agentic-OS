// Small building blocks of the "Feedback & Unterstützen" sheet: fields, choice chips, result notes.
import { t } from "@nyxos/shared";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Same look as the settings fields, but tall enough for a finger (≥ 44 px) on the phone. */
export const FIELD =
  "min-h-11 w-full min-w-0 rounded-lg border border-a-line bg-a-p px-3 py-2 text-callout text-a-ink placeholder:text-a-mut focus:border-a-acc focus:outline-none disabled:opacity-50 sm:min-h-9";
export const AREA = cn(FIELD, "min-h-[88px] resize-y leading-relaxed sm:min-h-[80px]");

export function Field({ label, hint, children, optional }: { label: string; hint?: string; optional?: boolean; children: ReactNode }) {
  return (
    <label className="grid min-w-0 gap-1.5">
      <span className="text-caption font-medium text-a-ink">
        {label}
        {optional && <span className="font-normal text-a-mut"> · {t("optional")}</span>}
      </span>
      {children}
      {hint && <span className="text-label text-a-mut">{hint}</span>}
    </label>
  );
}

/** Radio group as chips (amounts, importance, once/monthly). */
export function Chips<V extends string | number>({
  label,
  options,
  value,
  onChange,
  nyx,
}: {
  label: string;
  options: { value: V; label: string }[];
  value: V | null;
  onChange: (v: V) => void;
  nyx?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2" data-nyx={nyx}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "min-h-11 min-w-[3.5rem] rounded-lg border px-3 text-callout transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 sm:min-h-9",
            value === o.value ? "border-a-acc bg-a-p3 font-medium text-a-ink" : "border-a-line bg-a-p text-a-mut hover:border-a-line-strong hover:text-a-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Note({ tone, children, role }: { tone: "ok" | "wait" | "bad" | "info"; children: ReactNode; role?: "status" | "alert" }) {
  const cls = {
    ok: "border-a-ok/35 bg-a-ok/8 text-a-ink",
    wait: "border-a-wait/35 bg-a-wait/8 text-a-ink",
    bad: "border-a-bad/40 bg-a-bad/8 text-a-ink",
    info: "border-a-line bg-a-p text-a-ink",
  }[tone];
  return (
    <div role={role} className={cn("grid gap-1.5 rounded-lg border px-3 py-2.5 text-callout leading-relaxed", cls)}>
      {children}
    </div>
  );
}

/** Heart (outline) for the entry buttons — quiet, in the pink of "only you". */
export function HeartIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn("h-3.5 w-3.5 shrink-0", className)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 10c0 5.65-7 10-7 10z" />
    </svg>
  );
}
