// Zahl-/Zeit-Helfer für den Tab „Agenten & Skills". Reine Funktionen.
import { t } from "@nyxos/shared";

/** Millisekunden lesbar: „45 s", „12 min", „3 h 4 min", „2 T 3 h" (statt „11053s"). */
export function formatDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? t("{d} T", { d }) : t("{d} T {h} h", { d, h: h % 24 });
}
