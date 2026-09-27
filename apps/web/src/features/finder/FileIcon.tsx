// Symbole je Art — bunt aus den Tokens (Kategorien nie grau/weiß/schwarz).
// Bilder bekommen ein echtes Vorschaubild (von der Brücke berechnet), bei Fehlschlag fällt es auf das Symbol zurück.
import type { FinderEntry, FinderKind } from "@nyxos/shared";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { useFinderSource } from "./source";

export const KIND_COLOR: Record<FinderKind, string> = {
  folder: "var(--a-acc)",
  image: "var(--a-violet)",
  pdf: "var(--a-bad)",
  markdown: "var(--a-done)",
  code: "var(--a-lime)",
  text: "var(--a-indigo)",
  audio: "var(--a-conf)",
  video: "var(--a-wait)",
  archive: "var(--a-claude)",
  other: "var(--a-codex)",
};

const KIND_GLYPH: Record<FinderKind, string> = {
  folder: "",
  image: "▣",
  pdf: "PDF",
  markdown: "MD",
  code: "</>",
  text: "TXT",
  audio: "♪",
  video: "▶",
  archive: "ZIP",
  other: "•",
};

/** Ordner-Symbol als kleine Zeichnung (Reiter + Körper), Farbe aus den Tokens. */
function FolderGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size * 0.8} viewBox="0 0 40 32" aria-hidden="true">
      <path d="M2 6a3 3 0 0 1 3-3h10l4 4h16a3 3 0 0 1 3 3v2H2z" fill="var(--a-acc)" opacity="0.75" />
      <rect x="2" y="9" width="36" height="21" rx="3" fill="var(--a-acc)" />
      <rect x="2" y="9" width="36" height="3" fill="white" opacity="0.12" />
    </svg>
  );
}

export function FileIcon({ entry, size = 16, className }: { entry: Pick<FinderEntry, "kind" | "isDir">; size?: number; className?: string }) {
  if (entry.isDir) {
    return (
      <span className={cn("inline-grid shrink-0 place-items-center", className)} style={{ width: size, height: size }}>
        <FolderGlyph size={size} />
      </span>
    );
  }
  const color = KIND_COLOR[entry.kind];
  const glyph = KIND_GLYPH[entry.kind];
  return (
    <span
      aria-hidden="true"
      className={cn("inline-grid shrink-0 place-items-center rounded-[3px] border font-mono font-semibold leading-none", className)}
      style={{
        width: size * 0.8,
        height: size,
        fontSize: Math.max(6, size * (glyph.length > 2 ? 0.24 : 0.34)),
        color,
        borderColor: `color-mix(in srgb, ${color} 55%, transparent)`,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
      }}
    >
      {size >= 28 ? glyph : ""}
    </span>
  );
}

/**
 * Höchstens so viele Vorschaubilder laden gleichzeitig. Der Browser hat je Server nur 6
 * Verbindungen — liefen dort Dutzende Vorschauen (die Brücke rechnet sie aus), wartete die nächste
 * Ordner-Liste dahinter (ein großer Downloads-Ordner stand erst nach Sekunden).
 */
export const THUMB_PARALLEL = 3;
const slots = { running: 0, waiting: [] as (() => void)[] };

function takeSlot(start: () => void): () => void {
  let state: "waiting" | "running" | "done" = "waiting";
  const go = () => {
    state = "running";
    slots.running++;
    start();
  };
  if (slots.running < THUMB_PARALLEL) go();
  else slots.waiting.push(go);
  return () => {
    if (state === "waiting") {
      const i = slots.waiting.indexOf(go);
      if (i >= 0) slots.waiting.splice(i, 1);
    } else if (state === "running") {
      slots.running--;
      slots.waiting.shift()?.();
    }
    state = "done";
  };
}

/** Nur Tests: Stand der Warteschlange. */
export function __thumbSlotsForTests(): { running: number; waiting: number } {
  return { running: slots.running, waiting: slots.waiting.length };
}

/** Vorschaubild (nur Bilder/PDF), sonst das Symbol. Lädt erst, wenn es in die Nähe des Sichtbaren kommt
 * und ein Platz frei ist; bis dahin steht das Symbol. */
export function Thumb({ root, entry, size, className }: { root: string; entry: FinderEntry; size: number; className?: string }) {
  const source = useFinderSource();
  const [failed, setFailed] = useState(false);
  const [go, setGo] = useState(false);
  const holder = useRef<HTMLSpanElement>(null);
  const release = useRef<(() => void) | null>(null);
  // Die Quelle entscheidet (Brücke: berechnete Vorschau; Server: das Bild selbst, nur Rasterbilder bis 2 MB).
  const src = source.thumbUrl(root, entry, size) ?? "";
  const thumbable = src !== "";
  useEffect(() => {
    if (!thumbable) return;
    setGo(false);
    let cancelled = false;
    let io: IntersectionObserver | null = null;
    const ask = () => {
      release.current = takeSlot(() => {
        if (!cancelled) setGo(true);
      });
    };
    const el = holder.current;
    if (el && typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver((items) => {
        if (!items.some((i) => i.isIntersecting)) return;
        io?.disconnect();
        io = null;
        ask();
      }, { rootMargin: "300px" });
      io.observe(el);
    } else ask();
    return () => {
      cancelled = true;
      io?.disconnect();
      release.current?.();
      release.current = null;
    };
  }, [thumbable, src]);
  const done = () => {
    release.current?.();
    release.current = null;
  };
  if (!thumbable || failed) return <FileIcon entry={entry} size={size} className={className} />;
  if (!go)
    return (
      <span ref={holder} className="inline-grid">
        <FileIcon entry={entry} size={size} className={className} />
      </span>
    );
  return (
    <img
      src={src}
      alt=""
      decoding="async"
      onLoad={done}
      onError={() => {
        done();
        setFailed(true);
      }}
      className={cn("rounded-[4px] object-contain shadow-[0_1px_3px_rgba(0,0,0,0.5)]", className)}
      style={{ maxWidth: size, maxHeight: size }}
    />
  );
}
