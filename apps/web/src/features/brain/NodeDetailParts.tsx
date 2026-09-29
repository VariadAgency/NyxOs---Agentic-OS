// gemeinsame Teile von Seitenblatt (großes Gehirn) und Info-Karte (lokaler Graph). Lange Wörter und Pfade
// (`App/backend/…/.build/checkouts/…`) brechen überall um, statt rechts aus der Karte zu laufen: `min-w-0` +
// `overflow-wrap:anywhere` (nur `break-words` reicht in Grid/Flex nicht – die Spalte wird sonst so breit wie das
// längste Wort).
import { markdownToText } from "@nyxos/shared";

/** Für jeden Text in der Karte, der lange Wörter/Pfade enthalten kann. */
export const WRAP = "min-w-0 [overflow-wrap:anywhere]";

export function FactList({ facts }: { facts: ReadonlyArray<readonly [string, string]> }) {
  if (facts.length === 0) return null;
  return (
    <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-caption">
      {facts.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-mono text-label uppercase tracking-wide text-a-mut">{k}</dt>
          <dd className={`${WRAP} text-a-ink`}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Textauszug (Notiz-Anfang, letzte Nachricht, Beschreibung). Reiner Text: Markdown/HTML wird nie als Markup gedeutet. */
export function ExcerptBlock({ label, text, color, headingLevel = 4 }: { label: string; text: string; color: string; headingLevel?: 3 | 4 }) {
  const H = headingLevel === 3 ? "h3" : "h4";
  return (
    <section className="grid min-w-0 gap-1">
      <H className="font-mono text-label uppercase tracking-wide text-a-mut">{label}</H>
      {/* Zeilenlänge: die Karte ist schmal; `pretty` vermeidet einzelne Wörter in der letzten Zeile. */}
      <p className={`${WRAP} max-w-[65ch] whitespace-pre-line border-l-2 pl-2 text-caption leading-relaxed text-a-ink [text-wrap:pretty]`} style={{ borderColor: color }}>
        {markdownToText(text)}
      </p>
    </section>
  );
}
