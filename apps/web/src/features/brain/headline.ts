// Kennzahlen-Zeile oben im Gehirn (eine Zeile, ohne „Gehirn“). Für schmale Bildschirme (die lange
// Aufzählung wurde bei 390 px abgeschnitten) eine kurze Fassung, die ganze Aufzählung steht im Titel (Tooltip).
import { GRAPH_NODE_TYPE_LABELS, locale, t, type GraphNodeType } from "@nyxos/shared";

const fmt = new Intl.NumberFormat(locale());

export function statsLine(counts: Record<string, number | undefined>): { full: string; short: string } {
  const parts = Object.entries(counts).filter(([, n]) => (n ?? 0) > 0) as [string, number][];
  const full = parts.map(([k, n]) => `${fmt.format(n)} ${t(GRAPH_NODE_TYPE_LABELS[k as GraphNodeType] ?? k)}`).join(" · ");
  const total = parts.reduce((s, [, n]) => s + n, 0);
  const short = parts.length === 1 ? t("{n} Punkte · 1 Art", { n: fmt.format(total) }) : t("{n} Punkte · {k} Arten", { n: fmt.format(total), k: parts.length });
  return { full, short };
}
