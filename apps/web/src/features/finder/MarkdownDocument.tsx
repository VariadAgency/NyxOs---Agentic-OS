// Markdown als sauberes Dokument — „wie PDF“ (Papierseite, Satzspiegel, ruhige Typo) oder
// eingebettet in eine Karte. react-markdown + remark-gfm (MIT, s. NOTICE) rendern echte React-Elemente,
// rohes HTML im Markdown wird nie ausgeführt. Überschriften bekommen Anker fürs Inhaltsverzeichnis,
// relative Links/Bilder zeigen in den Reiter „Dateien“ (gleiche Wurzel), externe öffnen in neuem Tab.
import { t, tc } from "@nyxos/shared";
import { useMemo, useRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Link } from "react-router";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/cn";
import { finderHref, parentOf, rawUrl } from "./api";
import "./markdown.css";

export interface TocItem {
  level: number;
  text: string;
  id: string;
  line: number;
}

/** Anker wie GitHub: klein, ohne Satzzeichen, Leerzeichen → „-“, Doppelte mit Zähler. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Überschriften aus dem Quelltext (ATX `#`), Codeblöcke ausgenommen — Zeilen 1-basiert wie im Syntaxbaum. */
export function extractToc(markdown: string): TocItem[] {
  const out: TocItem[] = [];
  const used = new Map<string, number>();
  let fence = false;
  markdown.split("\n").forEach((line, i) => {
    if (/^\s{0,3}(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) return;
    const text = (m[2] ?? "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "");
    const base = slugify(text) || "abschnitt";
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    out.push({ level: (m[1] ?? "").length, text, id: n === 0 ? base : `${base}-${n}`, line: i + 1 });
  });
  return out;
}

/** Kaputte %-Folge (`%E0`) ließ `decodeURIComponent` werfen und das ganze Dokument abstürzen. */
function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** `rel` relativ zu `baseDir` auflösen (posix). `null` = zeigt aus der Wurzel hinaus. */
function resolveRel(baseDir: string, target: string): string | null {
  const parts = baseDir ? baseDir.split("/") : [];
  for (const seg of target.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

function textOf(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  if (children && typeof children === "object" && "props" in children) return textOf((children as { props: { children?: ReactNode } }).props.children);
  return "";
}

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

export interface MarkdownDocumentProps {
  text: string;
  /** Wo die Datei liegt — für relative Links und Bilder. Ohne: relative Links bleiben reiner Text. */
  base?: { root: string; rel: string };
  variant?: "paper" | "inline";
  /** Inhaltsverzeichnis über dem Dokument (nur bei mehr als zwei Überschriften). */
  toc?: boolean;
  label?: string;
  className?: string;
}

export function MarkdownDocument({ text, base, variant = "paper", toc = true, label = t("Dokument"), className }: MarkdownDocumentProps) {
  const items = useMemo(() => extractToc(text), [text]);
  const byLine = useMemo(() => new Map(items.map((h) => [h.line, h.id])), [items]);
  const articleRef = useRef<HTMLElement>(null);
  const paper = variant === "paper";

  const jump = (id: string) => {
    const el = articleRef.current?.querySelector(`[id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const components = useMemo<Components>(() => {
    const heading = (tag: HeadingTag) =>
      function Heading({ node, children, ...rest }: ComponentPropsWithoutRef<HeadingTag> & { node?: { position?: { start: { line: number } } } }) {
        const line = node?.position?.start.line;
        const id = (line !== undefined ? byLine.get(line) : undefined) ?? slugify(textOf(children));
        const Tag = tag;
        return (
          <Tag id={id} {...rest} className="group scroll-mt-4">
            {children}
          </Tag>
        );
      };
    return {
      h1: heading("h1"),
      h2: heading("h2"),
      h3: heading("h3"),
      h4: heading("h4"),
      h5: heading("h5"),
      h6: heading("h6"),
      a({ href, children, node: _node, ...rest }) {
        const h = href ?? "";
        if (h.startsWith("#")) {
          return (
            <a
              href={h}
              onClick={(ev) => {
                ev.preventDefault();
                jump(safeDecode(h.slice(1)) ?? h.slice(1));
              }}
              {...rest}
            >
              {children}
            </a>
          );
        }
        if (/^(https?:|mailto:)/i.test(h)) {
          return (
            <a href={h} target="_blank" rel="noreferrer" {...rest}>
              {children}
            </a>
          );
        }
        const [pathPart] = h.split("#");
        const decoded = pathPart ? safeDecode(pathPart) : null;
        const resolved = base && decoded ? resolveRel(parentOf(base.rel), decoded) : null;
        if (!base || resolved === null) return <span className="underline decoration-dotted">{children}</span>;
        return (
          <Link to={finderHref(base.root, { dir: parentOf(resolved), sel: resolved, open: resolved })} title={resolved}>
            {children}
          </Link>
        );
      },
      img({ src, alt, node: _node, ...rest }) {
        const s = typeof src === "string" ? src : "";
        if (/^https:/i.test(s)) return <img src={s} alt={alt ?? ""} loading="lazy" {...rest} />;
        const decoded = s && !/^[a-z]+:/i.test(s) ? safeDecode(s) : null;
        const resolved = base && decoded ? resolveRel(parentOf(base.rel), decoded) : null;
        if (!base || resolved === null) return <span className="text-[0.9em] italic">{t("[Bild: {name}]", { name: alt || s })}</span>;
        return <img src={rawUrl(base.root, resolved)} alt={alt ?? ""} loading="lazy" {...rest} />;
      },
      table({ children, node: _node, ...rest }) {
        return (
          <div className="cc-md-table">
            <table {...rest}>{children}</table>
          </div>
        );
      },
    };
    // `jump` hängt nur an der Ref — bewusst nicht in den Abhängigkeiten.
  }, [byLine, base]);

  const showToc = toc && items.length > 2;
  return (
    <div className={cn("min-w-0", className)}>
      {showToc && (
        <nav aria-label={tc("files", "Inhalt")} className={cn("mb-4 rounded-xl border border-a-line bg-a-p p-3", paper && "mx-auto max-w-[860px]")}>
          <div className="mb-1.5 font-mono text-label tracking-wide text-a-mut uppercase">{tc("files", "Inhalt")}</div>
          <ol className="columns-1 gap-6 text-caption sm:columns-2">
            {items
              .filter((h) => h.level <= 3)
              .map((h) => (
                <li key={`${h.id}-${h.line}`} className="break-inside-avoid" style={{ paddingLeft: (h.level - 1) * 12 }}>
                  <a
                    href={`#${h.id}`}
                    onClick={(ev) => {
                      ev.preventDefault();
                      jump(h.id);
                    }}
                    className={cn("block truncate rounded px-1 py-0.5 hover:bg-a-p3 hover:text-a-ink", h.level === 1 ? "font-medium text-a-ink" : "text-a-mut")}
                  >
                    {h.text}
                  </a>
                </li>
              ))}
          </ol>
        </nav>
      )}
      <article ref={articleRef} aria-label={label} className={paper ? "cc-md cc-md-paper" : "cc-md cc-md-inline"}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {text}
        </ReactMarkdown>
      </article>
    </div>
  );
}
