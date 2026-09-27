// Vorschau einer Datei (letzte Spalte der Spaltenansicht, Galerie) und „Übersicht“ (Leertaste,
// wie Quick Look). Zeigt Bild/Text/Dokument an, dazu Metadaten, Öffnen, Herunterladen und die Sessions,
// die an der Datei gearbeitet haben (Verknüpfung zu den Sessions, alles anklickbar).
import { FINDER_KIND_LABEL, finderIsTextKind, t, type FinderEntry } from "@nyxos/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { fetchFileSessions } from "../files/api";
import { useFinderSource } from "./source";
import { FileIcon, KIND_COLOR, Thumb } from "./FileIcon";
import { errorText, useEntries, useRoots, useText } from "./hooks";
import { MarkdownDocument } from "./MarkdownDocument";
import { formatDate, formatSize } from "./sort";

const SNIPPET_LINES = 60;

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-a-line/60 py-1 text-caption last:border-0">
      <span className="shrink-0 text-a-mut">{label}</span>
      <span className="min-w-0 truncate text-right text-a-ink" title={value}>
        {value}
      </span>
    </div>
  );
}

/** Sessions, die diese Datei gelesen oder geändert haben (Quelle `session_files`, absoluter Pfad auf dem Rechner der Brücke). */
function FileSessions({ root, rel }: { root: string; rel: string }) {
  const roots = useRoots();
  const base = roots.data?.roots.find((r) => r.id === root)?.abs ?? "";
  const abs = base ? `${base}/${rel}` : null;
  const q = useQuery({ queryKey: ["file-sessions", abs], queryFn: () => fetchFileSessions(abs ?? ""), enabled: abs !== null, staleTime: 30_000 });
  const list = q.data?.sessions ?? [];
  if (list.length === 0) return null;
  return (
    <div className="space-y-1">
      <div className="font-mono text-label tracking-wide text-a-mut uppercase">{t("Sessions an dieser Datei")}</div>
      {list.slice(0, 6).map((s) => (
        <Link key={s.key} to={s.href} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-caption hover:bg-a-p3">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: s.tool === "codex" ? "var(--a-codex)" : "var(--a-claude)" }} />
          <span className="min-w-0 flex-1 truncate text-a-ink">{s.title ?? t("Session ohne Titel")}</span>
          <span className="shrink-0 text-label text-a-mut">{s.modes.includes("write") ? t("geändert") : t("gelesen")}</span>
        </Link>
      ))}
    </div>
  );
}

/** Inhalt eines Ordners in der Vorschau — jeder Eintrag anklickbar (öffnet den Ordner und markiert ihn). */
function DirChildren({ root, entry, big, onReveal }: { root: string; entry: FinderEntry; big: boolean; onReveal?: (child: FinderEntry) => void }) {
  const list = useEntries(root, entry.rel, { by: "name", dir: "asc" }, false);
  const max = big ? 200 : 40;
  if (list.isLoading) return <div className="h-24 animate-pulse rounded-lg bg-a-p2" />;
  if (list.isError) return <p className="text-caption text-a-mut">{errorText(list.error)}</p>;
  if (list.entries.length === 0) return <p className="py-4 text-center text-caption text-a-mut">{t("Dieser Ordner ist leer.")}</p>;
  return (
    <div className="space-y-1">
      <div className="text-caption text-a-mut tabular-nums">{list.entries.length === 1 ? t("1 Objekt") : t("{n} Objekte", { n: list.entries.length })}</div>
      <ul className={cn("cc-scroll overflow-y-auto rounded-lg border border-a-line bg-a-p py-1", big ? "max-h-[60vh]" : "max-h-[280px]")}>
        {list.entries.slice(0, max).map((c) => (
          <li key={c.rel}>
            <button
              type="button"
              disabled={!onReveal}
              onClick={() => onReveal?.(c)}
              title={c.name}
              className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-caption text-a-ink hover:bg-a-p2 focus-visible:bg-a-p3 focus-visible:outline-none disabled:cursor-default"
            >
              <FileIcon entry={c} size={16} />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              {c.secret && <span className="shrink-0 text-label text-a-wait">{t("gesperrt")}</span>}
            </button>
          </li>
        ))}
      </ul>
      {list.entries.length > max && <p className="text-label text-a-mut">{t("… und {n} weitere", { n: list.entries.length - max })}</p>}
    </div>
  );
}

/** Inhalt der Vorschau je Art: Bild groß, Markdown als kleines Dokument, Text/Quelltext als Auszug. */
function PreviewBody({ root, entry, big, onReveal }: { root: string; entry: FinderEntry; big: boolean; onReveal?: (child: FinderEntry) => void }) {
  const src = useFinderSource();
  const text = useText(root, entry.rel, finderIsTextKind(entry.kind) && !entry.secret && !entry.isDir && entry.size <= src.maxTextBytes);
  if (entry.secret) return <p className="text-caption text-a-mut">{src.secretText}</p>;
  if (entry.isDir) return <DirChildren root={root} entry={entry} big={big} onReveal={onReveal} />;
  const inline = src.canInline(entry);
  const rawUrl = src.rawUrl;
  if (entry.kind === "image" && inline) {
    return (
      <div className="grid place-items-center rounded-lg bg-[repeating-conic-gradient(var(--a-p2)_0_25%,var(--a-p3)_0_50%)] bg-[length:16px_16px] p-2">
        <img src={rawUrl(root, entry.rel)} alt={entry.name} className={cn("max-w-full rounded object-contain", big ? "max-h-[70vh]" : "max-h-[280px]")} />
      </div>
    );
  }
  if (entry.kind === "pdf" && inline) return <iframe title={entry.name} src={rawUrl(root, entry.rel)} className={cn("w-full rounded-lg border border-a-line bg-white", big ? "h-[70vh]" : "h-[320px]")} />;
  if (entry.kind === "video" && inline) return <video src={rawUrl(root, entry.rel)} controls className="max-h-[60vh] w-full rounded-lg" />;
  if (entry.kind === "audio" && inline) return <audio src={rawUrl(root, entry.rel)} controls className="w-full" />;
  if (finderIsTextKind(entry.kind)) {
    if (text.isLoading) return <div className="h-24 animate-pulse rounded-lg bg-a-p2" />;
    if (text.isError) return <p className="text-caption text-a-mut">{errorText(text.error)}</p>;
    const content = text.data?.content ?? "";
    if (entry.kind === "markdown") {
      return (
        <div className={cn("cc-scroll overflow-y-auto rounded-lg border border-a-line bg-a-p p-3", big ? "max-h-[70vh]" : "max-h-[340px]")}>
          <MarkdownDocument text={big ? content : content.split("\n").slice(0, SNIPPET_LINES * 2).join("\n")} base={src.markdownLinks ? { root, rel: entry.rel } : undefined} variant="inline" toc={false} label={t("Vorschau-Dokument")} />
        </div>
      );
    }
    const lines = content.split("\n");
    const shown = big ? lines : lines.slice(0, SNIPPET_LINES);
    return (
      <pre className={cn("cc-scroll overflow-auto rounded-lg border border-a-line bg-a-p p-3 font-mono text-caption leading-[1.55] text-a-ink", big ? "max-h-[70vh]" : "max-h-[340px]")}>
        {shown.join("\n")}
        {shown.length < lines.length ? `\n${t("… ({n} weitere Zeilen)", { n: lines.length - shown.length })}` : ""}
      </pre>
    );
  }
  return (
    <div className="grid place-items-center py-6">
      <FileIcon entry={entry} size={big ? 96 : 64} />
    </div>
  );
}

/** Vorschau-Spalte (Spaltenansicht) bzw. Info-Bereich (Galerie). */
export function PreviewPane({ root, entry, onOpen, onReveal, className, body = true }: { root: string; entry: FinderEntry; onOpen: () => void; onReveal?: (child: FinderEntry) => void; className?: string; body?: boolean }) {
  const src = useFinderSource();
  return (
    <section aria-label={t("Vorschau")} className={cn("min-w-0 space-y-3", className)}>
      {!body ? null : entry.secret || entry.kind === "image" || finderIsTextKind(entry.kind) || entry.kind === "pdf" ? (
        <PreviewBody root={root} entry={entry} big={false} onReveal={onReveal} />
      ) : entry.isDir && onReveal ? (
        <PreviewBody root={root} entry={entry} big={false} onReveal={onReveal} />
      ) : (
        <div className="grid place-items-center py-4">
          <Thumb root={root} entry={entry} size={96} />
        </div>
      )}
      <div>
        <div className="truncate text-callout font-semibold text-a-ink" title={entry.name}>
          {entry.name}
        </div>
        <div className="text-caption" style={{ color: KIND_COLOR[entry.kind] }}>
          {t(FINDER_KIND_LABEL[entry.kind])}
          {entry.isDir && entry.children !== null ? ` · ${entry.children === 1 ? t("1 Objekt") : t("{n} Objekte", { n: entry.children })}` : ""}
        </div>
      </div>
      <div>
        {!entry.isDir && <Meta label={t("Größe")} value={formatSize(entry.size)} />}
        <Meta label={t("Geändert")} value={formatDate(entry.mtimeMs)} />
        <Meta label={t("Ort")} value={entry.rel || "/"} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={onOpen} className="h-(--a-ctl-h) rounded-lg border border-a-acc/50 bg-a-acc/10 px-3 text-caption font-medium text-a-acc hover:bg-a-acc/20">
          {t("Öffnen")}
        </button>
        {src.canDownload(entry) && (
          <a href={src.rawUrl(root, entry.rel, true)} download={entry.name} className="inline-flex h-(--a-ctl-h) items-center rounded-lg border border-a-line px-3 text-caption text-a-ink hover:bg-a-p3">
            {t("Herunterladen")}
          </a>
        )}
      </div>
      {!entry.isDir && src.sessions && <FileSessions root={root} rel={entry.rel} />}
    </section>
  );
}

/** Übersicht (Leertaste): großes Fenster über allem, Esc/Leertaste schließen, Pfeile blättern. */
export function QuickLook({ root, entry, onClose, onMove, onOpen, onReveal }: { root: string; entry: FinderEntry; onClose: () => void; onMove: (delta: number) => void; onOpen: () => void; onReveal?: (child: FinderEntry) => void }) {
  const src = useFinderSource();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        onMove(1);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        onMove(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        onOpen();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, onMove, onOpen]);
  useEffect(() => ref.current?.focus(), []);
  const when = relativeTime(new Date(entry.mtimeMs).toISOString());
  return (
    <div className="fixed inset-0 z-50 grid place-items-center cc-scrim p-4 motion-safe:animate-[cc-tab-fade_120ms_ease-out]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("Übersicht: {name}", { name: entry.name })} className="flex max-h-[92vh] w-full max-w-[980px] flex-col overflow-hidden rounded-2xl border border-a-line bg-a-p shadow-2xl outline-none">
        <div className="flex items-center gap-2 border-b border-a-line px-4 py-2.5">
          <FileIcon entry={entry} size={18} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-callout font-semibold text-a-ink">{entry.name}</div>
            <div className="text-caption text-a-mut">
              {t(FINDER_KIND_LABEL[entry.kind])}
              {!entry.isDir ? ` · ${formatSize(entry.size)}` : ""}
              {when ? ` · ${t("geändert {when}", { when })}` : ""}
            </div>
          </div>
          <button type="button" onClick={onOpen} className="h-(--a-ctl-h) rounded-lg border border-a-acc/50 bg-a-acc/10 px-3 text-caption font-medium text-a-acc hover:bg-a-acc/20">
            {t("Öffnen")}
          </button>
          {src.canDownload(entry) && (
            <a href={src.rawUrl(root, entry.rel, true)} download={entry.name} className="inline-flex h-(--a-ctl-h) items-center rounded-lg border border-a-line px-3 text-caption text-a-ink hover:bg-a-p3">
              {t("Herunterladen")}
            </a>
          )}
          <button type="button" onClick={onClose} aria-label={t("Übersicht schließen")} className="h-(--a-ctl-h) rounded-lg border border-a-line px-2.5 text-caption text-a-mut hover:bg-a-p3">
            ✕
          </button>
        </div>
        <div className="cc-scroll min-h-0 flex-1 overflow-y-auto p-4">
          <PreviewBody root={root} entry={entry} big onReveal={onReveal} />
        </div>
        <div className="border-t border-a-line px-4 py-1.5 text-label text-a-mut">{t("Leertaste oder Esc schließt · Pfeiltasten blättern · Enter öffnet")}</div>
      </div>
    </div>
  );
}
