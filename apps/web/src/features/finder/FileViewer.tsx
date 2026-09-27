// Geöffnete Datei als Vollbild über dem Finder. Bilder groß mit Zoom und Blättern, PDF im
// eingebauten Betrachter, Text/Quelltext im Editor (Zeilennummern, Hervorhebung), Markdown zuerst als
// Dokument „wie PDF“ — umschaltbar auf Markdown zum Bearbeiten und Speichern (über die Brücke, mit
// Sicherungskopie und Konflikt-Prüfung). Alles andere: Info + Herunterladen.
import { FINDER_KIND_LABEL, finderIsTextKind, finderKindOf, t, type FinderEntry } from "@nyxos/shared";
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { FinderApiError, parentOf } from "./api";
import { useFinderSource } from "./source";
import { FileIcon } from "./FileIcon";
import { errorText, useText } from "./hooks";
import { MarkdownDocument } from "./MarkdownDocument";
import { formatDate, formatSize } from "./sort";

const CodeEditor = lazy(() => import("./CodeEditor"));

const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

export interface FileViewerProps {
  root: string;
  rel: string;
  /** Eintrag aus der Ordnerliste (für Größe/Datum/Art), falls schon geladen. */
  entry: FinderEntry | null;
  /** Bilder im selben Ordner (für ←/→). */
  siblings: FinderEntry[];
  onClose: () => void;
  onNavigate: (rel: string) => void;
  onReveal: () => void;
}

function btn(active = false) {
  return cn("inline-flex h-(--a-ctl-h) items-center rounded-lg border px-2.5 text-caption transition-colors", active ? "border-a-acc/50 bg-a-acc/12 text-a-acc" : "border-a-line text-a-ink hover:bg-a-p3");
}

export function FileViewer({ root, rel, entry, siblings, onClose, onNavigate, onReveal }: FileViewerProps) {
  const src = useFinderSource();
  const rawUrl = src.rawUrl;
  // Ohne Listeneintrag (Link von außen) entscheidet der Server beim Laden.
  const downloadable = entry ? src.canDownload(entry) : true;
  const name = rel.split("/").pop() ?? rel;
  const kind = entry?.kind ?? finderKindOf(name, false);
  const isText = finderIsTextKind(kind) && !entry?.secret;
  const [dirty, setDirty] = useState(false);
  const [askClose, setAskClose] = useState(false);

  const close = useCallback(() => {
    if (dirty) setAskClose(true);
    else onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLElement && e.target.closest(".cm-editor"))) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div role="dialog" aria-modal="true" aria-label={name} className="fixed inset-0 z-40 flex flex-col bg-a-bg/95 backdrop-blur-sm motion-safe:animate-[cc-tab-fade_150ms_ease-out]">
      <header className="flex flex-wrap items-center gap-2 border-b border-a-line bg-a-p px-3 py-2">
        <button type="button" onClick={close} className={btn()}>
          ‹ {t("Zurück")}
        </button>
        <FileIcon entry={{ kind, isDir: false }} size={18} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-callout font-semibold text-a-ink" title={name}>
            {name}
          </div>
          <div className="truncate text-caption text-a-mut" title={rel}>
            {t(FINDER_KIND_LABEL[kind])}
            {entry ? ` · ${formatSize(entry.size)} · ${formatDate(entry.mtimeMs)}` : ""} · {parentOf(rel) || t("oberste Ebene")}
          </div>
        </div>
        <button type="button" onClick={onReveal} className={btn()}>
          {t("Im Ordner zeigen")}
        </button>
        {downloadable && (
          <a href={rawUrl(root, rel, true)} download={name} className={btn()}>
            {t("Herunterladen")}
          </a>
        )}
        <span className="hidden rounded border border-a-line px-1.5 py-0.5 font-mono text-label text-a-mut sm:inline">Esc</span>
      </header>

      {askClose && (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-a-wait/40 bg-a-wait/10 px-4 py-2 text-caption text-a-ink">
          <span className="flex-1">{t("Du hast Änderungen, die noch nicht gespeichert sind.")}</span>
          <button type="button" className={btn()} onClick={() => setAskClose(false)}>
            {t("Weiter bearbeiten")}
          </button>
          <button type="button" className="inline-flex h-(--a-ctl-h) items-center rounded-lg border border-a-bad/50 bg-a-bad/10 px-2.5 text-caption text-a-bad hover:bg-a-bad/20" onClick={onClose}>
            {t("Verwerfen und schließen")}
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {entry?.secret ? (
          <InfoPanel root={root} rel={rel} entry={entry} text={src.secretText} noDownload />
        ) : kind === "image" && (!entry || src.canInline(entry)) ? (
          <ImageViewer root={root} rel={rel} name={name} siblings={siblings} onNavigate={onNavigate} />
        ) : kind === "pdf" && (!entry || src.canInline(entry)) ? (
          <iframe title={name} src={rawUrl(root, rel)} className="h-full w-full border-0 bg-white" />
        ) : kind === "video" && (!entry || src.canInline(entry)) ? (
          <div className="grid h-full place-items-center p-4">
            <video src={rawUrl(root, rel)} controls className="max-h-full max-w-full rounded-lg" />
          </div>
        ) : kind === "audio" && (!entry || src.canInline(entry)) ? (
          <div className="grid h-full place-items-center p-4">
            <audio src={rawUrl(root, rel)} controls className="w-full max-w-[560px]" />
          </div>
        ) : isText ? (
          <TextViewer root={root} rel={rel} name={name} markdown={kind === "markdown"} onDirty={setDirty} />
        ) : (
          <InfoPanel root={root} rel={rel} entry={entry} text={t("Diese Art Datei kann hier nicht angezeigt werden. Du kannst sie herunterladen.")} />
        )}
      </div>
    </div>
  );
}

function InfoPanel({ root, rel, entry, text, noDownload }: { root: string; rel: string; entry: FinderEntry | null; text: string; noDownload?: boolean }) {
  const src = useFinderSource();
  const rawUrl = src.rawUrl;
  const name = rel.split("/").pop() ?? rel;
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="cc-card-deep w-full max-w-[420px] space-y-3 border border-a-line p-5 text-center">
        <div className="grid place-items-center">
          <FileIcon entry={{ kind: entry?.kind ?? finderKindOf(name, false), isDir: false }} size={64} />
        </div>
        <div className="text-callout font-semibold break-all text-a-ink">{name}</div>
        {entry && (
          <div className="text-caption text-a-mut">
            {t(FINDER_KIND_LABEL[entry.kind])} · {formatSize(entry.size)} · {formatDate(entry.mtimeMs)}
          </div>
        )}
        <p className="text-caption text-a-mut">{text}</p>
        {!noDownload && (
          <a href={rawUrl(root, rel, true)} download={name} className="inline-flex h-(--a-ctl-h) items-center rounded-lg border border-a-acc/50 bg-a-acc/10 px-3 text-caption font-medium text-a-acc hover:bg-a-acc/20">
            {t("Herunterladen")}
          </a>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────── Bild ─────────────────────────────

function ImageViewer({ root, rel, name, siblings, onNavigate }: { root: string; rel: string; name: string; siblings: FinderEntry[]; onNavigate: (rel: string) => void }) {
  const rawUrl = useFinderSource().rawUrl;
  /** `null` = eingepasst (Standard). */
  const [zoom, setZoom] = useState<number | null>(null);
  const img = useRef<HTMLImageElement>(null);
  const images = siblings.filter((s) => s.kind === "image");
  const idx = images.findIndex((s) => s.rel === rel);

  useEffect(() => setZoom(null), [rel]);

  const current = useCallback(() => {
    if (zoom !== null) return zoom;
    const el = img.current;
    return el && el.naturalWidth > 0 ? el.clientWidth / el.naturalWidth : 1;
  }, [zoom]);
  const step = useCallback(
    (dir: 1 | -1) => {
      const now = current();
      const next = dir > 0 ? ZOOM_STEPS.find((z) => z > now + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < now - 0.001);
      setZoom(next ?? now);
    },
    [current],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "+" || e.key === "=") step(1);
      else if (e.key === "-") step(-1);
      else if (e.key === "0") setZoom(null);
      else if (e.key === "1") setZoom(1);
      else if (e.key === "ArrowRight" && idx >= 0 && idx < images.length - 1) onNavigate(images[idx + 1]?.rel ?? rel);
      else if (e.key === "ArrowLeft" && idx > 0) onNavigate(images[idx - 1]?.rel ?? rel);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, idx, images, onNavigate, rel]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-center gap-1.5 border-b border-a-line bg-a-p/60 px-3 py-1.5">
        {images.length > 1 && (
          <button type="button" disabled={idx <= 0} onClick={() => onNavigate(images[idx - 1]?.rel ?? rel)} className={cn(btn(), "disabled:opacity-40")} aria-label={t("Vorheriges Bild")}>
            ‹
          </button>
        )}
        <button type="button" onClick={() => step(-1)} className={btn()} aria-label={t("Verkleinern")}>
          −
        </button>
        <span className="min-w-[78px] text-center font-mono text-caption text-a-ink tabular-nums">{zoom === null ? t("Eingepasst") : `${Math.round(zoom * 100)} %`}</span>
        <button type="button" onClick={() => step(1)} className={btn()} aria-label={t("Vergrößern")}>
          +
        </button>
        <button type="button" onClick={() => setZoom(null)} className={btn(zoom === null)}>
          {t("Einpassen")}
        </button>
        <button type="button" onClick={() => setZoom(1)} className={btn(zoom === 1)}>
          100 %
        </button>
        {images.length > 1 && (
          <>
            <span className="px-1 text-caption text-a-mut tabular-nums">
              {idx + 1} / {images.length}
            </span>
            <button type="button" disabled={idx >= images.length - 1} onClick={() => onNavigate(images[idx + 1]?.rel ?? rel)} className={cn(btn(), "disabled:opacity-40")} aria-label={t("Nächstes Bild")}>
              ›
            </button>
          </>
        )}
      </div>
      <div
        className={cn("cc-scroll min-h-0 flex-1 overflow-auto bg-[repeating-conic-gradient(var(--a-p)_0_25%,var(--a-p2)_0_50%)] bg-[length:20px_20px]", zoom === null && "relative overflow-hidden")}
        onWheel={(e) => {
          if (!e.ctrlKey && !e.metaKey) return;
          e.preventDefault();
          step(e.deltaY < 0 ? 1 : -1);
        }}
      >
        <img
          ref={img}
          src={rawUrl(root, rel)}
          alt={name}
          draggable={false}
          onDoubleClick={() => setZoom(zoom === null ? 1 : null)}
          className={cn("select-none", zoom === null ? "absolute inset-0 m-auto max-h-[calc(100%-32px)] max-w-[calc(100%-32px)] object-contain shadow-2xl" : "m-auto block max-w-none")}
          style={zoom === null ? undefined : { width: img.current?.naturalWidth ? img.current.naturalWidth * zoom : undefined }}
        />
      </div>
    </div>
  );
}

// ───────────────────────────── Text / Markdown ─────────────────────────────

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; at: number } | { kind: "conflict" } | { kind: "error"; text: string };

function TextViewer({ root, rel, name, markdown, onDirty }: { root: string; rel: string; name: string; markdown: boolean; onDirty: (d: boolean) => void }) {
  const src = useFinderSource();
  const rawUrl = src.rawUrl;
  const qc = useQueryClient();
  const text = useText(root, rel);
  const [mode, setMode] = useState<"doc" | "md">(markdown ? "doc" : "md");
  const [draft, setDraft] = useState<string | null>(null);
  const [base, setBase] = useState<{ sha256: string; mtimeMs: number } | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  // Neu geladener Stand → Entwurf und Prüfsumme übernehmen (nur, wenn nichts ungespeichert ist).
  useEffect(() => {
    if (!text.data) return;
    if (draft === null || draft === text.data.content || base === null) {
      setDraft(text.data.content);
      setBase({ sha256: text.data.sha256, mtimeMs: text.data.mtimeMs });
    }
    // Absicht: nur auf neue Serverdaten reagieren, nicht auf jede Eingabe
  }, [text.data]);

  const content = text.data?.content ?? "";
  const current = draft ?? content;
  const dirty = draft !== null && text.data !== undefined && draft !== content;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const doSave = useCallback(
    async (force = false) => {
      const write = src.write;
      if (!write || !text.data || !text.data.writable || draft === null) return;
      setSave({ kind: "saving" });
      let sha = base?.sha256 ?? text.data.sha256;
      let mtime = base?.mtimeMs ?? text.data.mtimeMs;
      try {
        if (force) {
          const fresh = await text.refetch();
          if (fresh.data) {
            sha = fresh.data.sha256;
            mtime = fresh.data.mtimeMs;
          }
        }
        const res = await write({ root, rel, content: draft, baseSha256: sha, baseMtimeMs: mtime });
        setBase({ sha256: res.sha256, mtimeMs: res.mtimeMs });
        qc.setQueryData([src.key, "text", root, rel], { ...text.data, content: draft, sha256: res.sha256, mtimeMs: res.mtimeMs, size: res.size });
        void qc.invalidateQueries({ queryKey: [src.key, "list", root] });
        setSave({ kind: "saved", at: Date.now() });
      } catch (e) {
        if (e instanceof FinderApiError && e.status === 409) setSave({ kind: "conflict" });
        else setSave({ kind: "error", text: errorText(e) });
      }
    },
    [text, draft, base, root, rel, qc, src],
  );

  if (text.isLoading) return <div className="m-6 h-40 animate-pulse rounded-xl bg-a-p2" />;
  if (text.isError || !text.data) {
    const e = text.error;
    // Brücke (FinderApiError) wie Server (HostApiError): beide tragen den HTTP-Status.
    const raw = (e as { status?: unknown } | null)?.status;
    const status = typeof raw === "number" ? raw : 0;
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="cc-card-deep max-w-[440px] space-y-3 border border-a-line p-5 text-center">
          <p className="text-callout text-a-ink">{errorText(e)}</p>
          {(status === 413 || status === 415) && (
            <a href={rawUrl(root, rel, true)} download={name} className="inline-flex h-(--a-ctl-h) items-center rounded-lg border border-a-acc/50 bg-a-acc/10 px-3 text-caption font-medium text-a-acc">
              {t("Herunterladen")}
            </a>
          )}
          {status >= 500 || status === 0 ? (
            <button type="button" onClick={() => void text.refetch()} className={btn()}>
              {t("Noch einmal versuchen")}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const writable = text.data.writable;
  const lines = current.split("\n").length;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-a-line bg-a-p/60 px-3 py-1.5">
        {markdown && (
          <div role="group" aria-label={t("Ansicht")} className="inline-flex rounded-lg border border-a-line p-0.5">
            {(
              [
                ["doc", t("Dokument")],
                ["md", "Markdown"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={mode === id} onClick={() => setMode(id)} className={cn("h-[26px] rounded-md px-3 text-caption", mode === id ? "bg-a-acc/15 font-medium text-a-acc" : "text-a-mut hover:text-a-ink")}>
                {label}
              </button>
            ))}
          </div>
        )}
        <span className="text-caption text-a-mut tabular-nums">
          {lines === 1 ? t("1 Zeile") : t("{n} Zeilen", { n: lines })}
          {mode === "md" && !writable ? ` · ${t("nur lesen")}` : ""}
        </span>
        <span className="flex-1" />
        <SaveStatus state={save} dirty={dirty} />
        {mode === "md" && writable && (
          <button type="button" disabled={!dirty || save.kind === "saving"} onClick={() => void doSave(false)} className="inline-flex h-(--a-ctl-h) items-center rounded-lg border border-a-acc/50 bg-a-acc/10 px-3 text-caption font-medium text-a-acc hover:bg-a-acc/20 disabled:opacity-40">
            {save.kind === "saving" ? t("Speichert …") : t("Speichern")}
          </button>
        )}
      </div>
      {save.kind === "conflict" && (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-a-wait/40 bg-a-wait/10 px-4 py-2 text-caption text-a-ink">
          <span className="flex-1">{t("Die Datei wurde inzwischen woanders geändert (zum Beispiel von einer Session). Nichts wurde überschrieben.")}</span>
          <button
            type="button"
            className={btn()}
            onClick={() => {
              setDraft(null);
              setBase(null);
              setSave({ kind: "idle" });
              void text.refetch();
            }}
          >
            {t("Neu laden (deine Änderung verwerfen)")}
          </button>
          <button type="button" className={btn()} onClick={() => void doSave(true)}>
            {t("Trotzdem speichern")}
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {mode === "doc" ? (
          <div className="cc-scroll h-full overflow-y-auto px-4 py-8 md:px-8">
            <MarkdownDocument text={current} base={src.markdownLinks ? { root, rel } : undefined} />
          </div>
        ) : (
          <Suspense fallback={<div className="m-6 h-40 animate-pulse rounded-xl bg-a-p2" />}>
            <CodeEditor
              value={current}
              filename={name}
              readOnly={!writable}
              onChange={(v) => {
                setDraft(v);
                if (save.kind === "saved" || save.kind === "error") setSave({ kind: "idle" });
              }}
              onSave={() => void doSave(false)}
              label={t("Inhalt von {name}", { name })}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

function SaveStatus({ state, dirty }: { state: SaveState; dirty: boolean }) {
  if (state.kind === "saved" && !dirty)
    return (
      <span role="status" className="inline-flex items-center gap-1 text-caption font-medium text-a-ok">
        <span aria-hidden="true">✓</span>
        <span>{t("Gespeichert")}</span>
      </span>
    );
  if (state.kind === "error") return <span role="status" className="text-caption text-a-bad">{state.text}</span>;
  if (dirty) return <span className="text-caption text-a-wait">{t("Nicht gespeichert")}</span>;
  return null;
}
