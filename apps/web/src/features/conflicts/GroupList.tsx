// Kollisionskarte ohne Hänger. Die Seite bekommt nur die Ordner-Zusammenfassung; die
// Dateien einer Gruppe lädt sie erst beim Aufklappen, je 50 (`/api/conflicts/entries`). Viele
// Gruppen werden virtualisiert (`@tanstack/react-virtual`, wie `AllFilesList` vorher).
// Jede Zeile bricht um bzw. kürzt mit Tooltip (`min-w-0`, kein `whitespace-nowrap`).
import { t, type CollisionEntry, type ConflictGroupSummary } from "@nyxos/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { useConflictEntries } from "../../hooks/useConflicts";
import { AskNyxButton } from "../../components/nyx/AskNyxButton";
import { groupSentence, SEVERITY_CLASS, SEVERITY_LABEL } from "./decisionText";
import { SessionDots } from "./SessionDots";

const STATE_LABEL: Record<CollisionEntry["state"], string> = { ok: t("in Ordnung"), "shared-read": t("eine schreibt, andere lesen"), conflict: t("Konflikt"), past: t("Rückblick · Sessions beendet") };
const STATE_COLOR: Record<CollisionEntry["state"], string> = { ok: "text-a-mut", "shared-read": "text-a-wait", conflict: "text-a-conf", past: "text-a-mut" };

/** Ab so vielen Ordnern wird die Liste virtualisiert (eigener Scrollbereich). */
export const GROUPS_VIRTUAL_FROM = 40;

function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}

export function EntryRow({ entry, onOpen }: { entry: CollisionEntry; onOpen: (path: string) => void }) {
  const { name, dir } = splitPath(entry.path);
  const who = entry.writers.map((w) => w.title ?? w.sessionKey).join(", ") || t("niemand schreibt");
  return (
    <button
      type="button"
      data-path={entry.path}
      onClick={() => onOpen(entry.path)}
      title={entry.path}
      className={cn("grid w-full min-w-0 gap-0.5 rounded-md px-2 py-1.5 text-left text-caption", entry.state === "conflict" ? "bg-a-conf/10 hover:bg-a-conf/15" : "hover:bg-a-p2")}
    >
      <span className="flex min-w-0 items-center gap-2">
        <SessionDots writers={entry.writers} max={4} />
        <span className="min-w-0 truncate font-mono text-a-ink">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-label text-a-mut">{dir}</span>
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-label">
        <span className={cn("shrink-0", STATE_COLOR[entry.state])}>{entry.reason ?? STATE_LABEL[entry.state]}</span>
        <span className="min-w-0 flex-1 truncate text-a-mut" title={who}>
          {who}
          {entry.reservation && ` · ${t("reserviert: {label}", { label: entry.reservation.label })}`}
        </span>
      </span>
    </button>
  );
}

/** Ab so vielen geladenen Dateien einer Gruppe: eigener, virtualisierter Scrollbereich. */
export const ENTRIES_VIRTUAL_FROM = 60;

function VirtualEntries({ entries, onOpen, onNearEnd }: { entries: CollisionEntry[]; onOpen: (path: string) => void; onNearEnd: () => void }) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const v = useVirtualizer({ count: entries.length, getScrollElement: () => parentRef.current, estimateSize: () => 46, overscan: 10, getItemKey: (i) => entries[i]?.path ?? i });
  const items = v.getVirtualItems();
  const last = items.at(-1);
  useEffect(() => {
    if (last && last.index >= entries.length - 10) onNearEnd();
  }, [last, entries.length, onNearEnd]);
  return (
    <div ref={parentRef} className="cc-scroll h-[50vh] min-w-0 overflow-y-auto" data-testid="entries-virtual">
      <div style={{ height: v.getTotalSize(), position: "relative" }}>
        {items.map((item) => {
          const e = entries[item.index];
          if (!e) return null;
          return (
            <div key={item.key} data-index={item.index} ref={v.measureElement} className="absolute left-0 top-0 w-full pb-0.5" style={{ transform: `translateY(${item.start}px)` }}>
              <EntryRow entry={e} onOpen={onOpen} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Dateien einer Gruppe bzw. Treffer einer Suche — seitenweise nachladen. */
export function EntryPages({ group, q, onOpen }: { group?: string; q?: string; onOpen: (path: string) => void }) {
  const query = useConflictEntries({ group, q }, true);
  const entries = query.data?.pages.flatMap((p) => p.entries) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  if (query.isLoading) return <p className="px-2 py-1.5 text-caption text-a-mut">{t("Lade …")}</p>;
  if (query.isError) {
    return (
      <p className="px-2 py-1.5 text-caption text-a-bad">
        {t("Konnte die Dateien nicht laden.")}{" "}
        <button type="button" className="underline" onClick={() => void query.refetch()}>
          {t("Nochmal")}
        </button>
      </p>
    );
  }
  if (entries.length === 0) return <p className="px-2 py-1.5 text-caption text-a-mut">{t("Keine Treffer.")}</p>;
  return (
    <div className="grid min-w-0 gap-0.5">
      {entries.length > ENTRIES_VIRTUAL_FROM ? (
        <VirtualEntries entries={entries} onOpen={onOpen} onNearEnd={() => query.hasNextPage && !query.isFetchingNextPage && void query.fetchNextPage()} />
      ) : (
        entries.map((e) => <EntryRow key={e.path} entry={e} onOpen={onOpen} />)
      )}
      {query.hasNextPage && (
        <button type="button" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} className="justify-self-start rounded-md px-2 py-1 text-caption text-a-acc hover:bg-a-p2 disabled:opacity-50">
          {query.isFetchingNextPage ? t("Lade …") : t("Weitere {n} von {rest} laden", { n: Math.min(50, total - entries.length), rest: total - entries.length })}
        </button>
      )}
    </div>
  );
}

function GroupItem({ group, open, onToggle, onOpen }: { group: ConflictGroupSummary; open: boolean; onToggle: () => void; onOpen: (path: string) => void }) {
  return (
    <div data-tile className={cn("min-w-0 rounded-lg border", group.conflictCount > 0 ? "border-a-conf/40 bg-a-conf/5" : "border-a-line bg-a-p")}>
      <button type="button" data-testid="group-toggle" onClick={onToggle} aria-expanded={open} className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-left">
        <span className={cn("shrink-0 text-a-mut transition-transform", open && "rotate-90")}>›</span>
        <span className="min-w-0 flex-1 truncate font-mono text-caption text-a-ink" title={group.key}>
          {group.key}
        </span>
        <span className="flex shrink-0 flex-wrap items-center gap-1.5">
          <SessionDots writers={group.writers} max={6} />
          {group.writerCount > group.writers.length && <span className="text-label text-a-mut">+{group.writerCount - group.writers.length}</span>}
          {group.severity && <span className={cn("rounded-full border px-2 py-0.5 text-label", SEVERITY_CLASS[group.severity])}>{SEVERITY_LABEL[group.severity]}</span>}
          {group.conflictCount > 0 && (
            <span className="rounded-full bg-a-conf/15 px-2 py-0.5 text-label text-a-conf">
              {group.conflictCount === 1 ? t("1 Konflikt") : t("{n} Konflikte", { n: group.conflictCount })}
            </span>
          )}
          <span className="text-label text-a-mut">
            {group.fileCount === 1 ? t("1 Datei") : t("{n} Dateien", { n: group.fileCount })}
          </span>
        </span>
      </button>
      {/* In einem Satz, was hier gerade passiert – und Nyx kann es erklären. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2 pl-7">
        <p data-testid="group-sentence" className="min-w-0 flex-1 text-caption text-a-mut [overflow-wrap:anywhere]">
          {groupSentence(group)}
        </p>
        {(group.conflictCount > 0 || group.sharedReadCount > 0) && <AskNyxButton compact inline={false} label={t("Nyx zum Ordner {folder} fragen", { folder: group.key })} question={t("Was passiert gerade im Ordner „{folder}“ zwischen meinen Sessions?", { folder: group.key })} facts={`${group.key}: ${groupSentence(group)} ${t("Dateien gesamt: {n}.", { n: group.fileCount })}`} />}
      </div>
      {open && (
        <div className="border-t border-a-line p-1.5">
          <EntryPages group={group.key} onOpen={onOpen} />
        </div>
      )}
    </div>
  );
}

function VirtualGroups({ groups, isOpen, toggle, onOpen }: { groups: ConflictGroupSummary[]; isOpen: (k: string) => boolean; toggle: (k: string) => void; onOpen: (p: string) => void }) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const v = useVirtualizer({ count: groups.length, getScrollElement: () => parentRef.current, estimateSize: () => 46, overscan: 8, getItemKey: (i) => groups[i]?.key ?? i });
  return (
    <div ref={parentRef} className="cc-scroll h-[70vh] min-w-0 overflow-y-auto rounded-lg" data-testid="groups-virtual">
      <div style={{ height: v.getTotalSize(), position: "relative" }}>
        {v.getVirtualItems().map((item) => {
          const g = groups[item.index];
          if (!g) return null;
          return (
            <div key={item.key} data-index={item.index} ref={v.measureElement} className="absolute left-0 top-0 w-full pb-1.5" style={{ transform: `translateY(${item.start}px)` }}>
              <GroupItem group={g} open={isOpen(g.key)} onToggle={() => toggle(g.key)} onOpen={onOpen} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function GroupList({ groups, onOpen }: { groups: ConflictGroupSummary[]; onOpen: (path: string) => void }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  if (groups.length > GROUPS_VIRTUAL_FROM) return <VirtualGroups groups={groups} isOpen={(k) => open.has(k)} toggle={toggle} onOpen={onOpen} />;
  return (
    <div className="grid min-w-0 gap-1.5">
      {groups.map((g) => (
        <GroupItem key={g.key} group={g} open={open.has(g.key)} onToggle={() => toggle(g.key)} onOpen={onOpen} />
      ))}
    </div>
  );
}
