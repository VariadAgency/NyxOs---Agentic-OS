// Schnell-Aktionen im Nyx-Zentrum als Kacheln (wie die Knöpfe im iOS-Kontrollzentrum).
// Das Feld ist nur so breit wie die Leiste – die Kacheln passen sich der Feldbreite an (Container-Abfrage):
// schmal drei je Reihe, ab ~430 px alle fünf nebeneinander; Beschriftung darf zweizeilig sein.
import { t } from "@nyxos/shared";
import type { ReactNode } from "react";
import { cn } from "../../../lib/cn";

export interface QuickTile {
  id: string;
  /** Eigene `data-nyx`-Kennung (z. B. „neue-session“ wie überall); sonst `nyx-quick:<id>`. */
  nyx?: string;
  label: string;
  hint: string;
  icon: ReactNode;
  /** Kategorie-Farbe (Token-Klasse für Symbol + Rand). */
  tone: string;
  onClick: () => void;
  /** Schalter-Kachel: an/aus sichtbar. */
  pressed?: boolean;
  disabled?: boolean;
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" aria-hidden="true">
      {children}
    </svg>
  );
}

export const ICONS = {
  briefing: (
    <Icon>
      <path d="M4 5h11a3 3 0 0 1 3 3v11H7a3 3 0 0 1-3-3V5z" />
      <path d="M8 9h6M8 13h6M18 9h2v8a2 2 0 0 1-2 2" />
    </Icon>
  ),
  session: (
    <Icon>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M7 9l3 3-3 3M12 15h5" />
    </Icon>
  ),
  status: (
    <Icon>
      <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />
    </Icon>
  ),
  mic: (
    <Icon>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </Icon>
  ),
  recent: (
    <Icon>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v4h4M12 7v5l3 2" />
    </Icon>
  ),
  nyx: (
    <Icon>
      <circle cx="12" cy="12" r="2.2" />
      <circle cx="5" cy="6" r="1.6" />
      <circle cx="19" cy="7" r="1.6" />
      <circle cx="7" cy="19" r="1.6" />
      <path d="M6.3 7l4 3.6M17.6 8l-4 3M8 17.6l2.6-3.8" />
    </Icon>
  ),
};

export function NyxQuickTiles({ tiles }: { tiles: QuickTile[] }) {
  return (
    <div role="group" aria-label={t("Schnell-Aktionen")} className="grid grid-cols-3 gap-1.5 @min-[430px]/nyxdrop:grid-cols-5">
      {tiles.map((tile) => (
        <button
          key={tile.id}
          type="button"
          data-nyx={tile.nyx ?? `nyx-quick:${tile.id}`}
          onClick={tile.onClick}
          disabled={tile.disabled}
          aria-pressed={tile.pressed}
          title={tile.hint}
          className={cn(
            "nyx-tile grid min-w-0 content-start justify-items-start gap-1 rounded-xl px-2.5 py-2 text-left transition-[transform,background-color] duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50",
            tile.pressed && "nyx-tile-on",
          )}
        >
          <span className={cn("grid h-7 w-7 place-items-center rounded-full", tile.tone)}>{tile.icon}</span>
          <span className="line-clamp-2 w-full text-label font-medium leading-tight text-a-ink">{tile.label}</span>
        </button>
      ))}
    </div>
  );
}
