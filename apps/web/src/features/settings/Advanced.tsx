// „Erweitert“ – rarely used things, collapsed. Native <details> (keyboard, screen reader, find in page work by
// themselves); the state per block lives in the browser (localStorage, errors swallowed quietly).
// `open` from outside (e.g. an anchor points right in here) opens it without overwriting the remembered choice.
import { t } from "@nyxos/shared";
import { type ReactNode, useEffect, useState } from "react";
import { cn } from "../../lib/cn";

const KEY = (id: string) => `nyxos:settings-advanced:${id}`;

function readOpen(id: string): boolean {
  try {
    return window.localStorage.getItem(KEY(id)) === "1";
  } catch {
    return false;
  }
}

function writeOpen(id: string, open: boolean): void {
  try {
    if (open) window.localStorage.setItem(KEY(id), "1");
    else window.localStorage.removeItem(KEY(id));
  } catch {
    // Storage blocked (private window) – then it is simply not remembered.
  }
}

export function Advanced({ id, hint, open: forceOpen = false, children, className }: { id: string; hint?: string; open?: boolean; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(() => forceOpen || readOpen(id));
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  return (
    <details
      data-testid={`advanced-${id}`}
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        if (next === open) return;
        setOpen(next);
        writeOpen(id, next);
      }}
      className={cn("group min-w-0 rounded-xl border border-a-line", className)}
    >
      <summary
        data-nyx={`advanced:${id}`}
        className="flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-xl px-4 py-2.5 text-callout text-a-ink hover:bg-a-p2 focus-visible:outline-2 focus-visible:outline-a-acc [&::-webkit-details-marker]:hidden"
      >
        <span aria-hidden className="text-a-mut transition-transform duration-150 group-open:rotate-90">
          ›
        </span>
        <span className="font-medium">{t("Erweitert")}</span>
        {hint && <span className="min-w-0 truncate text-caption text-a-mut">{hint}</span>}
      </summary>
      <div className="grid min-w-0 gap-4 border-t border-a-line p-4">{children}</div>
    </details>
  );
}
