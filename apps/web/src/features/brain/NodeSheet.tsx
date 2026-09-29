// Seitenblatt zum gewählten Knoten: Fakten, Nachbarn (anklickbar), Sprung zur Großansicht.
import { GRAPH_NODE_TYPE_LABELS, artLabel, t, type GraphNode } from "@nyxos/shared";
import { Link } from "react-router";
import { AskNyxButton } from "../../components/nyx/AskNyxButton";
import { relativeTime } from "../../lib/format";
import { colorKeyFullLabel, colorKeyOf, typeColor, type ColorKey } from "./colors";
import type { LiveGraph } from "./graphData";
import { openTarget } from "./links";
import { nodeAskFacts, nodeAskQuestion, neighboursOf } from "./nodeAsk";
import { ExcerptBlock, FactList, WRAP } from "./NodeDetailParts";
import { SESSION_STATE_LABELS, type SessionStateKey } from "./settings";
import { useNodeDetail } from "./useNodeDetail";

interface Props {
  node: GraphNode;
  graph: LiveGraph;
  colors?: Partial<Record<ColorKey, string>>;
  onSelect(id: string): void;
  onClose(): void;
}

const MAX_NEIGHBOURS = 40;

export function NodeSheet({ node, graph, colors, onSelect, onClose }: Props) {
  const color = typeColor(node, colors);
  const detail = useNodeDetail(node.id);
  const excerpts = detail.status === "ready" ? [detail.data.extra, detail.data.excerpt].filter((x): x is { label: string; text: string } => x !== null) : [];
  const neighbours = neighboursOf(node, graph);
  const target = openTarget(node);
  const facts: Array<[string, string]> = [[t("Art"), node.type === "note" ? `${t(GRAPH_NODE_TYPE_LABELS.note)} · ${colorKeyFullLabel(colorKeyOf(node), GRAPH_NODE_TYPE_LABELS)}` : t(GRAPH_NODE_TYPE_LABELS[node.type])]];
  if (node.ref.kind === "session") facts.push([t("Einsortiert"), artLabel(node.ref.art)], [t("Werkzeug"), node.ref.tool]);
  if (node.state) facts.push([t("Zustand"), node.state === "unresolved" ? t("noch nicht erstellt") : (SESSION_STATE_LABELS[node.state as SessionStateKey] ?? node.state)]);
  if (node.ts) facts.push([t("Zuletzt"), relativeTime(node.ts) ?? "–"]);
  facts.push([t("Verbindungen"), String(node.degree)]);
  if (node.lib) facts.push([t("Bibliothek"), node.lib]);
  if (node.ref.kind === "note" && node.ref.path) facts.push([t("Pfad"), node.ref.path]);
  else if (node.ref.kind === "file") facts.push([t("Pfad"), node.ref.path]);
  else if (node.group) facts.push([t("Gruppe"), node.group]);
  const data = detail.status === "ready" ? detail.data : null;

  return (
    <aside
      data-brain-overlay=""
      aria-label={t("Details: {label}", { label: node.label })}
      className="cc-scroll pointer-events-auto min-h-0 w-[320px] max-w-[calc(100vw-2rem)] shrink overflow-y-auto overflow-x-hidden rounded-xl max-sm:w-[calc(100vw-2rem)] border border-a-line bg-a-p/95 shadow-pop backdrop-blur motion-safe:animate-[brainSheetIn_180ms_cubic-bezier(.2,.8,.2,1)]"
    >
      {/* Kopfzeile: Farbstreifen + Art-Pille geben sofort zu erkennen, was für ein Knoten das ist. */}
      <div className="h-[3px] w-full" aria-hidden="true" style={{ background: color }} />
      <div className="flex items-start gap-2 p-3.5 pb-0">
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-mono text-label uppercase tracking-wide text-a-ink"
          style={{ background: `color-mix(in srgb, ${color} 24%, transparent)` }}
        >
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
          {t(GRAPH_NODE_TYPE_LABELS[node.type])}
        </span>
        <span className="flex-1" />
        <button type="button" onClick={onClose} aria-label={t("Details schließen")} className="rounded px-1 text-a-mut hover:text-a-ink">
          ✕
        </button>
      </div>
      <h2 className={`${WRAP} px-3.5 pt-1.5 font-display text-headline font-semibold leading-snug text-a-ink`}>{node.label}</h2>
      <div className="grid min-w-0 gap-3 px-3.5 pt-3">
        {/* Nyx fasst den Punkt zusammen – was er ist, wofür er steht, wichtigste Verbindungen. */}
        <AskNyxButton key={node.id} className="justify-self-start" label={t("Nyx erklärt")} question={nodeAskQuestion(node, data)} facts={nodeAskFacts(node, data, neighbours, node.ts ? relativeTime(node.ts) : null)} />
        <FactList facts={facts} />
        {excerpts.map((x) => (
          <ExcerptBlock key={x.label} label={x.label} text={x.text} color={color} headingLevel={3} />
        ))}
      </div>
      <div className="min-w-0 px-3.5 pb-3.5 pt-3">
        {target ? (
          target.kind === "route" ? (
            <Link to={target.to} className="inline-flex rounded-md border border-a-acc/50 bg-a-acc/10 px-2.5 py-1 text-caption text-a-ink transition-colors duration-150 hover:bg-a-acc/20">
              {target.label} →
            </Link>
          ) : (
            <a href={target.href} className="inline-flex rounded-md border border-a-acc/50 bg-a-acc/10 px-2.5 py-1 text-caption text-a-ink transition-colors duration-150 hover:bg-a-acc/20">
              {target.label} ↗
            </a>
          )
        ) : null}
        <h3 className="mb-1.5 mt-3 font-mono text-label font-semibold uppercase tracking-wide text-a-mut">{t("Verknüpft ({n})", { n: neighbours.length })}</h3>
        {neighbours.length === 0 ? (
          <p className="text-caption text-a-mut">{t("Keine Verbindungen — eine Waise.")}</p>
        ) : (
          <ul className="grid gap-0.5">
            {neighbours.slice(0, MAX_NEIGHBOURS).map(({ node: n, kind }) => (
              <li key={`${kind}-${n.id}`}>
                <button
                  type="button"
                  onClick={() => onSelect(n.id)}
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-caption text-a-ink transition-colors duration-150 hover:bg-a-p3"
                >
                  <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: typeColor(n, colors) }} />
                  <span className="min-w-0 flex-1 truncate">{n.label}</span>
                  <span className="font-mono text-label text-a-mut">{t(GRAPH_NODE_TYPE_LABELS[n.type])}</span>
                </button>
              </li>
            ))}
            {neighbours.length > MAX_NEIGHBOURS ? <li className="px-1.5 text-label text-a-mut">{t("… und {n} weitere", { n: neighbours.length - MAX_NEIGHBOURS })}</li> : null}
          </ul>
        )}
      </div>
    </aside>
  );
}
