// Reiter „Aufgaben live“: was Nyx gerade wo macht (`nyx.task`) — je Aufgabe eine Karte, die sich
// fortschreibt: Schritt-Liste, wo es passiert (anklickbar), Vorschau-Karten mit Bild bzw. Link.
import { nyxToolName, t, tc, type NyxFile, type NyxState, type NyxStepStatus } from "@nyxos/shared";
import { Link } from "react-router";
import { cn } from "../../../../lib/cn";
import { relativeTime } from "../../../../lib/format";
import type { NyxTaskCard } from "../useNyxLive";

const STATUS: Record<NyxTaskCard["status"], { label: string; cls: string }> = {
  running: { label: t("läuft"), cls: "border-a-acc/50 bg-a-acc/10 text-a-acc" },
  done: { label: t("fertig"), cls: "border-a-ok/50 bg-a-ok/10 text-a-ok" },
  failed: { label: tc("nyx", "hat nicht geklappt"), cls: "border-a-bad/50 bg-a-bad/10 text-a-bad" },
};
const STEP: Record<NyxStepStatus, { icon: string; label: string; cls: string }> = {
  pending: { icon: "○", label: tc("nyx", "offen"), cls: "text-a-mut" },
  running: { icon: "◌", label: t("läuft"), cls: "text-a-acc motion-safe:animate-pulse" },
  done: { icon: "✓", label: t("erledigt"), cls: "text-a-ok" },
  failed: { icon: "✕", label: t("fehlgeschlagen"), cls: "text-a-bad" },
  cancelled: { icon: "–", label: tc("nyx", "verworfen"), cls: "text-a-mut" },
};

const STATE_TEXT: Record<NyxState, string> = {
  idle: t("Nyx wartet auf dich."),
  listening: t("Nyx hört zu."),
  thinking: t("Nyx denkt nach."),
  speaking: t("Nyx spricht."),
  tool: t("Nyx arbeitet mit einem Werkzeug."),
};

function fileFromId(fileId: number, title?: string): NyxFile {
  return { id: fileId, kind: "image", source: "show_image", name: title ?? t("Bild {id}", { id: fileId }), title: title ?? null, mime: "image/png", size: 0, createdAt: new Date().toISOString(), url: `/api/nyx/files/${fileId}`, downloadUrl: `/api/nyx/files/${fileId}?download=1` };
}

export function TasksPanel({
  tasks,
  state,
  tool,
  detail,
  openImage,
}: {
  tasks: NyxTaskCard[];
  state: NyxState;
  tool: string | null;
  detail?: string | null;
  openImage: (files: NyxFile[], index: number) => void;
}) {
  return (
    <div className="cc-scroll grid h-full content-start gap-3 overflow-y-auto p-3" data-nyx="nyx-aufgaben">
      <div className="flex items-center gap-2 rounded-lg border border-a-line bg-a-p2 px-3 py-2 text-caption">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", state === "idle" ? "bg-a-idle" : state === "tool" ? "bg-a-claude" : "bg-a-acc", state !== "idle" && "motion-safe:animate-pulse")} />
        <span className="text-a-ink">{STATE_TEXT[state]}</span>
        {tool && <span className="rounded-full border border-a-claude/40 bg-a-claude/10 px-2 py-px text-label text-a-claude">{nyxToolName(tool)}</span>}
        {detail && <span className="min-w-0 truncate text-a-mut">{detail}</span>}
      </div>
      {tasks.length === 0 && (
        <div className="grid gap-1.5 rounded-xl border border-dashed border-a-line p-4 text-callout text-a-mut">
          <span className="text-a-ink">{t("Gerade keine Aufgabe.")}</span>
          <span>{t("Wenn Nyx etwas für dich erledigt – einen Screenshot machen, Sessions lesen, einen Auftrag vorbereiten –, siehst du hier live jeden Schritt, mit Vorschau.")}</span>
        </div>
      )}
      {tasks.map((task) => {
        const images = task.images.map((im) => fileFromId(im.fileId, im.title));
        return (
          <article key={task.taskId} className="cc-rise grid gap-2 rounded-xl border border-a-line bg-a-p2 p-3" aria-label={t("Aufgabe: {title}", { title: task.title })}>
            <header className="flex min-w-0 items-start gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="text-callout font-semibold text-a-ink">{task.title}</h3>
                <div className="flex flex-wrap items-center gap-x-2 font-mono text-label text-a-mut">
                  {task.where &&
                    (task.href ? (
                      <Link to={task.href} className="text-a-acc underline">
                        {task.where}
                      </Link>
                    ) : (
                      <span>{task.where}</span>
                    ))}
                  {task.tool && <span className="font-sans text-a-claude">{nyxToolName(task.tool)}</span>}
                  <span>{relativeTime(task.updatedAt)}</span>
                </div>
              </div>
              <span className={cn("shrink-0 rounded-full border px-2 py-px font-mono text-label", STATUS[task.status].cls)}>{STATUS[task.status].label}</span>
            </header>
            {task.text && <p className="text-caption leading-relaxed text-a-ink/90">{task.text}</p>}
            {task.steps.length > 0 && (
              <ol className="grid gap-1">
                {task.steps.map((s) => (
                  <li key={s.index} className="flex items-center gap-2 text-caption">
                    <span className={cn("w-4 text-center font-mono", STEP[s.status].cls)} aria-label={STEP[s.status].label}>
                      {STEP[s.status].icon}
                    </span>
                    <span className={cn(s.status === "done" || s.status === "pending" ? "text-a-mut" : "text-a-ink", s.status === "cancelled" && "text-a-mut line-through")}>{s.label}</span>
                  </li>
                ))}
              </ol>
            )}
            {images.length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                {images.map((f, i) => (
                  <button key={f.id} type="button" onClick={() => openImage(images, i)} className="overflow-hidden rounded-lg border border-a-line hover:border-a-acc/60" aria-label={t("Vorschau öffnen: {name}", { name: f.name })}>
                    <img src={f.url} alt={f.name} className="aspect-[4/3] w-full bg-a-p3 object-cover" />
                  </button>
                ))}
              </div>
            )}
            {task.links.map((l) => (
              <a key={l.url} href={l.url} target="_blank" rel="noreferrer noopener" className="grid gap-0.5 rounded-lg border border-a-line bg-a-p3 px-3 py-2 hover:border-a-acc/60">
                <span className="text-caption text-a-ink">{l.title ?? l.url}</span>
                <span className="truncate font-mono text-label text-a-acc">{l.url}</span>
              </a>
            ))}
          </article>
        );
      })}
    </div>
  );
}
