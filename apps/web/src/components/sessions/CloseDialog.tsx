import { t } from "@nyxos/shared";
import { useEffect, useRef } from "react";
import { Button } from "../ui/button";

interface CloseDialogProps {
  open: boolean;
  sessionTitle: string;
  pending?: boolean;
  /** Eigene Frage (Standard: „„Titel“ schließen?“). */
  title?: string;
  /** Fehler beim letzten Versuch – der Dialog bleibt dann offen. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Bestätigung vor `POST /api/sessions/:id/close` — Schließen ist nur per Klick des Nutzers, rückgängig machbar. */
export function CloseDialog({ open, sessionTitle, pending, title, error, onConfirm, onCancel }: CloseDialogProps) {
  // Tastatur – Fokus startet auf dem sicheren „Abbrechen“ (nicht hinter dem Dialog), Esc bricht ab.
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) cancelRef.current?.focus({ preventScroll: true });
  }, [open]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center cc-scrim cc-sheet-wrap p-4"
      role="presentation"
      onClick={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !pending) {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="close-dialog-title"
        className="cc-sheet grid w-full max-w-sm gap-3 rounded-2xl border border-a-line bg-a-p2 p-4 shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="close-dialog-title" className="font-display text-callout font-semibold text-a-ink">
          {title ?? t("„{title}“ schließen?", { title: sessionTitle })}
        </h2>
        <p className="text-caption text-a-mut">{t("Die Session verschwindet aus der Übersicht. Du kannst sie jederzeit wieder öffnen.")}</p>
        {error && (
          <p role="alert" className="text-caption text-a-bad">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" onClick={onCancel} disabled={pending}>
            {t("Abbrechen")}
          </Button>
          <Button variant="warn" onClick={onConfirm} disabled={pending}>
            {pending ? t("Schließe …") : t("Schließen")}
          </Button>
        </div>
      </div>
    </div>
  );
}
