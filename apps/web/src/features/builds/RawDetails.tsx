// Technik-Meldungen (Build-Log, „spawn … ENOENT“) nie als Hauptzeile — nur zugeklappt unter
// „Details“. Oben steht immer ein Satz in einfacher Sprache.
import { t } from "@nyxos/shared";
import { cn } from "../../lib/cn";

export function RawDetails({ text, className }: { text: string; className?: string }) {
  return (
    <details className={cn("min-w-0", className)}>
      <summary className="w-fit cursor-pointer select-none text-caption text-a-mut transition-colors duration-150 hover:text-a-ink">{t("Details")}</summary>
      <pre className="mt-1 max-h-48 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-md border border-a-line bg-a-p2 p-2 font-mono text-label text-a-mut">{text}</pre>
    </details>
  );
}
