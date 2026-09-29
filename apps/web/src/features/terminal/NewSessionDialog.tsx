import { t } from "@nyxos/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { friendlyError } from "../../lib/friendlyError";
import { useNavigate } from "react-router";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import { NEW_SESSION_EVENT, useBridgeStatus, useFolders, useStartSession, type NewSessionInitial } from "./terminalApi";
import { TemporarySwitch } from "../temporary/TemporarySwitch";

/** Wert = was `claude --model` versteht. Opus bleibt beim Alias „opus“ (= Opus 5.5, so belegt auch „Agent starten“ vor). */
const MODELS: Record<"claude" | "codex", { value: string; label: string }[]> = {
  claude: [
    { value: "", label: t("Standard") },
    { value: "opus", label: "Opus 5.5" },
    { value: "claude-sonnet-5", label: "Sonnet 5" },
    { value: "claude-fable-5-1", label: "Fable 5.1" },
    { value: "claude-haiku-4-5", label: "Haiku 4.5" },
  ],
  codex: [{ value: "", label: t("Standard") }],
};

/**
 * „+ Neue Session" (Tab-Zeile 3 und ⌘K): Werkzeug, Modell, Ordner, optional erste
 * Nachricht. Die Brücke startet in tmux; danach springt die Ansicht direkt ins Terminal der Session.
 */
export function NewSessionDialog() {
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState<"claude" | "codex">("claude");
  const [model, setModel] = useState("");
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [temporary, setTemporary] = useState(false);
  // Aus dem Aufgaben-Tab vorbelegt — Auftrag, an dem die Session hängt, und das gesuchte Repo.
  const [forEntry, setForEntry] = useState<{ id: number; title: string } | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const qc = useQueryClient();
  const forEntryRef = useRef(false);
  const bridge = useBridgeStatus();
  const online = bridge.data?.online ?? false;
  const folders = useFolders(open && online);
  const start = useStartSession();
  const navigate = useNavigate();

  useEffect(() => {
    const show = (ev: Event) => {
      const initial = (ev as CustomEvent<NewSessionInitial | undefined>).detail;
      if (initial) {
        setTool(initial.tool);
        setModel(initial.model);
        setPrompt(initial.prompt);
        setCwd("");
        setRepo(initial.repo);
        setForEntry({ id: initial.entryId, title: initial.entryTitle });
      } else if (forEntryRef.current) {
        // Normales „+ Neue Session“ nach einer Vorbelegung: nichts vom Auftrag mitnehmen.
        setPrompt("");
        setModel("");
        setForEntry(null);
        setRepo(null);
      }
      setOpen(true);
      start.reset();
    };
    window.addEventListener(NEW_SESSION_EVENT, show);
    return () => window.removeEventListener(NEW_SESSION_EVENT, show);
  }, []);

  useEffect(() => {
    forEntryRef.current = forEntry !== null;
  }, [forEntry]);

  useEffect(() => {
    const list = folders.data;
    if (!list?.[0]) return;
    if (repo !== null) {
      // Repo des Auftrags unter den Ordnern der Brücke suchen; fehlt es dort, direkt unter dem ersten Ordner.
      const root = list[0].path;
      const hit = repo === "" ? list[0] : list.find((f) => f.path === `${root}/${repo}`);
      setCwd(hit?.path ?? `${root}/${repo}`);
      setRepo(null);
      return;
    }
    if (!cwd) setCwd(list[0].path);
  }, [folders.data, cwd, repo]);

  if (!open) return null;
  const close = () => !start.isPending && setOpen(false);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center cc-scrim p-4" role="presentation" onClick={close}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-title"
        className="grid w-full max-w-md gap-3 rounded-2xl border border-a-line bg-a-p2 p-5 shadow-pop"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          start.mutate(
            { tool, model: model || null, cwd, prompt: prompt.trim() || null, ...(temporary ? { temporary: true } : {}), ...(forEntry ? { entryId: forEntry.id } : {}) },
            {
              onSuccess: (r) => {
                setOpen(false);
                setPrompt("");
                setTemporary(false);
                if (forEntry) void qc.invalidateQueries({ queryKey: ["entries"] });
                setForEntry(null);
                if (r.sessionId) navigate(`/sessions/unsortiert/_/${r.tool}:${r.sessionId}?tab=terminal`);
              },
            },
          );
        }}
      >
        <h2 id="new-session-title" className="font-display text-callout font-semibold text-a-ink">
          {t("Neue Session")}
        </h2>
        {forEntry && (
          <p className="rounded-md border px-2.5 py-1.5 text-caption text-a-ink" style={{ borderColor: "color-mix(in srgb, var(--a-violet) 40%, var(--a-line))", background: "color-mix(in srgb, var(--a-violet) 8%, transparent)" }}>
            {t("Für den Auftrag")} <span className="font-medium">{forEntry.title}</span>. {t("Die Session erscheint danach am Auftrag. Prüf alles und klick auf „Starten“.")}
          </p>
        )}
        {!online && <p className="text-caption text-a-bad">{t("Die Brücke ist gerade nicht verbunden – Starten geht erst, wenn sie wieder da ist.")}</p>}
        <div className="flex gap-1.5" role="radiogroup" aria-label={t("Werkzeug")} data-nyx="new-session:tool">
          {(["claude", "codex"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={tool === option}
              onClick={() => {
                setTool(option);
                setModel("");
              }}
              className={cn("rounded-md border px-3 py-1.5 text-caption", tool === option ? "border-a-acc bg-a-p3 text-a-ink" : "border-a-line text-a-mut hover:text-a-ink")}
            >
              {option === "claude" ? "Claude" : "Codex"}
            </button>
          ))}
        </div>
        <label className="grid gap-1 text-caption text-a-mut">
          {t("Modell")}
          <select aria-label={t("Modell")} data-nyx="new-session:model" value={model} onChange={(e) => setModel(e.target.value)} className="rounded-md border border-a-line bg-a-p2 px-2 py-1.5 text-caption text-a-ink">
            {MODELS[tool].map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-caption text-a-mut">
          {t("Ordner")}
          <select aria-label={t("Ordner")} data-nyx="new-session:folder" value={cwd} onChange={(e) => setCwd(e.target.value)} disabled={!folders.data} className="rounded-md border border-a-line bg-a-p2 px-2 py-1.5 text-caption text-a-ink">
            {(folders.data ?? []).map((f) => (
              <option key={f.path} value={f.path}>
                {f.label}
              </option>
            ))}
            {cwd && folders.data && !folders.data.some((f) => f.path === cwd) && <option value={cwd}>{cwd.split("/").slice(-2).join("/")}</option>}
          </select>
        </label>
        <label className="grid gap-1 text-caption text-a-mut">
          {t("Erste Nachricht (optional)")}
          <textarea
            aria-label={t("Erste Nachricht (optional)")}
            data-nyx="new-session:prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            className="resize-y rounded-md border border-a-line bg-a-p2 px-2 py-1.5 text-caption text-a-ink outline-none focus:border-a-acc"
          />
        </label>
        <TemporarySwitch checked={temporary} onChange={setTemporary} what="session" />
        {start.isError && (
          <p role="alert" className="text-caption text-a-bad">
            {friendlyError(start.error, t("Die Session ließ sich nicht starten – bitte noch einmal versuchen."))}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close} disabled={start.isPending}>
            {t("Abbrechen")}
          </Button>
          <Button variant="primary" type="submit" data-nyx="new-session:start" disabled={!online || !cwd || start.isPending}>
            {start.isPending ? t("Starte …") : t("Starten")}
          </Button>
        </div>
      </form>
    </div>
  );
}
