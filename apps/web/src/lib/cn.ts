import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Schrift-Skala (app.css `--text-title` … `--text-label`): tailwind-merge kennt diese Namen nicht und hielt
// z. B. `text-caption` für eine Farbe – dann flog je nach Reihenfolge `text-a-mut` oder die Größe raus.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["title", "title2", "headline", "callout", "caption", "label"],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
