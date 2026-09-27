// Dialog für „Neuer Skill“, „Verbessern“ und „Vorschlag umsetzen“. Startet IMMER eine sichtbare,
// temporäre Claude-Session mit Opus 5.5 (das Modell steht fest und ist nicht wählbar).
import { SKILL_CREATE_TARGETS, SKILL_NAME_RE, SKILL_SOURCE_LABEL, t, type SkillCreateTarget, type SkillJob, type SkillJobRequest, type SkillSuggestion } from "@nyxos/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import { friendlyError } from "../../lib/friendlyError";
import { SOURCE_COLOR, startSkillJob, tint } from "./api";

export type JobDialogMode = { kind: "create" } | { kind: "improve"; skillKey: string } | { kind: "apply"; suggestion: SkillSuggestion };

const TITLE: Record<JobDialogMode["kind"], string> = {
  create: t("Neuer Skill"),
  improve: t("Skill verbessern"),
  apply: t("Vorschlag umsetzen"),
};

const TARGET_HINT: Record<SkillCreateTarget, string> = {
  user: t("für alle Projekte (~/.claude/skills)"),
  project: t("nur im Projektordner"),
  nyxos: t("nur im NyxOS-Repo"),
};

export function SkillJobDialog({ mode, onClose }: { mode: JobDialogMode; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [target, setTarget] = useState<SkillCreateTarget>("user");
  const [brief, setBrief] = useState("");
  const [done, setDone] = useState<SkillJob | null>(null);
  const first = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  useEffect(() => first.current?.focus(), []);

  const start = useMutation({
    mutationFn: (req: SkillJobRequest) => startSkillJob(req),
    onSuccess: (r) => {
      setDone(r.job);
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });

  const nameOk = SKILL_NAME_RE.test(name);
  const canSend = mode.kind === "create" ? nameOk && brief.trim().length >= 10 : true;
  const submit = () => {
    if (!canSend || start.isPending) return;
    if (mode.kind === "create") start.mutate({ kind: "create", name, target, brief: brief.trim() });
    else if (mode.kind === "improve") start.mutate({ kind: "improve", skillKey: mode.skillKey, brief: brief.trim() });
    else start.mutate({ kind: "apply", suggestionId: mode.suggestion.id, brief: brief.trim() });
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center cc-scrim p-4" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-job-title"
        data-testid="skill-job-dialog"
        className="grid max-h-[90dvh] w-full max-w-lg gap-3 overflow-y-auto rounded-2xl border border-a-line bg-a-p2 p-5 shadow-pop"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id="skill-job-title" className="font-display text-headline font-semibold text-a-ink">
            {TITLE[mode.kind]}
            {mode.kind === "improve" && <span className="font-mono text-a-mut"> /{mode.skillKey}</span>}
          </h2>
          <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-label font-semibold" style={{ color: "var(--a-claude)", background: tint("var(--a-claude)") }} title={t("Skills schreibt immer Opus 5.5 – nie Haiku.")}>
            <span aria-hidden>🔒</span> Opus 5.5
          </span>
        </div>

        {done ? (
          <div className="grid gap-3" data-testid="skill-job-started">
            <p className="text-callout text-a-ink">{t("Opus 5.5 arbeitet jetzt in einer eigenen, sichtbaren Session. Du kannst zuschauen, Fragen beantworten und Änderungen freigeben.")}</p>
            <p className="text-caption text-a-mut">{t("Die Session ist temporär und verschwindet später von selbst. Der neue Stand erscheint im Verlauf des Skills.")}</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                {t("Schließen")}
              </Button>
              {done.sessionHref ? (
                <Link to={done.sessionHref} onClick={onClose} className="inline-flex items-center rounded-md border border-transparent bg-a-primary px-2.5 py-1.5 text-caption font-semibold text-a-on-primary hover:brightness-110">
                  {t("Session öffnen →")}
                </Link>
              ) : (
                <span className="text-caption text-a-mut">{t("Die Session erscheint gleich unter „Sessions“.")}</span>
              )}
            </div>
          </div>
        ) : (
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {mode.kind === "create" && (
              <>
                <label className="grid gap-1 text-caption text-a-mut">
                  {t("Name (so rufst du ihn auf: /name)")}
                  <input
                    ref={(el) => {
                      first.current = el;
                    }}
                    value={name}
                    onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-"))}
                    placeholder={t("z. B. release-notizen")}
                    className={cn("h-(--a-ctl-h) rounded-lg border bg-a-bg/60 px-2.5 font-mono text-callout text-a-ink focus:outline-none", name && !nameOk ? "border-a-bad/60" : "border-a-line focus:border-a-acc/60")}
                  />
                </label>
                <fieldset className="grid gap-1.5">
                  <legend className="mb-1 text-caption text-a-mut">{t("Wo soll er liegen?")}</legend>
                  <div className="grid gap-1.5 sm:grid-cols-3">
                    {SKILL_CREATE_TARGETS.map((tg) => (
                      <button
                        key={tg}
                        type="button"
                        onClick={() => setTarget(tg)}
                        aria-pressed={target === tg}
                        className="grid gap-0.5 rounded-lg border px-2.5 py-2 text-left transition-colors"
                        style={target === tg ? { borderColor: SOURCE_COLOR[tg], background: tint(SOURCE_COLOR[tg]) } : { borderColor: "var(--a-line)" }}
                      >
                        <span className="text-caption font-medium" style={{ color: SOURCE_COLOR[tg] }}>
                          {SKILL_SOURCE_LABEL[tg]}
                        </span>
                        <span className="text-label leading-tight text-a-mut">{TARGET_HINT[tg]}</span>
                      </button>
                    ))}
                  </div>
                </fieldset>
              </>
            )}

            {mode.kind === "apply" && (
              <div className="grid gap-1.5 rounded-lg border border-a-wait/40 bg-a-wait/8 p-3 text-caption">
                <span className="font-medium text-a-ink">{mode.suggestion.problem}</span>
                <span className="text-a-mut">{t("Idee: {idea}", { idea: mode.suggestion.idea })}</span>
              </div>
            )}

            <label className="grid gap-1 text-caption text-a-mut">
              {mode.kind === "create" ? t("Was soll der Skill können? Wann soll er greifen?") : mode.kind === "improve" ? t("Was soll besser werden? (optional)") : t("Noch etwas für Opus? (optional)")}
              <textarea
                ref={(el) => {
                  if (mode.kind !== "create") first.current = el;
                }}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                rows={mode.kind === "create" ? 5 : 3}
                placeholder={mode.kind === "create" ? t("z. B. „Schreibt Release-Notizen für die App aus den Commits seit der letzten Version, kurz und auf Deutsch.“") : t("z. B. „Kürzer, und immer zuerst den Build prüfen.“")}
                className="rounded-lg border border-a-line bg-a-bg/60 px-2.5 py-2 text-callout leading-5 text-a-ink placeholder:text-a-mut focus:border-a-acc/60 focus:outline-none"
              />
            </label>

            <p className="text-caption leading-[17px] text-a-mut">
              {mode.kind === "create"
                ? t("Startet eine sichtbare, temporäre Claude-Session mit Opus 5.5. Sie folgt den Anthropic-Regeln für gute Skills und fragt dich, bevor sie fertig ist.")
                : t("Vorher wird der ganze Skill-Ordner auf deinem Rechner gesichert. Dann startet eine sichtbare, temporäre Claude-Session mit Opus 5.5. Jeder neue Stand landet im Verlauf – mit Rückgängig.")}
            </p>

            {start.isError && (
              <p role="alert" className="rounded-md border border-a-bad/40 bg-a-bad/10 px-2.5 py-1.5 text-caption text-a-bad">
                {friendlyError(start.error, t("Die Session ließ sich gerade nicht starten – bitte noch einmal versuchen."))}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                {t("Abbrechen")}
              </Button>
              <Button type="submit" variant="primary" disabled={!canSend || start.isPending} data-nyx="skills-job-start">
                {start.isPending ? t("Starte Opus …") : mode.kind === "create" ? t("Mit Opus 5.5 erstellen") : t("Mit Opus 5.5 starten")}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
