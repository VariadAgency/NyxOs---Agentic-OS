// Menü „⋯“ an einem Nyx-Faden und die Rückfrage vor dem Löschen (im Tab, nie `confirm()`).
// Das Menü schwebt als Portal über der Seite: die Fadenliste scrollt und würde es sonst abschneiden.
import { type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "@nyxos/shared";
import { cn } from "../../lib/cn";

export interface ThreadMenuItem {
  label: string;
  onSelect: () => void;
  /** `bad` = zerstörerisch (Löschen), rot und durch eine Linie abgesetzt. */
  tone?: "bad";
  disabled?: boolean;
}

const MENU_W = 208;
const GAP = 4;

export function ThreadMenu({ title, items }: { title: string; items: ThreadMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const label = t("Aktionen für „{title}“", { title });

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus({ preventScroll: true });
  }, []);

  // Unter dem Knopf, rechtsbündig; passt es unten nicht mehr hin, klappt es nach oben.
  useLayoutEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const h = menuRef.current?.offsetHeight ?? 200;
    const below = r.bottom + GAP + h <= window.innerHeight;
    setPos({ top: below ? r.bottom + GAP : Math.max(GAP, r.top - GAP - h), left: Math.max(GAP, Math.min(window.innerWidth - MENU_W - GAP, r.right - MENU_W)) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !btnRef.current?.contains(target)) close(false);
    };
    // Verschiebt sich die Liste darunter (Scrollen, Fenstergröße), passt die Lage nicht mehr → schließen.
    const onMove = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, close]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      // Nicht bis zum Panel durchreichen – Esc schließt nur das Menü.
      e.stopPropagation();
      e.preventDefault();
      close(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? (at + 1) % all.length : (at - 1 + all.length) % all.length;
      all[next]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      all[e.key === "Home" ? 0 : all.length - 1]?.focus();
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("Mehr: zusammenfassen, zu Auftrag, Obsidian, archivieren, löschen")}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "grid h-7 w-7 shrink-0 place-items-center rounded-md font-mono text-headline leading-none text-a-mut transition-colors duration-150 hover:bg-a-p3 hover:text-a-ink focus-visible:outline-2 focus-visible:outline-a-acc",
          open && "bg-a-p3 text-a-ink",
        )}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKey}
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: MENU_W }}
            className="cc-rise fixed z-[60] grid gap-0.5 rounded-lg border border-a-line bg-a-p2 p-1 shadow-[0_18px_40px_rgba(0,0,0,.55)]"
          >
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                onClick={() => {
                  close(false);
                  it.onSelect();
                }}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-left text-caption transition-colors duration-150 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
                  it.tone === "bad" ? "mt-0.5 border-t border-a-line text-a-bad hover:bg-a-bad/10 focus:bg-a-bad/10" : "text-a-ink hover:bg-a-p3 focus:bg-a-p3",
                )}
              >
                {it.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/** Rückfrage vor dem endgültigen Löschen – liegt über dem Panel, Fokus startet auf „Abbrechen“. */
export function ConfirmDeleteThread({ title, pending, onConfirm, onCancel }: { title: string; pending: boolean; onConfirm: () => void; onCancel: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus({ preventScroll: true }), []);
  return (
    <div
      className="absolute inset-0 z-50 grid place-items-center bg-black/55 p-4"
      role="presentation"
      onClick={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="nyx-delete-title"
        aria-describedby="nyx-delete-body"
        onClick={(e) => e.stopPropagation()}
        className="cc-rise grid w-full max-w-[340px] gap-3 rounded-lg border border-a-line bg-a-p p-4 shadow-[0_30px_80px_rgba(0,0,0,.6)]"
      >
        <h2 id="nyx-delete-title" className="font-display text-callout font-semibold text-a-ink [overflow-wrap:anywhere]">
          {t("„{title}“ löschen?", { title })}
        </h2>
        <p id="nyx-delete-body" className="text-caption leading-relaxed text-a-mut">
          {t("Der Faden und alle Nachrichten darin sind danach weg. Das lässt sich nicht rückgängig machen. Nur aus der Liste nehmen? Dann lieber archivieren.")}
        </p>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-a-line px-3 py-1.5 text-caption text-a-ink transition-colors duration-150 hover:bg-a-p2"
          >
            {t("Abbrechen")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="rounded-md border border-a-bad/60 bg-a-bad/15 px-3 py-1.5 text-caption font-medium text-a-bad transition-colors duration-150 hover:bg-a-bad/25 disabled:opacity-60"
          >
            {pending ? t("Lösche …") : t("Endgültig löschen")}
          </button>
        </div>
      </div>
    </div>
  );
}
