// Minimaler, sicherer Markdown-Renderer für den Chat (Assistent-Text). Rendert auf echte React-
// Elemente statt HTML-String — nie `dangerouslySetInnerHTML` (Ausnahme laut Auftrag nur für
// server-escapte Such-Snippets, s. `components/sessions/SearchResults.tsx`).
import { t } from "@nyxos/shared";
import type { HaikuSource } from "@nyxos/shared";
import { Fragment, memo, type ReactNode } from "react";
import { Link } from "react-router";

const CITE_CLASS = "ml-0.5 inline-grid min-w-[1.35em] place-items-center rounded-full border px-1 align-super font-mono text-label leading-[1.35]";

/**
 * Beleg-Nummer `[n]` im Text als kleiner, hochgestellter Verweis auf `sources[n-1]` (wie die
 * Quellen-Chips darunter). Ohne passende Quelle – oder ein roher Marker `[[art:id]]` mitten im Strömen – fällt
 * er still weg, statt als „[2]“ stehen zu bleiben.
 */
function renderCite(n: number, sources: HaikuSource[], key: string): ReactNode {
  const src = sources[n - 1];
  if (!src) return null;
  const label = t("Quelle {n}: {label}", { n, label: src.label });
  // Nur App-interne Pfade werden zum Link („/sessions/…“, „/inbox#…“) – nie `javascript:`, fremde Seiten oder „//host“ bzw. „/\host“.
  if (src.href && /^\/(?![/\\])/.test(src.href)) {
    return (
      <Link key={key} to={src.href} aria-label={label} title={src.label} className={`${CITE_CLASS} border-a-acc/40 bg-a-acc/10 text-a-acc no-underline hover:bg-a-acc/20`}>
        {n}
      </Link>
    );
  }
  return (
    <span key={key} aria-label={label} title={src.label} className={`${CITE_CLASS} border-a-line bg-a-p3 text-a-mut`}>
      {n}
    </span>
  );
}

// Schlüssel sind stabil (Position im Text), nicht mehr ein globaler Zähler — sonst ersetzte
// JEDES Neuzeichnen des Chats alle Absätze im DOM (markierter Text ging verloren, lange Nachrichten
// wurden bei jedem Live-Signal komplett neu aufgebaut).
// `sources` gesetzt (Nyx-Antworten): Beleg-Nummern werden zu Verweisen, sonst bleibt `[n]` normaler Text.
function renderInline(text: string, sources?: HaikuSource[]): ReactNode[] {
  let seq = 0;
  const nextKey = () => `i${seq++}`;
  const nodes: ReactNode[] = [];
  // Reihenfolge: Inline-Code zuerst (schützt seinen Inhalt vor weiterer Interpretation), dann Fett, Kursiv, Links.
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\s?\[\[[^\]]*\]\](?!\()|\s?\[(\d{1,2})\](?!\()/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      nodes.push(
        <code key={nextKey()} className="rounded bg-a-p3 px-1 py-0.5 font-mono text-caption">
          {m[1]}
        </code>,
      );
    } else if (m[2] !== undefined) {
      nodes.push(<b key={nextKey()}>{m[2]}</b>);
    } else if (m[3] !== undefined) {
      nodes.push(<i key={nextKey()}>{m[3]}</i>);
    } else if (m[4] !== undefined && m[5] !== undefined) {
      nodes.push(
        <a key={nextKey()} href={m[5]} target="_blank" rel="noreferrer" className="text-a-acc underline">
          {m[4]}
        </a>,
      );
    } else if (!sources) {
      nodes.push(m[0]);
    } else if (m[6] !== undefined) {
      nodes.push(renderCite(Number(m[6]), sources, nextKey()));
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

interface Block {
  kind: "p" | "h" | "code" | "ul" | "ol" | "table";
  level?: number;
  lang?: string;
  text?: string;
  items?: string[];
  rows?: string[][];
}

const LIST_LINE = /^\s*([-*]|\d+\.)\s+(.*)$/;
// Wie in GFM unterbricht nur „- “/„* “ oder eine mit „1.“ beginnende Liste einen Absatz —
// sonst würde ein umbrochenes „3. Oktober“ mitten im Text zur Liste.
const interruptsParagraph = (line: string) => {
  const m = LIST_LINE.exec(line);
  return m !== null && (m[1] === "-" || m[1] === "*" || m[1] === "1.");
};
// Tabellen (GFM) — eine Zeile mit „|“ und direkt darunter die Trennzeile „|---|---|“.
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const isTableStart = (line: string, next: string | undefined) =>
  line.includes("|") && next !== undefined && next.includes("|") && TABLE_SEPARATOR.test(next);
const tableCells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      i++; // schließendes ```
      blocks.push({ kind: "code", lang, text: codeLines.join("\n") });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "h", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      i++;
      continue;
    }
    if (isTableStart(line, lines[i + 1])) {
      const rows = [tableCells(line)];
      i += 2; // Kopf + Trennzeile
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") {
        rows.push(tableCells(lines[i] ?? ""));
        i++;
      }
      blocks.push({ kind: "table", rows });
      continue;
    }
    const listMatch = LIST_LINE.exec(line);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[1] ?? "");
      const items: string[] = [];
      while (i < lines.length) {
        const m = LIST_LINE.exec(lines[i] ?? "");
        if (!m) break;
        items.push(m[2] ?? "");
        i++;
      }
      blocks.push({ kind: ordered ? "ol" : "ul", items });
      continue;
    }
    // Ein Absatz endet auch, wo eine Liste oder Tabelle direkt anschließt (wie in GFM).
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^```/.test(lines[i] ?? "") &&
      !/^#{1,4}\s/.test(lines[i] ?? "") &&
      !interruptsParagraph(lines[i] ?? "") &&
      !isTableStart(lines[i] ?? "", lines[i + 1])
    ) {
      paraLines.push(lines[i] ?? "");
      i++;
    }
    blocks.push({ kind: "p", text: paraLines.join("\n") });
  }
  return blocks;
}

const HEADING_CLASS: Record<number, string> = {
  1: "text-headline font-semibold text-a-ink",
  2: "text-callout font-semibold text-a-ink",
  3: "text-callout font-semibold text-a-ink",
  4: "text-callout font-semibold text-a-mut",
};

/** Rendert Markdown-Text sicher als React-Baum (keine HTML-Interpretation von Nutzer-/Modelltext). */
export const Markdown = memo(function Markdown({ text, sources }: { text: string; sources?: HaikuSource[] }) {
  const blocks = parseBlocks(text);
  const inline = (t: string) => renderInline(t, sources);
  return (
    <div className="grid gap-2">
      {blocks.map((block, blockIdx) => {
        const key = `b${blockIdx}`;
        if (block.kind === "code") {
          return (
            <pre key={key} className="cc-scroll overflow-x-auto rounded-md border border-a-line bg-a-bg p-2 font-mono text-caption text-a-ink">
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.kind === "h") {
          return (
            <div key={key} role="heading" aria-level={block.level ?? 1} className={HEADING_CLASS[block.level ?? 1] ?? HEADING_CLASS[4]}>
              {inline(block.text ?? "")}
            </div>
          );
        }
        if (block.kind === "table") {
          const [head = [], ...body] = block.rows ?? [];
          return (
            <div key={key} className="cc-scroll overflow-x-auto rounded-md border border-a-line">
              <table className="w-full border-collapse text-left text-caption">
                <thead className="bg-a-p3">
                  <tr>
                    {head.map((cell, c) => (
                      <th key={c} className="px-2.5 py-1.5 font-semibold text-a-ink">
                        {inline(cell)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {body.map((row, r) => (
                    <tr key={r} className="border-t border-a-line align-top">
                      {head.map((_, c) => (
                        <td key={c} className="px-2.5 py-1.5">
                          {inline(row[c] ?? "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.kind === "ul" || block.kind === "ol") {
          const Tag = block.kind === "ul" ? "ul" : "ol";
          return (
            <Tag key={key} className={block.kind === "ul" ? "list-disc pl-5" : "list-decimal pl-5"}>
              {(block.items ?? []).map((item, itemIdx) => (
                <li key={itemIdx}>{inline(item)}</li>
              ))}
            </Tag>
          );
        }
        return (
          <p key={key} className="whitespace-pre-wrap break-words">
            {(block.text ?? "").split("\n").map((line, idx, arr) => (
              <Fragment key={idx}>
                {inline(line)}
                {idx < arr.length - 1 ? <br /> : null}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
});
