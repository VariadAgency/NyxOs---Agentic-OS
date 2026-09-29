// Info-Karte im lokalen Graphen: Klick auf einen Punkt zeigt rechts im Graphen Art, Titel,
// Fakten und einen Textauszug (Notiz-Anfang, letzte Nachricht, Beschreibung) — ohne Tab-Wechsel.
// Schließen per ✕ oder Esc; Doppelklick auf den Punkt öffnet wie bisher.
import { GRAPH_NODE_TYPE_LABELS, markdownToText, t, type GraphNode } from "@nyxos/shared";
import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { Link } from "react-router";
import { colorKeyFullLabel, colorKeyOf, typeColor, type ColorKey } from "./colors";
import { openTarget } from "./links";
import { useNodeDetail } from "./useNodeDetail";

interface Props {
  node: GraphNode;
  colors?: Partial<Record<ColorKey, string>>;
  onClose(): void;
}

export function NodeCard({ node, colors, onClose }: Props) {
  const detail = useNodeDetail(node.id);
  const color = typeColor(node, colors);
  const key = colorKeyOf(node);
  const target = openTarget(node);
  const data = detail.status === "ready" ? detail.data : null;
  // Die Karte erscheint schon beim ersten Klick. Damit ein Doppelklick auf einen Punkt unter der
  // Karte trotzdem öffnet, lässt sie Klicks kurz durch (so lange wie das Doppelklick-Fenster).
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    const timer = setTimeout(() => setArmed(true), 360);
    return () => clearTimeout(timer);
  }, [node.id]);

  useEffect(() => {
    // In der Einfang-Phase und dann angehalten: Esc schließt nur die Karte, nicht zusätzlich die
    // Großansicht drumherum (Aufgaben-Großansicht schließt selbst auf Esc).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <aside
      aria-label={t("Info: {label}", { label: node.label })}
      data-testid="node-card"
      className={cn(!armed && "pointer-events-none", "cc-scroll absolute bottom-2 right-2 top-2 z-10 w-[min(320px,60%)] overflow-y-auto rounded-lg border border-a-line bg-a-p/95 shadow-pop backdrop-blur motion-safe:animate-[brainSheetIn_160ms_cubic-bezier(.2,.8,.2,1)]")}
    >
      <div className="h-[3px] w-full" aria-hidden="true" style={{ background: color }} />
      <div className="flex items-start gap-2 px-3 pt-2.5">
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-mono text-label uppercase tracking-wide text-a-ink"
          style={{ background: `color-mix(in srgb, ${color} 24%, transparent)` }}
        >
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
          {node.type === "note" ? colorKeyFullLabel(key, GRAPH_NODE_TYPE_LABELS) : t(GRAPH_NODE_TYPE_LABELS[node.type])}
        </span>
        <span className="flex-1" />
        <button type="button" onClick={onClose} aria-label={t("Info schließen")} title={t("Schließen (Esc)")} className="rounded px-1 text-a-mut hover:text-a-ink">
          ✕
        </button>
      </div>
      <h3 className="break-words px-3 pt-1.5 font-display text-headline font-semibold leading-snug text-a-ink">{data?.title ?? node.label}</h3>
      <div className="grid gap-3 px-3 pb-3 pt-2">
        {detail.status === "loading" ? (
          <div className="grid gap-1.5" aria-label={t("lädt")}>
            <span className="h-2.5 w-3/4 animate-pulse rounded bg-a-p3" />
            <span className="h-2.5 w-1/2 animate-pulse rounded bg-a-p3" />
          </div>
        ) : null}
        {detail.status === "error" ? <p className="text-caption text-a-mut">{t("Details sind gerade nicht abrufbar. Doppelklick auf den Punkt öffnet ihn trotzdem.")}</p> : null}
        {data && data.facts.length > 0 ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-caption">
            {data.facts.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-mono text-label uppercase tracking-wide text-a-mut">{k}</dt>
                <dd className="min-w-0 break-words text-a-ink">{v}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {data?.tags.length ? (
          <ul className="flex flex-wrap gap-1">
            {data.tags.map((tag) => (
              <li key={tag} className="rounded-full border border-a-line px-1.5 py-0.5 font-mono text-label text-a-mut">
                #{tag}
              </li>
            ))}
          </ul>
        ) : null}
        {[data?.extra, data?.excerpt].map((x) =>
          x ? (
            <section key={x.label} className="grid gap-1">
              <h4 className="font-mono text-label uppercase tracking-wide text-a-mut">{x.label}</h4>
              {/* Reiner Text: Markdown/HTML aus den Daten wird nie als Markup gedeutet. */}
              <p className="whitespace-pre-line break-words border-l-2 pl-2 text-caption leading-relaxed text-a-ink" style={{ borderColor: color }}>
                {markdownToText(x.text)}
              </p>
            </section>
          ) : null,
        )}
        {data && !data.excerpt && !data.extra && node.type === "note" && node.ref.kind === "note" && node.ref.path ? (
          <p className="text-caption text-a-mut">{t("Noch kein Textauszug — er kommt mit dem nächsten Vault-Abgleich der Brücke.")}</p>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          {target ? (
            target.kind === "route" ? (
              <Link to={target.to} className="rounded-md border border-a-acc/50 bg-a-acc/10 px-2 py-1 text-caption text-a-ink transition-colors duration-150 hover:bg-a-acc/20">
                {target.label} →
              </Link>
            ) : (
              <a href={target.href} className="rounded-md border border-a-acc/50 bg-a-acc/10 px-2 py-1 text-caption text-a-ink transition-colors duration-150 hover:bg-a-acc/20">
                {target.label} ↗
              </a>
            )
          ) : null}
          <Link to={`/gehirn?focus=${encodeURIComponent(node.id)}`} className="rounded-md border border-a-line bg-a-p2 px-2 py-1 text-caption text-a-mut transition-colors duration-150 hover:text-a-ink">
            {t("Im Gehirn zeigen")}
          </Link>
          <Link to={`/gehirn?brain=${encodeURIComponent(node.id)}`} className="rounded-md border border-a-line bg-a-p2 px-2 py-1 text-caption text-a-mut transition-colors duration-150 hover:text-a-ink">
            {t("Eigenes Gehirn")}
          </Link>
        </div>
      </div>
    </aside>
  );
}
