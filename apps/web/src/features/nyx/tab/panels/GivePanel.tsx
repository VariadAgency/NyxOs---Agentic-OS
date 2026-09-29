// Reiter „Dateien & Links“: Nyx etwas geben — hineinziehen, auswählen, einfügen (⌘V) oder einen Link.
// Dateien landen in der Nyx-Ablage (Server, Archiv-Volume); bei der nächsten Nachricht gehen sie als Anhänge mit.
import { t, type NyxFile } from "@nyxos/shared";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState, type DragEvent } from "react";
import { cn } from "../../../../lib/cn";
import { relativeTime } from "../../../../lib/format";
import { ErrorBox, FIELD } from "../../../haiku/ui";
import { fetchNyxFiles, uploadNyxFile } from "../nyxTabApi";
import type { PendingGift } from "./ChatPanel";
import { SourceBadge } from "./ImagesPanel";

const TEXT_EXCERPT_CHARS = 1500;
const TEXTY = /^(text\/|application\/(json|xml|x-yaml|yaml))/;

function isUrl(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

let giftSeq = 0;

export function GivePanel({ threadId, gifts, onAdd, onGoChat }: { threadId: number | null; gifts: PendingGift[]; onAdd: (g: PendingGift) => void; onGoChat: () => void }) {
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const given = useQuery({ queryKey: ["nyx", "files", "upload-all"], queryFn: () => fetchNyxFiles(), staleTime: 10_000 });

  const addFiles = async (files: Iterable<File>) => {
    setError(null);
    for (const f of files) {
      setBusy((b) => b + 1);
      try {
        const excerpt = TEXTY.test(f.type) && f.size < 512 * 1024 ? (await f.text()).slice(0, TEXT_EXCERPT_CHARS) : undefined;
        const stored = await uploadNyxFile(f, f.name || t("eingefuegt.png"), threadId);
        onAdd({ key: `g${giftSeq++}`, kind: "file", file: stored, excerpt });
        void given.refetch();
      } catch (e) {
        setError(e instanceof Error ? e.message : t("Die Datei ist nicht angekommen – bitte noch einmal versuchen."));
      } finally {
        setBusy((b) => b - 1);
      }
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const text = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
    else if (text && isUrl(text)) onAdd({ key: `g${giftSeq++}`, kind: "link", url: text.trim() });
  };

  const addLink = () => {
    if (!isUrl(link)) {
      setError(t("Das ist noch kein Link – er sollte mit https:// anfangen."));
      return;
    }
    onAdd({ key: `g${giftSeq++}`, kind: "link", url: link.trim() });
    setLink("");
    setError(null);
  };

  return (
    <div
      className="cc-scroll grid h-full content-start gap-3 overflow-y-auto p-3"
      onPaste={(e) => {
        const files = [...e.clipboardData.files];
        if (files.length) {
          e.preventDefault();
          void addFiles(files);
        }
      }}
    >
      <div
        role="button"
        tabIndex={0}
        data-nyx="nyx-dateien-ablage"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={cn(
          "grid cursor-pointer place-items-center gap-1 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors",
          drag ? "border-a-acc bg-a-acc/10" : "border-a-line bg-a-p2 hover:border-a-acc/50",
        )}
      >
        <span className="text-title2 text-a-acc" aria-hidden="true">
          ⇪
        </span>
        <span className="text-callout font-semibold text-a-ink">{t("Dateien hier hineinziehen")}</span>
        <span className="text-caption text-a-mut">{t("oder klicken zum Auswählen · Bilder auch mit ⌘V einfügen · höchstens 20 MB")}</span>
        {busy > 0 && <span className="text-caption text-a-acc">{t("Lade hoch …")}</span>}
      </div>
      <input ref={inputRef} type="file" multiple hidden onChange={(e) => e.target.files && void addFiles(e.target.files)} aria-label={t("Dateien für Nyx auswählen")} />

      <div className="flex gap-2">
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addLink()}
          placeholder={t("Link einfügen (https://…)")}
          aria-label={t("Link für Nyx")}
          className={FIELD}
        />
        <button type="button" onClick={addLink} className="shrink-0 rounded-md border border-a-line bg-a-p2 px-3 text-caption text-a-ink hover:bg-a-p3">
          {t("Geben")}
        </button>
      </div>
      {error && <ErrorBox text={error} />}

      {gifts.length > 0 && (
        <div className="grid gap-2 rounded-xl border border-a-violet/40 bg-a-violet/5 p-3">
          <div className="text-caption text-a-ink">
            {gifts.length === 1 ? t("1 Anhang liegt bereit für deine nächste Nachricht.") : t("{n} Anhänge liegen bereit für deine nächste Nachricht.", { n: gifts.length })}
          </div>
          <button type="button" onClick={onGoChat} className="justify-self-start rounded-md border border-a-acc bg-a-acc px-3 py-1.5 text-caption font-semibold text-a-bg hover:brightness-110">
            {t("Zum Chat und Nyx fragen")}
          </button>
        </div>
      )}

      <section className="grid gap-2">
        <h3 className="font-mono text-label uppercase tracking-wide text-a-mut">{t("Zuletzt gegeben & gezeigt")}</h3>
        {given.isError && <ErrorBox text={t("Die Liste lässt sich gerade nicht laden.")} onRetry={() => void given.refetch()} />}
        {given.data?.length === 0 && <span className="text-caption text-a-mut">{t("Noch nichts.")}</span>}
        <ul className="grid gap-1.5">
          {(given.data ?? []).slice(0, 30).map((f: NyxFile) => (
            <li key={f.id} className="flex min-w-0 items-center gap-2 rounded-lg border border-a-line bg-a-p2 px-2.5 py-1.5 text-caption">
              <span aria-hidden="true" className="font-mono text-a-mut">
                {f.kind === "image" ? "▣" : "▤"}
              </span>
              <span className="min-w-0 flex-1 truncate text-a-ink" title={f.name}>
                {f.name}
              </span>
              <SourceBadge source={f.source} />
              <span className="font-mono text-label text-a-mut">{relativeTime(f.createdAt)}</span>
              <a href={f.downloadUrl} download={f.name} className="text-a-acc underline">
                {t("laden")}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
