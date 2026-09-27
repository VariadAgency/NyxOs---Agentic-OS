// Reiter „Dateien“ — alle Dateien, die Sessions gelesen oder geändert haben, nach Bereich
// (App-Repo, Worktrees, NyxOS, Doku …) und Ordner. Von oben nach unten, alles anklickbar: Datei →
// beteiligte Sessions → Session. Quelle ist `session_files` (was die Brücke aus den Verläufen liest).
import { t, tc, type FileAreaId, type FileModeFilter, type FileSession, type TouchedFile } from "@nyxos/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { KpiTile } from "../../components/KpiTile";
import { PageShell } from "../../components/PageShell";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { finderHref, parentOf } from "../finder/api";
import { useRoots } from "../finder/hooks";
import { fetchFiles, fetchFileSessions } from "./api";
import { sessionLabel } from "../../lib/sessionLabel";

/** Datei im Finder zeigen (Wurzel mit dem längsten passenden Pfad). Ohne Verbindung zur Brücke: kein Link. */
function RevealInFinder({ path }: { path: string }) {
  const roots = useRoots();
  const match = (roots.data?.roots ?? [])
    .filter((r) => r.abs && (path === r.abs || path.startsWith(`${r.abs}/`)))
    .sort((a, b) => b.abs.length - a.abs.length)[0];
  if (!match) return null;
  const rel = path.slice(match.abs.length + 1);
  return (
    <div className="px-3 pb-1">
      <Link to={finderHref(match.id, { dir: parentOf(rel), sel: rel, open: rel })} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-caption text-a-acc hover:bg-a-p3">
        {t("Öffnen · im Finder zeigen")} ›
      </Link>
    </div>
  );
}

/** Bereichs-Farben aus den Tokens — bunt und unterscheidbar, nie grau. */
const AREA_COLOR: Record<FileAreaId, string> = {
  projekte: "var(--a-teal)",
  worktrees: "var(--a-indigo)",
  sonstiges: "var(--a-done)",
};

const MODES: { value: FileModeFilter; label: string }[] = [
  { value: "alle", label: t("Alle") },
  { value: "geaendert", label: t("Geändert") },
  { value: "gelesen", label: t("Nur gelesen") },
];

const SEARCH_DELAY_MS = 250;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setV(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return v;
}

function chip(active: boolean) {
  return cn("inline-flex h-(--a-ctl-h) items-center rounded-full border px-2.5 text-caption", active ? "border-a-acc/50 bg-a-acc/10 text-a-acc" : "border-a-line text-a-mut hover:bg-a-p2");
}

export function FilesView({ embedded = false }: { embedded?: boolean } = {}) {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<FileModeFilter>("alle");
  const [area, setArea] = useState<FileAreaId | null>(null);
  const query = useDebounced(q.trim(), SEARCH_DELAY_MS);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["files", query, mode, area],
    queryFn: () => fetchFiles({ q: query, mode, area }),
    placeholderData: keepPreviousData,
  });

  const groups = useMemo(() => {
    const byArea = new Map<FileAreaId, Map<string, TouchedFile[]>>();
    for (const f of data?.files ?? []) {
      const folders = byArea.get(f.area) ?? new Map<string, TouchedFile[]>();
      const list = folders.get(f.folder) ?? [];
      list.push(f);
      folders.set(f.folder, list);
      byArea.set(f.area, folders);
    }
    return (data?.areas ?? []).filter((a) => byArea.has(a.id)).map((a) => ({ area: a, folders: [...(byArea.get(a.id) ?? new Map<string, TouchedFile[]>()).entries()] }));
  }, [data]);

  const changed = (data?.areas ?? []).reduce((n, a) => n + a.changed, 0);
  const filtering = q.trim() !== "" || mode !== "alle" || area !== null;

  return (
    <PageShell gap="gap-5">
      {embedded ? <h1 className="font-display text-title font-semibold text-a-ink">{t("Von Sessions angefasst")}</h1> : <h1 className="font-display text-title2 font-semibold text-a-ink">{t("Dateien")}</h1>}
      <div className="grid grid-cols-3 gap-3">
        <KpiTile label={t("Dateien")} value={data?.total ?? 0} detail={t("von Sessions angefasst")} />
        <KpiTile label={t("Geändert")} value={changed} detail={t("mindestens einmal geschrieben")} accent="acc" />
        <KpiTile label={t("Sessions")} value={data?.sessions ?? 0} detail={t("waren an diesen Dateien dran")} accent="ok" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-[240px] flex-1 items-center gap-2 h-(--a-ctl-h) rounded-lg border border-a-line bg-a-p px-3 focus-within:border-a-acc/60">
          <span aria-hidden="true" className="text-a-mut">
            ⌕
          </span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Dateien suchen …")} className="w-full bg-transparent text-callout text-a-ink outline-none placeholder:text-a-mut" />
        </label>
        <div className="flex gap-1.5">
          {MODES.map((m) => (
            <button key={m.value} type="button" onClick={() => setMode(m.value)} className={chip(mode === m.value)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {(data?.areas.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label={tc("files", "Bereiche")}>
          <button type="button" onClick={() => setArea(null)} className={chip(area === null)}>
            {t("Alle Bereiche")}
          </button>
          {data?.areas.map((a) => (
            <button key={a.id} type="button" onClick={() => setArea(area === a.id ? null : a.id)} className={cn(chip(area === a.id), "inline-flex items-center gap-1.5")}>
              <span aria-hidden="true" className="size-2 rounded-full" style={{ background: AREA_COLOR[a.id] }} />
              {a.label} <span className="tabular-nums text-a-mut">{a.files}</span>
            </button>
          ))}
        </div>
      )}

      <p className="text-caption text-a-mut">
        {t("Alle Dateien, die deine Sessions gelesen oder geändert haben, nach Bereich und Ordner. Ein Klick auf eine Datei zeigt, welche Sessions dran waren.")}
      </p>

      {isLoading && <div className="text-callout text-a-mut">{t("Lädt …")}</div>}
      {isError && <div className="text-callout text-a-bad">{t("Die Dateien konnten gerade nicht geladen werden. Die Seite versucht es gleich noch einmal.")}</div>}
      {!isLoading && !isError && (data?.files.length ?? 0) === 0 && (
        <div className="cc-card-deep border border-a-line p-6 text-center">
          {filtering ? (
            <>
              <b className="text-a-ink">{t("Keine Datei passt zu dieser Suche.")}</b>
              <p className="mt-1 text-caption text-a-mut">{t("Anderen Begriff versuchen oder Filter zurücksetzen.")}</p>
            </>
          ) : (
            <>
              <b className="text-a-ink">{t("Noch keine Dateien.")}</b>
              <p className="mt-1 text-caption text-a-mut">{t("Sobald eine Session eine Datei liest oder ändert, erscheint sie hier. Die Brücke liest das aus den Verläufen.")}</p>
            </>
          )}
        </div>
      )}

      {groups.map(({ area: a, folders }) => (
        <section key={a.id} aria-label={a.label} className="cc-card-deep min-w-0 border border-a-line p-3">
          <h2 className="flex flex-wrap items-baseline gap-2 px-1 pb-2 text-callout font-semibold text-a-ink">
            <span aria-hidden="true" className="size-2.5 translate-y-[1px] rounded-full" style={{ background: AREA_COLOR[a.id] }} />
            {a.label}
            <span className="font-sans text-caption font-normal text-a-mut">
              {a.files === 1 ? t("1 Datei") : t("{n} Dateien", { n: a.files })} · {t("{n} geändert", { n: a.changed })}
              {a.lastAt ? ` · ${tc("files", "zuletzt {when}", { when: relativeTime(a.lastAt) })}` : ""}
            </span>
          </h2>
          <div className="space-y-3">
            {folders.map(([folder, files]) => (
              <div key={folder}>
                <div className="truncate px-1 pb-1 font-mono text-label text-a-mut" title={folder || t("oberste Ebene")}>
                  {folder || t("oberste Ebene")}
                </div>
                <div className="space-y-0.5">
                  {files.map((f) => (
                    <FileRow key={f.path} file={f} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      {data?.truncated && <p className="text-caption text-a-mut">{t("Es werden die {n} zuletzt berührten Dateien gezeigt. Suche oder Bereich eingrenzen, um ältere zu finden.", { n: data.files.length })}</p>}
    </PageShell>
  );
}

function FileRow({ file }: { file: TouchedFile }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("rounded-lg border", open ? "border-a-line bg-a-p2" : "border-transparent")}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={file.path}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-a-p2"
      >
        <span className="min-w-0">
          <span className="block truncate text-callout font-medium text-a-ink">{file.name}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-label text-a-mut">
            {file.changed ? <span className="rounded bg-a-acc/15 px-1.5 py-0.5 text-a-acc">{t("geändert")}</span> : <span className="rounded bg-a-done/15 px-1.5 py-0.5 text-a-done">{t("gelesen")}</span>}
            <span className="truncate">{file.rel}</span>
          </span>
        </span>
        <span className="shrink-0 text-right text-caption text-a-mut tabular-nums">
          <span className="block text-a-ink">
            {file.sessions === 1 ? t("1 Session") : t("{n} Sessions", { n: file.sessions })}
          </span>
          {file.lastAt && <span className="block">{relativeTime(file.lastAt)}</span>}
        </span>
      </button>
      {open && <RevealInFinder path={file.path} />}
      {open && <FileSessionsList path={file.path} />}
    </div>
  );
}

function FileSessionsList({ path }: { path: string }) {
  const { data, isLoading, isError } = useQuery({ queryKey: ["file-sessions", path], queryFn: () => fetchFileSessions(path) });
  if (isLoading) return <div className="px-3 pb-2 text-caption text-a-mut">{t("Sessions werden geladen …")}</div>;
  if (isError || !data) return <div className="px-3 pb-2 text-caption text-a-bad">{t("Die Sessions zu dieser Datei konnten gerade nicht geladen werden.")}</div>;
  if (data.sessions.length === 0) return <div className="px-3 pb-2 text-caption text-a-mut">{t("Die Sessions dazu gibt es nicht mehr.")}</div>;
  return (
    <ul className="space-y-0.5 px-2 pb-2">
      {data.sessions.map((s) => (
        <li key={s.key}>
          <SessionLink session={s} />
        </li>
      ))}
    </ul>
  );
}

function SessionLink({ session: s }: { session: FileSession }) {
  const when = relativeTime(s.lastActivityAt ?? s.firstSeenAt);
  return (
    <Link to={s.href} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-caption hover:bg-a-p3">
      <span aria-hidden="true" className="size-2 rounded-full" style={{ background: s.tool === "codex" ? "var(--a-codex)" : "var(--a-claude)" }} />
      <span className="truncate text-a-ink">{sessionLabel(s)}</span>
      <span className="shrink-0 text-label text-a-mut">
        {s.modes.includes("write") ? t("geändert") : t("gelesen")}
        {s.closed ? ` · ${t("geschlossen")}` : ""}
        {when ? ` · ${when}` : ""}
      </span>
    </Link>
  );
}
