// Reiter „Bilder“: alle Bilder, die Nyx gezeigt hat (Simulator-Screenshots, `show_image`) und die du
// ihm gegeben hast — als Galerie, groß ansehen (Pfeiltasten blättern, Esc schließt), herunterladen.
import { t, type NyxFile } from "@nyxos/shared";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { formatDateTime, relativeTime } from "../../../../lib/format";
import { cn } from "../../../../lib/cn";
import { ErrorBox } from "../../../haiku/ui";
import { fetchNyxFiles } from "../nyxTabApi";

const SOURCE_LABEL: Record<NyxFile["source"], string> = {
  simulator: "Simulator",
  show_image: t("von Nyx"),
  upload: t("von dir"),
  telegram: "Telegram",
};
const SOURCE_COLOR: Record<NyxFile["source"], string> = {
  simulator: "text-a-codex border-a-codex/40 bg-a-codex/10",
  show_image: "text-a-acc border-a-acc/40 bg-a-acc/10",
  upload: "text-a-violet border-a-violet/40 bg-a-violet/10",
  telegram: "text-a-indigo border-a-indigo/40 bg-a-indigo/10",
};

export function SourceBadge({ source }: { source: NyxFile["source"] }) {
  return <span className={cn("rounded-full border px-1.5 py-px font-mono text-label", SOURCE_COLOR[source])}>{SOURCE_LABEL[source]}</span>;
}

export function useNyxImages() {
  return useQuery({ queryKey: ["nyx", "files", "image"], queryFn: () => fetchNyxFiles("image"), staleTime: 10_000 });
}

/** Großansicht über dem ganzen Tab. */
export function ImageViewer({ files, index, onIndex, onClose }: { files: NyxFile[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const file = files[index];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") onIndex(Math.min(files.length - 1, index + 1));
      else if (e.key === "ArrowLeft") onIndex(Math.max(0, index - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [files.length, index, onClose, onIndex]);
  if (!file) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label={t("Bild: {name}", { name: file.title ?? file.name })} className="fixed inset-0 z-[70] flex flex-col bg-a-bg/95 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] backdrop-blur-sm" onClick={onClose}>
      <div className="flex items-center gap-3 border-b border-a-line px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
        <SourceBadge source={file.source} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-callout font-semibold text-a-ink">{file.title ?? file.name}</div>
          <div className="font-mono text-label text-a-mut">
            {formatDateTime(file.createdAt)} · {Math.max(1, Math.round(file.size / 1024))} KB · {t("{n} von {total}", { n: index + 1, total: files.length })}
          </div>
        </div>
        <a href={file.downloadUrl} download={file.name} className="rounded-md border border-a-acc bg-a-acc px-3 py-1.5 text-caption font-semibold text-a-bg hover:brightness-110" data-nyx="nyx-bild-herunterladen">
          {t("Herunterladen")}
        </a>
        <button type="button" onClick={onClose} className="rounded-md border border-a-line bg-a-p2 px-3 py-1.5 text-caption text-a-ink hover:bg-a-p3">
          {t("Schließen")}
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-6">
        {index > 0 && (
          <button type="button" aria-label={t("Voriges Bild")} onClick={(e) => (e.stopPropagation(), onIndex(index - 1))} className="absolute left-4 rounded-full border border-a-line bg-a-p2/80 px-3 py-2 text-a-ink hover:bg-a-p3">
            ‹
          </button>
        )}
        <img src={file.url} alt={file.title ?? file.name} className="max-h-full max-w-full rounded-lg border border-a-line object-contain shadow-2xl" onClick={(e) => e.stopPropagation()} />
        {index < files.length - 1 && (
          <button type="button" aria-label={t("Nächstes Bild")} onClick={(e) => (e.stopPropagation(), onIndex(index + 1))} className="absolute right-4 rounded-full border border-a-line bg-a-p2/80 px-3 py-2 text-a-ink hover:bg-a-p3">
            ›
          </button>
        )}
      </div>
    </div>
  );
}

export function ImagesPanel({ openImage }: { openImage: (files: NyxFile[], index: number) => void }) {
  const q = useNyxImages();
  const [filter, setFilter] = useState<"alle" | "nyx" | "du">("alle");
  const files = (q.data ?? []).filter((f) => (filter === "alle" ? true : filter === "du" ? f.source === "upload" : f.source !== "upload"));
  const open = useCallback((i: number) => openImage(files, i), [files, openImage]);

  return (
    <div className="cc-scroll grid h-full content-start gap-3 overflow-y-auto p-3">
      <div className="flex items-center gap-1.5">
        {(["alle", "nyx", "du"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn("rounded-full border px-2.5 py-0.5 text-caption", filter === f ? "border-a-acc bg-a-acc/15 text-a-acc" : "border-a-line text-a-mut hover:text-a-ink")}
          >
            {f === "alle" ? t("Alle") : f === "nyx" ? t("Von Nyx") : t("Von dir")}
          </button>
        ))}
        <span className="ml-auto font-mono text-label text-a-mut">{q.data ? (files.length === 1 ? t("1 Bild") : t("{n} Bilder", { n: files.length })) : ""}</span>
      </div>
      {q.isError && <ErrorBox text={t("Die Bilder lassen sich gerade nicht laden.")} onRetry={() => void q.refetch()} />}
      {q.isLoading && <div className="text-caption text-a-mut">{t("Lade Bilder …")}</div>}
      {q.data && files.length === 0 && (
        <div className="grid gap-1.5 rounded-xl border border-dashed border-a-line p-4 text-callout text-a-mut">
          <span className="text-a-ink">{t("Noch keine Bilder.")}</span>
          <span>{t("Sag zum Beispiel „Mach einen Screenshot vom Simulator“ – das Bild erscheint dann hier und in „Aufgaben live“.")}</span>
        </div>
      )}
      <ul className="grid grid-cols-2 gap-2.5" data-nyx="nyx-galerie">
        {files.map((f, i) => (
          <li key={f.id} className="min-w-0">
            <button type="button" onClick={() => open(i)} className="group grid w-full min-w-0 gap-1 rounded-lg border border-a-line bg-a-p2 p-1.5 text-left transition-colors hover:border-a-acc/60" aria-label={t("Bild öffnen: {name}", { name: f.title ?? f.name })}>
              <img src={f.url} alt="" loading="lazy" className="aspect-[4/3] w-full rounded-md bg-a-p3 object-cover" />
              <span className="flex min-w-0 items-center gap-1.5">
                <SourceBadge source={f.source} />
                <span className="min-w-0 truncate text-caption text-a-ink">{f.title ?? f.name}</span>
              </span>
              <span className="font-mono text-label text-a-mut">{relativeTime(f.createdAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
