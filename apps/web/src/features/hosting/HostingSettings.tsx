// Settings → „Betrieb & Zugriff“. Top to bottom: how NyxOS runs right now (honest, from the server) · where NyxOS should
// run (three ways, each with short facts + form → ready commands + check) · reaching it from the phone (Tailscale,
// Cloudflare Tunnel, own domain) · related settings · „Nyx hilft“.
// Without PageShell/page title: the settings register mounts it as a section of the area „Betrieb & Zugriff“.
// All commands and way texts live in ./recipes.ts.
import {
  CloudflareFormSchema,
  DEFAULT_HOSTING_FORMS,
  DomainFormSchema,
  HOSTING_PROVIDERS,
  LocalFormSchema,
  PhoneWaySchema,
  ProviderFormSchema,
  ServerFormSchema,
  TailscaleFormSchema,
  checkUrlOf,
  phoneUrlOf,
  type HostingCheckResult,
  type HostingCheckTarget,
  type HostingForms,
  type HostingProfileInput,
  type HostingProfileView,
  type HostingProvider,
  type HostingSecretId,
  type HostingStatus,
  type HostingWay,
  type PhoneWay,
  t,
} from "@nyxos/shared";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Card, SectionTitle } from "../../components/ui/Card";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { askNyx } from "../haiku/askNyx";
import { FIELD, LABEL } from "../settings/fieldStyles";
import { checkText, nyxHelpPrompt, statusLines, when, type Tone } from "./describe";
import { HostingApiError, useHostingCheck, useHostingProfile, useHostingSecret, useHostingStatus, useSaveHostingProfile } from "./hostingApi";
import { edition, providerLabel, whereLabel, type Recipe, type RecipeContext, type WayInfo } from "./recipes";

const TONE_DOT: Record<Tone, string> = { ok: "bg-a-ok", wait: "bg-a-wait", bad: "bg-a-bad", mut: "bg-a-mut" };
const VERDICT_PILL: Record<HostingCheckResult["verdict"], string> = {
  ok: "border-a-ok/40 bg-a-ok/10 text-a-ok",
  warn: "border-a-wait/40 bg-a-wait/10 text-a-wait",
  fail: "border-a-bad/40 bg-a-bad/10 text-a-bad",
};
const verdictWord = (v: HostingCheckResult["verdict"]): string => (v === "ok" ? t("erreichbar") : v === "warn" ? t("Achtung") : t("nicht erreichbar"));
const TAP = "min-h-11";

// ── Form check (the same rules as the server, packages/shared/src/hosting.ts) ─────────────────────────────────────

const SCHEMAS = { local: LocalFormSchema, server: ServerFormSchema, provider: ProviderFormSchema, tailscale: TailscaleFormSchema, cloudflare: CloudflareFormSchema, domain: DomainFormSchema } as const;
type FormKey = keyof HostingForms;

function fieldErrors<K extends FormKey>(key: K, form: HostingForms[K]): Record<string, string> {
  const r = SCHEMAS[key].safeParse(form);
  if (r.success) return {};
  const out: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const f = String(issue.path[0] ?? "");
    // Our own messages are German source texts (translated here); zod's built-in ones (numbers) get a fixed sentence.
    if (f && !out[f]) out[f] = issue.message.startsWith("Invalid") || issue.message.startsWith("Too") ? t("Bitte eine Zahl zwischen 1 und 65535.") : t(issue.message);
  }
  return out;
}

/** For the commands: invalid fields count as empty (then „fill in first“ shows instead of a broken command). */
function usableForms(forms: HostingForms): HostingForms {
  const out = structuredClone(forms);
  for (const key of Object.keys(SCHEMAS) as FormKey[]) {
    const errs = fieldErrors(key, forms[key]);
    const f = out[key] as Record<string, unknown>;
    for (const field of Object.keys(errs)) f[field] = typeof f[field] === "number" ? (DEFAULT_HOSTING_FORMS[key] as Record<string, unknown>)[field] : "";
  }
  return out;
}

// ── Small building blocks ───────────────────────────────────────────────────────────────────────────────────────

function CopyBlock({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
    setTimeout(() => setCopied(null), 2200);
  };
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-2 rounded-lg border border-a-line bg-a-bg p-2 sm:grid-cols-[minmax(0,1fr)_auto]">
      <pre className="min-w-0 whitespace-pre-wrap py-1.5 pl-1 font-mono text-caption text-a-ink [overflow-wrap:anywhere]" data-testid="hosting-command">
        {command}
      </pre>
      <Button className={cn(TAP, "min-w-11 justify-self-end")} onClick={() => void copy()} aria-label={t("Befehl kopieren: {label}", { label })}>
        {copied === "ok" ? t("Kopiert") : copied === "fail" ? t("Markieren") : t("Kopieren")}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied === "ok" ? t("Befehl kopiert") : copied === "fail" ? t("Kopieren nicht erlaubt – bitte den Text markieren") : ""}
      </span>
    </div>
  );
}

function Field({ label, error, hint, children, htmlFor }: { label: string; error?: string; hint?: string; children: ReactNode; htmlFor: string }) {
  return (
    <div className="grid min-w-0 gap-1">
      <label htmlFor={htmlFor} className={LABEL}>
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-err`} className="text-caption text-a-bad">
          {error}
        </p>
      ) : hint ? (
        <p className="text-caption text-a-mut">{hint}</p>
      ) : null}
    </div>
  );
}

function TextField(props: { id: string; label: string; value: string; onChange: (v: string) => void; placeholder?: string; error?: string; hint?: string; inputMode?: "text" | "email" | "url" }) {
  return (
    <Field label={props.label} error={props.error} hint={props.hint} htmlFor={props.id}>
      <input
        id={props.id}
        className={cn(FIELD, TAP, props.error && "border-a-bad")}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        inputMode={props.inputMode ?? "text"}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={props.error ? `${props.id}-err` : undefined}
      />
    </Field>
  );
}

function PortField(props: { id: string; label: string; value: number; onChange: (v: number) => void; error?: string; hint?: string }) {
  return (
    <Field label={props.label} error={props.error} hint={props.hint} htmlFor={props.id}>
      <input
        id={props.id}
        className={cn(FIELD, TAP, "max-w-40", props.error && "border-a-bad")}
        type="number"
        inputMode="numeric"
        min={1}
        max={65535}
        value={Number.isFinite(props.value) ? props.value : ""}
        onChange={(e) => props.onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={props.error ? `${props.id}-err` : undefined}
      />
    </Field>
  );
}

/** „Kostenlos · Nur solange der Rechner an ist …“ – cost and permanent operation in one line (without full stops). */
export function infoSummary(info: WayInfo): string {
  const trim = (text: string) => text.replace(/\.$/, "");
  return `${trim(info.cost)} · ${trim(info.permanent)}`;
}

/**
 * The four info lines stand collapsed – only a one-line summary (cost · permanent?) shows. Opening shows everything;
 * on the card you are setting up right now they stand open.
 */
function InfoLines({ info, open }: { info: WayInfo; open: boolean }) {
  const rows: Array<[string, string]> = [
    [t("Was brauchst du"), info.needs],
    [t("Läuft dauerhaft?"), info.permanent],
    [t("Kosten"), info.cost],
    [t("Sicherheit"), info.security],
  ];
  return (
    <details key={open ? "open" : "closed"} open={open || undefined} className="group min-w-0" data-testid="hosting-info">
      <summary className="-mx-2 flex min-h-11 min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-caption text-a-mut hover:bg-a-p2 focus-visible:outline-2 focus-visible:outline-a-acc [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="shrink-0 transition-transform duration-150 group-open:rotate-90">
          ›
        </span>
        <span className="min-w-0 flex-1 truncate">{infoSummary(info)}</span>
        <span className="shrink-0 group-open:hidden">{t("Details")}</span>
      </summary>
      <dl className="grid gap-1.5 pt-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="grid gap-0.5 sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:gap-3">
            <dt className="text-caption text-a-mut">{k}</dt>
            <dd className="text-callout text-a-ink">{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function Pill({ tone, children }: { tone: "ok" | "acc" | "nyx" | "wait"; children: ReactNode }) {
  const cls = { ok: "border-a-ok/40 bg-a-ok/10 text-a-ok", acc: "border-a-acc/40 bg-a-acc/10 text-a-acc", nyx: "border-a-nyx/40 bg-a-nyx/10 text-a-nyx", wait: "border-a-wait/40 bg-a-wait/10 text-a-wait" }[tone];
  return <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-label font-medium", cls)}>{children}</span>;
}

function RecipeView({ recipe }: { recipe: Recipe }) {
  return (
    <div className="grid min-w-0 gap-3">
      {recipe.warning && (
        <p role="note" className="rounded-lg border border-a-wait/35 bg-a-wait/8 px-3 py-2 text-callout text-a-ink">
          {recipe.warning}
        </p>
      )}
      {recipe.missing.length > 0 && (
        <p className="text-callout text-a-mut" data-testid="hosting-missing">
          {t("Fülle zuerst aus: {fields} – dann erscheinen hier die fertigen Befehle.", { fields: recipe.missing.join(", ") })}
        </p>
      )}
      {recipe.steps.length > 0 && (
        <ol className="grid min-w-0 gap-3" aria-label={t("Schritte")}>
          {recipe.steps.map((s, i) => (
            <li key={`${i}-${s.title}`} className="grid min-w-0 grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2 gap-y-1.5">
              <span className="mt-0.5 grid h-6 w-6 place-items-center rounded-full bg-a-p3 font-mono text-label text-a-ink" aria-hidden>
                {i + 1}
              </span>
              <div className="grid min-w-0 gap-1.5">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="font-mono text-label uppercase tracking-wide text-a-mut">{whereLabel(s.where)}</span>
                  <span className="text-callout font-medium text-a-ink">{s.title}</span>
                </div>
                {s.command && <CopyBlock command={s.command} label={s.title} />}
                {s.note && <p className="text-caption text-a-mut">{s.note}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function CheckResultView({ result, serverNow }: { result: HostingCheckResult; serverNow?: string }) {
  return (
    <div role="status" aria-live="polite" className="grid min-w-0 gap-1 rounded-lg border border-a-line bg-a-p2 px-3 py-2" data-testid="hosting-check-result" data-verdict={result.verdict}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-label font-medium", VERDICT_PILL[result.verdict])}>{verdictWord(result.verdict)}</span>
        <span className="text-caption text-a-mut">
          {t("geprüft {when}", { when: when(result.at, serverNow ?? Date.now()) })}
          {result.ms ? ` · ${result.ms} ms` : ""}
          {result.status ? ` · ${t("Antwort {status}", { status: result.status })}` : ""}
        </span>
      </div>
      <p className="text-callout text-a-ink">{checkText(result)}</p>
    </div>
  );
}

// ── Card with form ──────────────────────────────────────────────────────────────────────────────────────────────

interface OptionCardProps {
  kind: "way" | "phone";
  id: HostingWay | PhoneWay;
  info: WayInfo;
  open: boolean;
  onToggle: () => void;
  badges: ReactNode;
  children: ReactNode;
}

function OptionCard({ kind, id, info, open, onToggle, badges, children }: OptionCardProps) {
  const bodyId = useId();
  return (
    <Card className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 p-0" data-hosting-card={id} data-kind={kind} data-open={open ? "1" : "0"}>
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={bodyId} className={cn("grid w-full min-w-0 gap-1 rounded-xl px-4 pt-4 text-left", TAP, "focus-visible:outline-2 focus-visible:outline-a-acc")}>
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-headline font-semibold text-a-ink">{info.title}</span>
          {badges}
          <span className="ml-auto text-caption text-a-mut" aria-hidden>
            {open ? t("Zuklappen ▴") : t("Einrichten ▾")}
          </span>
        </span>
        <span className="text-callout text-a-mut">{info.short}</span>
      </button>
      <div className="min-w-0 px-4 pb-2">
        <InfoLines info={info} open={open} />
      </div>
      {open && (
        <div id={bodyId} className="grid min-w-0 gap-4 border-t border-a-line px-4 py-4">
          {children}
        </div>
      )}
    </Card>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────────────────────────────────────────

const toInput = (v: HostingProfileView): HostingProfileInput => ({way: v.way, phoneWay: v.phoneWay, forms: v.forms });

/** Which way describes how NyxOS runs today? (Own vs. rented server only the user knows – then their choice counts.) */
function runningWay(status: HostingStatus, view: HostingProfileView | null): HostingWay {
  if (status.mode !== "server") return "local";
  return view?.way === "provider" ? "provider" : "server";
}

export function HostingSettings() {
  const ed = edition();
  const statusQ = useHostingStatus();
  const profileQ = useHostingProfile();
  const save = useSaveHostingProfile();
  const check = useHostingCheck();
  const [draft, setDraft] = useState<HostingProfileInput | null>(null);
  const [open, setOpen] = useState<HostingWay | PhoneWay | null>(null);
  const [savedAt, setSavedAt] = useState<{ key: string; at: number } | null>(null);
  const [lastCheck, setLastCheck] = useState<Partial<Record<HostingCheckTarget, HostingCheckResult>>>({});
  const [checkError, setCheckError] = useState<{ target: HostingCheckTarget; text: string } | null>(null);
  const status = statusQ.data ?? null;
  const view = profileQ.data ?? null;

  useEffect(() => {
    if (view && !draft) setDraft(toInput(view));
  }, [view, draft]);

  const forms = draft?.forms;
  const usable = useMemo(() => (forms ? usableForms(forms) : null), [forms]);
  const ctx: RecipeContext = { mode: status?.mode ?? "server", allowedHosts: status?.allowedHosts ?? [], way: draft?.way ?? null, port: status?.port };

  const setForm = <K extends FormKey>(key: K, patch: Partial<HostingForms[K]>) =>
    setDraft((d) => (d ? { ...d, forms: { ...d.forms, [key]: { ...d.forms[key], ...patch } } } : d));

  const doSave = async (key: HostingWay | PhoneWay) => {
    if (!draft) return;
    const isPhone = PhoneWaySchema.safeParse(key).success;
    const next: HostingProfileInput = isPhone ? { ...draft, phoneWay: key as PhoneWay } : { ...draft, way: key as HostingWay };
    try {
      const v = await save.mutateAsync(next);
      setDraft(toInput(v));
      setSavedAt({ key, at: Date.now() });
      setTimeout(() => setSavedAt((s) => (s?.key === key ? null : s)), 3000);
    } catch {
      // the error shows below the button (save.error)
    }
  };

  const doCheck = async (target: HostingCheckTarget) => {
    if (!usable) return;
    setCheckError(null);
    const url = target === "local" ? undefined : (checkUrlOf(target, usable) ?? undefined);
    try {
      const r = await check.mutateAsync({ target, ...(url ? { url } : {}) });
      setLastCheck((c) => ({ ...c, [target]: r }));
    } catch (e) {
      setCheckError({ target, text: e instanceof HostingApiError ? e.message : t("Die Prüfung ließ sich gerade nicht starten.") });
    }
  };

  const secretsSet = (view?.secrets ?? []).filter((s) => s.set).map((s) => (s.id === "cloudflare-tunnel-token" ? t("Cloudflare-Tunnel-Token") : t("Tailscale-Schlüssel")));
  const helpNyx = (focus?: HostingWay | PhoneWay) => {
    if (!draft) return;
    askNyx(nyxHelpPrompt({ profile: draft, status, secretsSet, focus }));
  };

  const resultFor = (target: HostingCheckTarget): HostingCheckResult | null => {
    const r = lastCheck[target] ?? view?.checks[target] ?? null;
    if (!r || !usable) return r;
    // A check of another (old) address does not count for today's form.
    const url = checkUrlOf(target, usable);
    return target === "local" || !url || r.url === new URL(url).origin ? r : null;
  };

  const actions = (key: HostingWay | PhoneWay, target: HostingCheckTarget, checkable: { ok: true } | { ok: false; why: string }) => {
    const errs = forms ? fieldErrors(key, forms[key]) : {};
    const invalid = Object.keys(errs).length > 0;
    const busy = check.isPending && check.variables?.target === target;
    const r = resultFor(target);
    return (
      <div className="grid min-w-0 gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" className={TAP} onClick={() => void doSave(key)} disabled={!draft || save.isPending || invalid}>
            {save.isPending && save.variables && (save.variables.way === key || save.variables.phoneWay === key) ? t("Speichert …") : t("Speichern")}
          </Button>
          <Button className={TAP} onClick={() => void doCheck(target)} disabled={!checkable.ok || busy} aria-describedby={!checkable.ok ? `why-${key}` : undefined}>
            {busy ? t("Prüft …") : t("Prüfen")}
          </Button>
          <Button variant="ghost" className={cn(TAP, "text-a-nyx")} onClick={() => helpNyx(key)}>
            {t("Nyx hilft")}
          </Button>
          <span aria-live="polite" className="text-caption text-a-ok">
            {savedAt?.key === key ? t("Gespeichert") : ""}
          </span>
        </div>
        {!checkable.ok && (
          <p id={`why-${key}`} className="text-caption text-a-mut">
            {checkable.why}
          </p>
        )}
        {save.isError && save.variables && (save.variables.way === key || save.variables.phoneWay === key) && (
          <p role="alert" className="text-caption text-a-bad">
            {t("Speichern ging nicht: {error}", { error: save.error instanceof Error ? save.error.message : t("unbekannter Fehler") })}
          </p>
        )}
        {checkError?.target === target && (
          <p role="alert" className="text-caption text-a-bad">
            {checkError.text}
          </p>
        )}
        {r && <CheckResultView result={r} serverNow={status?.serverNow} />}
      </div>
    );
  };

  const wayBadges = (w: HostingWay) => (
    <>
      {status && runningWay(status, view) === w && <Pill tone="ok">{t("So läuft es gerade")}</Pill>}
      {view?.way === w && <Pill tone="acc">{t("Gewählt")}</Pill>}
    </>
  );
  const phoneBadges = (p: PhoneWay, info: WayInfo) => (
    <>
      {info.badge && <Pill tone="nyx">{info.badge}</Pill>}
      {view?.phoneWay === p && <Pill tone="acc">{t("Gewählt")}</Pill>}
      {status?.phone.way === p && status.phone.state === "reachable" && <Pill tone="ok">{t("erreichbar")}</Pill>}
    </>
  );

  const loading = profileQ.isLoading || (profileQ.isSuccess && !draft);

  return (
    <div className="grid min-w-0 gap-6" data-testid="hosting-settings">
      {/* 1 · how NyxOS runs right now */}
      <section className="grid min-w-0 gap-2" aria-labelledby="hosting-now">
        <div className="flex items-center justify-between gap-2">
          <h2 id="hosting-now" className="text-headline font-semibold text-a-ink">
            {t("So läuft NyxOS gerade")}
          </h2>
          <Button variant="ghost" className={TAP} onClick={() => void statusQ.refetch()} disabled={statusQ.isFetching}>
            {statusQ.isFetching ? t("Lädt …") : t("Neu laden")}
          </Button>
        </div>
        <Card className="grid min-w-0 gap-2" data-testid="hosting-status">
          {statusQ.isLoading && <Skeleton className="h-28 w-full" />}
          {statusQ.isError && (
            <div className="grid gap-2">
              <p className="text-callout text-a-bad">
                {statusQ.error instanceof HostingApiError ? t("Der Stand ist gerade nicht abrufbar ({error}).", { error: statusQ.error.message }) : t("Der Stand ist gerade nicht abrufbar.")}
              </p>
              <Button className={cn(TAP, "w-fit")} onClick={() => void statusQ.refetch()}>
                {t("Erneut versuchen")}
              </Button>
            </div>
          )}
          {status && (
            <ul className="grid gap-2">
              {statusLines(status).map((l) => (
                <li key={l.id} className="grid grid-cols-[0.75rem_minmax(0,1fr)] items-baseline gap-2" data-line={l.id} data-tone={l.tone}>
                  <span className={cn("inline-block h-2 w-2 translate-y-[-1px] rounded-full", TONE_DOT[l.tone])} aria-hidden />
                  <span className="text-callout text-a-ink">{l.text}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      {/* 2 · where should NyxOS run? */}
      <section className="grid min-w-0 gap-3" aria-labelledby="hosting-where">
        <div className="grid gap-1">
          <h2 id="hosting-where" className="text-headline font-semibold text-a-ink">
            {t("Wo soll NyxOS laufen?")}
          </h2>
          <p className="text-callout text-a-mut">{t("Wähle einen Weg, trag ein, was du hast – daraus entstehen fertige Befehle zum Kopieren.")}</p>
        </div>
        {loading && <Skeleton className="h-40 w-full" />}
        {profileQ.isError && <p className="text-callout text-a-bad">{t("Die gespeicherten Angaben ließen sich nicht laden.")}</p>}
        {draft && usable && (
          <div className="grid min-w-0 gap-3">
            {(["local", "server", "provider"] as const).map((w) => (
              <OptionCard key={w} kind="way" id={w} info={ed.ways[w]} open={open === w} onToggle={() => setOpen(open === w ? null : w)} badges={wayBadges(w)}>
                <WayForm way={w} forms={draft.forms} setForm={setForm} />
                {actions(
                  w,
                  w,
                  w === "local"
                    ? { ok: true }
                    : checkUrlOf(w, usable)
                      ? { ok: true }
                      : { ok: false, why: w === "server" ? t("Ohne Domain ist der Server absichtlich nicht offen im Netz – geprüft wird mit dem Befehl „Prüfen“ unten (über SSH) oder über „Vom Handy erreichen“.") : t("Der Server ist absichtlich nicht offen im Netz – geprüft wird mit dem Befehl „Prüfen“ unten (über SSH) oder über „Vom Handy erreichen“.") },
                )}
                <RecipeView recipe={ed.wayRecipe(w, usable, { ...ctx, way: w })} />
              </OptionCard>
            ))}
          </div>
        )}
      </section>

      {/* 3 · reach it from the phone */}
      <section className="grid min-w-0 gap-3" aria-labelledby="hosting-phone">
        <div className="grid gap-1">
          <h2 id="hosting-phone" className="text-headline font-semibold text-a-ink">
            {t("Vom Handy erreichen")}
          </h2>
          <p className="text-callout text-a-mut">{t("Damit du deine Sessions auch unterwegs steuern kannst. Am sichersten: Tailscale – dann ist nichts öffentlich im Internet.")}</p>
        </div>
        {draft && usable && (
          <div className="grid min-w-0 gap-3">
            {(["tailscale", "cloudflare", "domain"] as const).map((p) => {
              const url = phoneUrlOf({ phoneWay: p, forms: usable });
              const r = resultFor(p);
              return (
                <OptionCard key={p} kind="phone" id={p} info={ed.phone[p]} open={open === p} onToggle={() => setOpen(open === p ? null : p)} badges={phoneBadges(p, ed.phone[p])}>
                  <PhoneForm way={p} forms={draft.forms} setForm={setForm} />
                  {p === "cloudflare" && view && <SecretField id="cloudflare-tunnel-token" label={t("Tunnel-Token (optional, wird verschlüsselt gespeichert)")} view={view} />}
                  {actions(p, p, url ? { ok: true } : { ok: false, why: t("Erst die Adresse eintragen.") })}
                  <RecipeView recipe={ed.phoneRecipe(p, usable, ctx)} />
                  {url && <PhoneOpen url={url} verified={r?.verdict === "ok" ? r : null} />}
                </OptionCard>
              );
            })}
          </div>
        )}
      </section>

      {/* 4 · related settings */}
      <section className="grid min-w-0 gap-2" aria-labelledby="hosting-related">
        <SectionTitle>
          <span id="hosting-related">{t("Verwandte Einstellungen")}</span>
        </SectionTitle>
        <Card className="grid gap-0 p-1">
          {[
            { to: "/settings/verbindungen", title: t("Verbindungen prüfen"), sub: t("Jede Verbindung von NyxOS, echt geprüft"), child: true },
            { to: "/settings/mitteilungen#erweitert-iphone", title: t("Mitteilungen aufs Handy"), sub: t("Push über ntfy – eigener Dienst oder ntfy.sh") },
            { to: "/settings/telegram", title: "Telegram", sub: t("Mit Nyx schreiben, Freigaben unterwegs beantworten") },
            { to: "/settings/zugaenge", title: t("Zugänge & Schlüssel"), sub: t("Tokens und Schlüssel an einer Stelle") },
          ].map((l) => (
            <Link key={l.to} to={l.to} state={"child" in l ? { fromParent: true } : undefined} data-nyx={"child" in l ? `settings-sub:${l.to.replace(/^\/settings\//, "")}` : undefined} className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-2 hover:bg-a-p2 focus-visible:outline-2 focus-visible:outline-a-acc", TAP)}>
              <span className="grid min-w-0">
                <span className="text-callout text-a-ink">{l.title}</span>
                <span className="text-caption text-a-mut">{l.sub}</span>
              </span>
              <span className="text-a-mut" aria-hidden>
                ›
              </span>
            </Link>
          ))}
        </Card>
      </section>

      {/* 5 · Nyx helps */}
      <section className="grid min-w-0 gap-2" aria-labelledby="hosting-nyx">
        <Card className="grid min-w-0 gap-2">
          <h2 id="hosting-nyx" className="text-headline font-semibold text-a-ink">
            {t("Nyx hilft")}
          </h2>
          <p className="text-callout text-a-mut">{t("Nyx bekommt deinen gewählten Weg, die Formularwerte (ohne Geheimnisse) und den aktuellen Stand und erklärt dir den nächsten Schritt.")}</p>
          <Button variant="primary" className={cn(TAP, "w-fit")} onClick={() => helpNyx()} disabled={!draft}>
            {t("Nyx fragen")}
          </Button>
        </Card>
      </section>
    </div>
  );
}

// ── Forms ───────────────────────────────────────────────────────────────────────────────────────────────────────

type SetForm = <K extends FormKey>(key: K, patch: Partial<HostingForms[K]>) => void;

function WayForm({ way, forms, setForm }: { way: HostingWay; forms: HostingForms; setForm: SetForm }) {
  const idp = useId();
  if (way === "local") {
    return (
      <label className={cn("flex items-center gap-3 text-callout text-a-ink", TAP)}>
        <input type="checkbox" className="h-5 w-5 accent-[var(--a-acc)]" checked={forms.local.autostart} onChange={(e) => setForm("local", { autostart: e.target.checked })} />
        {t("Autostart: startet mit dem Rechner")}
      </label>
    );
  }
  if (way === "server") {
    const f = forms.server;
    const e = fieldErrors("server", f);
    return (
      <div className="grid min-w-0 gap-3">
        <TextField id={`${idp}-addr`} label={t("Adresse (IP oder Name)")} value={f.address} onChange={(v) => setForm("server", { address: v })} placeholder={t("z. B. {example}", { example: "203.0.113.10" })} error={e.address} />
        <TextField id={`${idp}-user`} label={t("SSH-Nutzer")} value={f.sshUser} onChange={(v) => setForm("server", { sshUser: v })} placeholder={t("z. B. {example}", { example: "ubuntu" })} error={e.sshUser} />
        <PortField id={`${idp}-port`} label={t("SSH-Port")} value={f.sshPort} onChange={(v) => setForm("server", { sshPort: v })} error={e.sshPort} />
        <TextField id={`${idp}-alias`} label={t("SSH-Name (Kurzname für ssh)")} value={f.sshAlias} onChange={(v) => setForm("server", { sshAlias: v })} placeholder="nyxos-server" error={e.sshAlias} />
        <TextField id={`${idp}-dom`} label={t("Domain (optional)")} value={f.domain} onChange={(v) => setForm("server", { domain: v })} placeholder={t("z. B. {example}", { example: "nyxos.example.com" })} error={e.domain} hint={t("Nur nötig, wenn du NyxOS über eine eigene Domain öffnen willst.")} />
      </div>
    );
  }
  const f = forms.provider;
  const e = fieldErrors("provider", f);
  return (
    <div className="grid min-w-0 gap-3">
      <Field label={t("Anbieter")} htmlFor={`${idp}-prov`}>
        <select id={`${idp}-prov`} className={cn(FIELD, TAP)} value={f.provider} onChange={(ev) => setForm("provider", { provider: ev.target.value as HostingProvider, ...(ev.target.value === "aws-lightsail" && f.sshUser === "root" ? { sshUser: "ubuntu" } : {}) })}>
          {HOSTING_PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {providerLabel(p.id)}
            </option>
          ))}
        </select>
      </Field>
      <TextField id={`${idp}-addr`} label={t("Adresse (IP des neuen Servers)")} value={f.address} onChange={(v) => setForm("provider", { address: v })} placeholder={t("z. B. {example}", { example: "203.0.113.10" })} error={e.address} />
      <TextField id={`${idp}-user`} label={t("SSH-Nutzer")} value={f.sshUser} onChange={(v) => setForm("provider", { sshUser: v })} placeholder="root" error={e.sshUser} />
      <PortField id={`${idp}-port`} label={t("SSH-Port")} value={f.sshPort} onChange={(v) => setForm("provider", { sshPort: v })} error={e.sshPort} />
      <TextField id={`${idp}-alias`} label={t("SSH-Name (Kurzname für ssh)")} value={f.sshAlias} onChange={(v) => setForm("provider", { sshAlias: v })} placeholder="nyxos-server" error={e.sshAlias} />
      <TextField id={`${idp}-key`} label={t("Zugang: SSH-Schlüssel (Pfad)")} value={f.keyFile} onChange={(v) => setForm("provider", { keyFile: v })} placeholder="~/.ssh/id_ed25519" error={e.keyFile} hint={t("Nur der Pfad – der Schlüssel selbst verlässt deinen Rechner nie.")} />
    </div>
  );
}

function PhoneForm({ way, forms, setForm }: { way: PhoneWay; forms: HostingForms; setForm: SetForm }) {
  const idp = useId();
  if (way === "tailscale") {
    const f = forms.tailscale;
    const e = fieldErrors("tailscale", f);
    return (
      <div className="grid min-w-0 gap-3">
        <TextField id={`${idp}-name`} label={t("Tailscale-Name")} value={f.name} onChange={(v) => setForm("tailscale", { name: v })} placeholder={t("z. B. {example}", { example: "nyxos.tail1234.ts.net" })} error={e.name} />
        <PortField id={`${idp}-port`} label={t("HTTPS-Port")} value={f.httpsPort} onChange={(v) => setForm("tailscale", { httpsPort: v })} error={e.httpsPort} hint={t("Meist 443.")} />
      </div>
    );
  }
  if (way === "cloudflare") {
    const f = forms.cloudflare;
    const e = fieldErrors("cloudflare", f);
    return <TextField id={`${idp}-host`} label={t("Adresse (Hostname bei Cloudflare)")} value={f.hostname} onChange={(v) => setForm("cloudflare", { hostname: v })} placeholder={t("z. B. {example}", { example: "nyxos.example.com" })} error={e.hostname} />;
  }
  const f = forms.domain;
  const e = fieldErrors("domain", f);
  return (
    <div className="grid min-w-0 gap-3">
      <TextField id={`${idp}-dom`} label={t("Domain")} value={f.domain} onChange={(v) => setForm("domain", { domain: v })} placeholder={t("z. B. {example}", { example: "nyxos.example.com" })} error={e.domain} />
      <TextField id={`${idp}-mail`} label={t("E-Mail fürs Zertifikat (optional)")} value={f.email} onChange={(v) => setForm("domain", { email: v })} placeholder={t("du@example.com")} error={e.email} inputMode="email" />
    </div>
  );
}

function SecretField({ id, label, view }: { id: HostingSecretId; label: string; view: HostingProfileView }) {
  const info = view.secrets.find((s) => s.id === id);
  const { save, remove } = useHostingSecret(id);
  const [value, setValue] = useState("");
  const inputId = useId();
  if (!view.secretsReady) return <p className="text-caption text-a-mut">{t("Den Token kannst du hier sicher ablegen, sobald der Geheimnis-Speicher eingerichtet ist (Einstellungen → Zugänge & Schlüssel).")}</p>;
  return (
    <div className="grid min-w-0 gap-1.5">
      <label htmlFor={inputId} className={LABEL}>
        {label}
      </label>
      {info?.set ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-callout text-a-ink" data-testid="hosting-secret-state">
            {t("Gespeichert")} {info.last4 ? `••••${info.last4}` : ""}
          </span>
          <Button variant="warn" className={TAP} onClick={() => remove.mutate()} disabled={remove.isPending}>
            {t("Entfernen")}
          </Button>
        </div>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <input id={inputId} type="password" autoComplete="off" className={cn(FIELD, TAP, "min-w-0 flex-1 basis-56")} value={value} onChange={(e) => setValue(e.target.value)} placeholder={t("hier einfügen")} />
          <Button
            className={TAP}
            disabled={value.trim().length < 8 || save.isPending}
            onClick={() =>
              save.mutate(value.trim(), {
                onSuccess: () => setValue(""),
              })
            }
          >
            {save.isPending ? t("Speichert …") : t("Sicher speichern")}
          </Button>
        </div>
      )}
      {(save.isError || remove.isError) && (
        <p role="alert" className="text-caption text-a-bad">
          {(save.error ?? remove.error) instanceof Error ? (save.error ?? remove.error)?.message : t("Ging gerade nicht.")}
        </p>
      )}
      <p className="text-caption text-a-mut">{t("Der Token wird nie wieder angezeigt – auch Nyx bekommt ihn nicht. Beim Einrichten gibst du ihn verdeckt ein (Befehl unten).")}</p>
    </div>
  );
}

function PhoneOpen({ url, verified }: { url: string; verified: HostingCheckResult | null }) {
  return (
    <div className="grid min-w-0 gap-1.5 rounded-lg border border-a-line bg-a-p2 px-3 py-2" data-testid="hosting-phone-open">
      <span className={LABEL}>{t("Am Handy öffnen")}</span>
      <CopyBlock command={url} label={t("Adresse fürs Handy")} />
      <p className="text-caption text-a-mut">{verified ? t("Geprüft {when} – diese Adresse im Handy-Browser öffnen und zum Home-Bildschirm hinzufügen.", { when: when(verified.at) }) : t("Noch nicht geprüft – erst die Schritte oben, dann „Prüfen“.")}</p>
    </div>
  );
}
