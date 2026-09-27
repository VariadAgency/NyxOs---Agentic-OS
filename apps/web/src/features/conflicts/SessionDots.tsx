// Session-Farbpunkte für die Kollisionskarte („wer schreibt wo“).
// Farbe ist reine Identität (kategorial, nie ein Status-Ton) — der Titel/Tastenname
// steht immer zusätzlich im `title`-Attribut, nie Farbe allein.
import { t } from "@nyxos/shared";
import { sessionColor } from "./collisionGroups";

export function SessionDots({ writers, max = 5 }: { writers: { sessionKey: string; title: string | null }[]; max?: number }) {
  if (writers.length === 0) return <span className="h-2 w-2 shrink-0 rounded-full bg-a-dim/40" title={t("niemand schreibt")} />;
  const shown = writers.slice(0, max);
  const rest = writers.length - shown.length;
  return (
    <span className="flex shrink-0 items-center -space-x-1">
      {shown.map((w) => (
        <span
          key={w.sessionKey}
          title={w.title ?? w.sessionKey}
          className="h-2.5 w-2.5 rounded-full ring-1 ring-a-p"
          style={{ backgroundColor: sessionColor(w.sessionKey) }}
        />
      ))}
      {rest > 0 && <span className="pl-1.5 font-mono text-label text-a-mut">+{rest}</span>}
    </span>
  );
}
