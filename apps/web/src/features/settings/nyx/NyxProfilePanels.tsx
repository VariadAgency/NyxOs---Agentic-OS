// Einstellungen → Nyx → Persönlichkeit und Über dich. Formerly one long page, now two subpages with a shared draft
// (`NyxProfileContext`): Persönlichkeit = Vorlagen, Live-Beispielsatz, Regler, Charakter; Über dich = Nutzerprofil.
// Fixed at the bottom: Zurücksetzen · Speichern (`NyxSaveBar`). The server builds the prompt section from exactly
// these values (`apps/server/src/nyx/persona.ts`).
import "./nyx.css";
import {
  NYX_FIELD_MAX,
  NYX_PRESET_LABEL_MAX,
  NYX_SLIDER_STAGES,
  NYX_SLIDERS,
  NYX_TEXT_MAX,
  getLang,
  matchingNyxPreset,
  quote,
  nyxLevel,
  t,
  type NyxPersonality,
  type NyxPreset,
  type NyxProfile,
  type NyxSliderKey,
  type NyxUserProfile,
} from "@nyxos/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, type ReactNode, useId, useMemo, useState } from "react";
import { Link } from "react-router";
import { Skeleton } from "../../../components/ui/skeleton";
import { cn } from "../../../lib/cn";
import { friendlyError } from "../../../lib/friendlyError";
import { Advanced } from "../Advanced";
import { createNyxPreset, deleteNyxPreset, PRESETS_KEY, PROFILE_KEY } from "./nyxApi";
import { useNyxProfile } from "./NyxProfileContext";
import { PREVIEW_QUESTION, previewAnswer } from "./preview";

const FIELD =
  "w-full min-w-0 rounded-lg border border-a-line bg-a-p2 px-3 py-2 font-body text-callout text-a-ink placeholder:text-a-mut focus:border-a-acc focus:outline-none";
const LABEL = "font-mono text-label uppercase tracking-wide text-a-mut";
const BTN = "min-h-11 rounded-lg border border-a-line px-3 py-1.5 text-caption text-a-ink transition-colors hover:bg-a-p2 disabled:opacity-50 md:min-h-0";
const BTN_PRIMARY = "min-h-11 rounded-lg border border-transparent bg-a-primary px-4 py-1.5 text-caption font-semibold text-a-on-primary hover:brightness-110 disabled:opacity-50 md:min-h-0";

const USER_FIELDS: { key: keyof NyxUserProfile; label: string; placeholder: string; long?: boolean }[] = [
  { key: "name", label: t("Name"), placeholder: t("Wie soll Nyx dich nennen?") },
  { key: "role", label: t("Rolle"), placeholder: t("Was machst du?") },
  { key: "projects", label: t("Projekte"), placeholder: t("Woran arbeitest du gerade?") },
  { key: "workStyle", label: t("Arbeitsweise"), placeholder: t("Wie arbeitest du am liebsten?"), long: true },
  { key: "likes", label: t("Vorlieben"), placeholder: t("Was magst du an Antworten?"), long: true },
  { key: "noGos", label: t("No-Gos"), placeholder: t("Was soll Nyx nie tun?"), long: true },
  { key: "notes", label: t("Sonst noch"), placeholder: t("Alles Weitere, das Nyx über dich wissen soll"), long: true },
];

/** Loading/error of the profile; shows the children only once it is there. */
function ProfileGate({ children }: { children: (current: NyxProfile) => ReactNode }) {
  const { profileQ, current } = useNyxProfile();
  if (profileQ.isLoading) return <Skeleton className="h-64 w-full" />;
  if (profileQ.isError)
    return (
      <div className="grid gap-2 rounded-xl border border-a-bad/40 bg-a-p p-4 text-callout text-a-ink">
        <p>{friendlyError(profileQ.error, t("Die Nyx-Einstellungen ließen sich gerade nicht laden."))}</p>
        <button type="button" className={cn(BTN, "w-fit")} onClick={() => void profileQ.refetch()}>
          {t("Erneut versuchen")}
        </button>
      </div>
    );
  return current ? <>{children(current)}</> : null;
}

/** Subpage „Persönlichkeit“: presets, sample sentence, sliders; character/tone/address/soul under „Erweitert“. */
export function NyxPersonalityPanel() {
  const { presetsQ, edit } = useNyxProfile();
  return (
    <ProfileGate>
      {(current) => (
        <div className="grid min-w-0 gap-5">
          <PresetBar
            presets={presetsQ.data?.presets ?? []}
            profile={current}
            onApply={(p) => edit((c) => ({ ...c, sliders: { ...p.sliders }, activePreset: p.id }))}
            onDeleted={(id) => {
              if (current.activePreset === id) edit((c) => ({ ...c, activePreset: null }));
            }}
          />
          <PreviewCard profile={current} />
          <SliderSection profile={current} onChange={(key, v) => edit((c) => ({ ...c, sliders: { ...c.sliders, [key]: v }, activePreset: null }))} />
          <Advanced id="nyx-charakter" hint={t("Charakter, Ton, Anrede, Seele")}>
            <PersonalitySection value={current.personality} onChange={(personality) => edit((c) => ({ ...c, personality }))} />
          </Advanced>
        </div>
      )}
    </ProfileGate>
  );
}

/** Subpage „Über dich“. */
export function NyxAboutPanel() {
  const { edit } = useNyxProfile();
  return <ProfileGate>{(current) => <UserSection value={current.user} onChange={(user) => edit((c) => ({ ...c, user }))} />}</ProfileGate>;
}

/** Overview: small preview „So spricht Nyx“ – a tap opens the personality. */
export function NyxPreviewSummary() {
  const { current, profileQ } = useNyxProfile();
  const text = useMemo(() => (current ? previewAnswer(current) : ""), [current]);
  if (profileQ.isLoading) return <Skeleton className="h-28 w-full" />;
  if (!current) return null;
  return (
    <Link
      to="/einstellungen/nyx/persoenlichkeit"
      state={{ fromOverview: true }}
      data-nyx="nyx-vorschau"
      className="grid min-w-0 gap-2 rounded-xl border border-a-nyx/35 bg-a-p p-4 transition-colors hover:border-a-nyx/60 focus-visible:outline-2 focus-visible:outline-a-acc md:p-5"
    >
      <span className={LABEL}>{t("So spricht Nyx")}</span>
      <span className="text-caption text-a-mut">
        {t("Du fragst:")} {quote(PREVIEW_QUESTION)}
      </span>
      <span data-testid="nyx-preview-summary" className="line-clamp-3 max-w-[70ch] text-headline leading-relaxed text-a-ink">
        {text}
      </span>
    </Link>
  );
}

/** Fixed bar at the bottom: state · Zurücksetzen · Speichern. */
export function NyxSaveBar() {
  const { profileQ, draft, dirty, save, edit } = useNyxProfile();
  if (!profileQ.data) return null;
  const defaults = profileQ.data.defaults;
  return (
    <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-3 border-t border-a-line bg-a-bg/90 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
      <span className="mr-auto text-caption" aria-live="polite">
        {save.isError && <span className="text-a-bad">{friendlyError(save.error, t("Nicht gespeichert – bitte noch einmal."))}</span>}
        {!save.isError && dirty && <span className="text-a-wait">{t("Noch nicht gespeichert")}</span>}
        {!save.isError && !dirty && save.isSuccess && <span className="text-a-ok">{t("Gespeichert")}</span>}
      </span>
      <button type="button" className={BTN} onClick={() => edit(() => defaults)} title={t("Alle Felder und Regler auf die Startwerte")}>
        {t("Zurücksetzen")}
      </button>
      <button type="button" className={BTN_PRIMARY} disabled={!dirty || save.isPending} onClick={() => draft && save.mutate(draft)}>
        {save.isPending ? t("Speichert …") : t("Speichern")}
      </button>
    </div>
  );
}

function Section({ title, hint, label, children }: { title: string; hint?: string; label?: string; children: ReactNode }) {
  return (
    <section aria-label={label ?? title} className="grid min-w-0 gap-4 rounded-xl border border-a-line bg-a-p p-4 md:p-5">
      <div className="grid gap-0.5">
        <h2 className="font-display text-headline text-a-ink">{title}</h2>
        {hint && <p className="text-caption text-a-mut">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

// ─── Vorlagen ───

function PresetBar({ presets, profile, onApply, onDeleted }: { presets: NyxPreset[]; profile: NyxProfile; onApply: (p: NyxPreset) => void; onDeleted: (id: string) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const inputId = useId();
  const activeId = profile.activePreset ?? matchingNyxPreset(profile.sliders, presets)?.id ?? null;

  const create = useMutation({
    mutationFn: createNyxPreset,
    onSuccess: ({ preset }) => {
      void qc.invalidateQueries({ queryKey: PRESETS_KEY });
      setOpen(false);
      setLabel("");
      onApply(preset);
    },
  });
  const remove = useMutation({
    mutationFn: deleteNyxPreset,
    onSuccess: (_r, id) => {
      void qc.invalidateQueries({ queryKey: PRESETS_KEY });
      void qc.invalidateQueries({ queryKey: PROFILE_KEY });
      onDeleted(id);
    },
  });

  return (
    <section aria-label={t("Vorlagen auswählen")} className="grid min-w-0 gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={LABEL}>{t("Vorlagen")}</h2>
        <button type="button" className={cn(BTN, "text-caption")} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {t("Als Vorlage speichern")}
        </button>
      </div>
      <div role="group" aria-label={t("Vorlagen")} className="flex min-w-0 flex-wrap gap-2">
        {presets.map((p) => {
          const active = p.id === activeId;
          return (
            <span key={p.id} className="inline-flex items-stretch">
              <button
                type="button"
                aria-pressed={active}
                title={p.description || undefined}
                onClick={() => onApply(p)}
                className={cn(
                  "rounded-full border px-3.5 py-1.5 text-caption transition-all duration-150",
                  !p.builtin && "rounded-r-none pr-2.5",
                  active ? "border-a-acc bg-a-acc/15 text-a-ink shadow-[0_0_0_3px_color-mix(in_srgb,var(--a-acc)_18%,transparent)]" : "border-a-line bg-a-p text-a-mut hover:border-[var(--a-line-strong)] hover:text-a-ink",
                )}
              >
                {p.label}
              </button>
              {!p.builtin && (
                <button
                  type="button"
                  aria-label={t("Vorlage „{label}“ löschen", { label: p.label })}
                  title={t("Vorlage löschen")}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(p.id)}
                  className={cn("rounded-r-full border border-l-0 px-2 text-caption text-a-mut hover:bg-a-bad/15 hover:text-a-bad", active ? "border-a-acc" : "border-a-line")}
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
      </div>
      {remove.isError && <p className="text-caption text-a-bad">{friendlyError(remove.error, t("Die Vorlage ließ sich nicht löschen – bitte noch einmal."))}</p>}
      {open && (
        <form
          className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-a-line bg-a-p p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (label.trim()) create.mutate({ label: label.trim(), sliders: profile.sliders });
          }}
        >
          <label htmlFor={inputId} className="text-caption text-a-mut">
            {t("Name der Vorlage")}
          </label>
          <input id={inputId} className={cn(FIELD, "w-56 flex-none")} maxLength={NYX_PRESET_LABEL_MAX} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("z. B. Abends am Handy")} autoFocus />
          <button type="submit" className={BTN_PRIMARY} disabled={!label.trim() || create.isPending}>
            {t("Vorlage anlegen")}
          </button>
          <span className="text-caption text-a-mut">{t("speichert die aktuelle Stellung der Regler")}</span>
          {create.isError && <span className="basis-full text-caption text-a-bad">{friendlyError(create.error, t("Die Vorlage ließ sich nicht speichern – bitte noch einmal."))}</span>}
        </form>
      )}
    </section>
  );
}

// ─── Beispielsatz ───

function PreviewCard({ profile }: { profile: NyxProfile }) {
  const text = useMemo(() => previewAnswer(profile), [profile]);
  return (
    <section aria-label={t("Beispiel")} className="relative grid min-w-0 gap-3 overflow-hidden rounded-xl border border-a-acc/40 bg-a-p p-4 md:p-5">
      <p className="text-caption text-a-mut">
        {t("Du fragst:")} <span className="text-a-ink">{quote(PREVIEW_QUESTION)}</span>
      </p>
      <div className="grid gap-1">
        <p className={LABEL}>{t("So würde Nyx jetzt antworten:")}</p>
        <p key={text} data-testid="nyx-preview" className="nyx-preview-text max-w-[70ch] text-headline leading-relaxed text-a-ink">
          {text}
        </p>
      </div>
    </section>
  );
}

// ─── Regler ───

function SliderSection({ profile, onChange }: { profile: NyxProfile; onChange: (key: NyxSliderKey, value: number) => void }) {
  return (
    <Section title={t("Verhalten")} hint={t("Unter jedem Regler steht, was Nyx genau gesagt bekommt.")}>
      <div className="grid gap-5">
        {NYX_SLIDERS.map((s) => {
          const value = profile.sliders[s.key];
          const stage = NYX_SLIDER_STAGES[s.key][nyxLevel(value)];
          return (
            <div key={s.key} className="grid gap-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-callout font-medium text-a-ink">{s.label}</span>
              </div>
              {/* On the phone both poles stand above the slider (otherwise there is hardly room for it). */}
              <div className="grid grid-cols-2 items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_minmax(0,7.5rem)]">
                <span className={cn("truncate text-caption", value < 50 ? "text-a-ink" : "text-a-mut")}>{s.left}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={value}
                  aria-label={s.label}
                  aria-valuetext={`${s.left} ↔ ${s.right}: ${stage}`}
                  onChange={(e) => onChange(s.key, Number(e.target.value))}
                  className="nyx-range order-3 col-span-2 sm:order-none sm:col-span-1"
                  style={{ "--c": `var(--${s.color})`, "--p": `${value}%` } as CSSProperties}
                />
                <span className={cn("truncate text-right text-caption sm:order-none", value >= 50 ? "text-a-ink" : "text-a-mut")}>{s.right}</span>
              </div>
              <p className="text-caption text-a-mut">{stage}</p>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ─── Persönlichkeit ───

function PersonalitySection({ value, onChange }: { value: NyxPersonality; onChange: (v: NyxPersonality) => void }) {
  const id = useId();
  const set = <K extends keyof NyxPersonality>(k: K, v: NyxPersonality[K]) => onChange({ ...value, [k]: v });
  return (
    <Section title={t("Persönlichkeit")} hint={t("Wer Nyx ist – wie eine kurze Selbstbeschreibung.")}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field id={`${id}-character`} label={t("Charakter")}>
          <input id={`${id}-character`} className={FIELD} maxLength={NYX_FIELD_MAX} value={value.character} onChange={(e) => set("character", e.target.value)} placeholder={t("z. B. ruhig, direkt, ehrlich")} />
        </Field>
        <Field id={`${id}-tone`} label={t("Ton")}>
          <input id={`${id}-tone`} className={FIELD} maxLength={NYX_FIELD_MAX} value={value.tone} onChange={(e) => set("tone", e.target.value)} placeholder={t("z. B. freundlich und klar")} />
        </Field>
      </div>
      {/* du/Sie only exists in German – an English interface doesn't ask. */}
      {getLang() === "de" && (
        <div className="grid gap-1.5">
          <span id={`${id}-address`} className={LABEL}>
            {t("Anrede")}
          </span>
          <div role="radiogroup" aria-labelledby={`${id}-address`} className="flex gap-2">
            {(["du", "Sie"] as const).map((a) => (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={value.address === a}
                onClick={() => set("address", a)}
                className={cn("rounded-lg border px-4 py-1.5 text-callout", value.address === a ? "border-a-violet bg-a-violet/15 text-a-ink" : "border-a-line text-a-mut hover:text-a-ink")}
              >
                {a === "du" ? t("du") : t("Sie")}
              </button>
            ))}
          </div>
        </div>
      )}
      <Field id={`${id}-soul`} label={t("Seele")} hint={t("Grundhaltung, Werte, Grenzen – in eigenen Worten.")}>
        <textarea id={`${id}-soul`} className={cn(FIELD, "min-h-[96px] resize-y leading-relaxed")} maxLength={NYX_TEXT_MAX} value={value.soul} onChange={(e) => set("soul", e.target.value)} />
      </Field>
    </Section>
  );
}

// ─── Nutzerprofil ───

function UserSection({ value, onChange }: { value: NyxUserProfile; onChange: (v: NyxUserProfile) => void }) {
  const id = useId();
  return (
    <Section title={t("Über dich")} hint={t("Was Nyx über dich wissen soll. Leere Felder lässt Nyx einfach weg.")}>
      <div className="grid gap-4 md:grid-cols-2">
        {USER_FIELDS.map((f) => {
          const fid = `${id}-${f.key}`;
          const max = f.key === "notes" ? NYX_TEXT_MAX : NYX_FIELD_MAX;
          return (
            <div key={f.key} className={cn(f.long && "md:col-span-2")}>
              <Field id={fid} label={f.label}>
                {f.long ? (
                  <textarea id={fid} className={cn(FIELD, "min-h-[72px] resize-y leading-relaxed")} maxLength={max} value={value[f.key]} placeholder={f.placeholder} onChange={(e) => onChange({ ...value, [f.key]: e.target.value })} />
                ) : (
                  <input id={fid} className={FIELD} maxLength={max} value={value[f.key]} placeholder={f.placeholder} onChange={(e) => onChange({ ...value, [f.key]: e.target.value })} />
                )}
              </Field>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      {children}
      {hint && <p className="text-caption text-a-mut">{hint}</p>}
    </div>
  );
}
