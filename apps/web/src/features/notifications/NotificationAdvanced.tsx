// "Erweitert" (collapsible): what is rarely needed. Quiet hours (ONE for both systems), waiting time, minimum gap,
// bundling, away detection, own templates per occasion, phone (ntfy target, QR), click address.
import { NOTIFY_KINDS, NOTIFY_OCCASIONS, NOTIFY_PLACEHOLDERS, renderNotification, t, type NotifySettingsPatch, type NotifySettingsResponse, type PushEventKind } from "@nyxos/shared";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { clockTime } from "./clock";
import { BTN, BTN_ACCENT, FIELD, LABEL, LockscreenCard, PhoneSetup, SelectField, SwitchRow } from "./parts";

/** Number that saves when the field is left (or on Enter) – clamped to [min, max]. */
function NumberSetting({ label, hint, value, min, max, unit, onSave, disabled, testId }: { label: string; hint?: string; value: number; min: number; max: number; unit: string; onSave: (v: number) => void; disabled?: boolean; testId?: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (!Number.isFinite(n)) return setDraft(String(value));
    const v = Math.min(max, Math.max(min, n));
    setDraft(String(v));
    if (v !== value) onSave(v);
  };
  return (
    <label className="grid gap-1">
      <span className="text-callout text-a-ink">{label}</span>
      {hint && <span className="text-caption text-a-mut">{hint}</span>}
      <span className="flex items-center gap-2">
        <input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={draft}
          disabled={disabled}
          data-testid={testId}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
          className={cn(FIELD, "w-28")}
        />
        <span className="text-caption text-a-mut">{unit}</span>
      </span>
    </label>
  );
}

function QuietHours({ data, save, busy }: { data: NotifySettingsResponse; save: (p: NotifySettingsPatch) => void; busy: boolean }) {
  const on = data.away.quietEnabled && data.push.quietStart !== data.push.quietEnd;
  const start = data.push.quietStart !== data.push.quietEnd ? data.push.quietStart : data.away.quietStart;
  const end = data.push.quietStart !== data.push.quietEnd ? data.push.quietEnd : data.away.quietEnd;
  // One quiet time for both systems: single push (start = end means "off" there) and the away digest.
  const set = (next: { on: boolean; start: string; end: string }) =>
    save({
      push: next.on ? { quietStart: next.start, quietEnd: next.end } : { quietStart: "00:00", quietEnd: "00:00" },
      away: { quietEnabled: next.on, quietStart: next.start, quietEnd: next.end },
    });
  return (
    <div className="grid scroll-mt-4 gap-2" id="erweitert-ruhezeit">
      <SwitchRow title={t("Ruhezeit")} hint={t("In der Ruhezeit bleibt es still – außer Dringendes (Deploy fehlgeschlagen). Der Rest kommt danach gesammelt.")} on={on} disabled={busy} testId="quiet-on" onChange={(v) => set({ on: v, start, end })} />
      {on && (
        <div className="grid grid-cols-2 gap-3 px-1">
          <label className="grid gap-1">
            <span className={LABEL}>{t("Von")}</span>
            <input type="time" className={FIELD} value={start} disabled={busy} onChange={(e) => e.target.value && set({ on, start: e.target.value, end })} />
          </label>
          <label className="grid gap-1">
            <span className={LABEL}>{t("Bis")}</span>
            <input type="time" className={FIELD} value={end} disabled={busy} onChange={(e) => e.target.value && set({ on, start, end: e.target.value })} />
          </label>
        </div>
      )}
    </div>
  );
}

function Templates({ data, save, busy, example, setExample }: { data: NotifySettingsResponse; save: (p: NotifySettingsPatch) => void; busy: boolean; example: PushEventKind; setExample: (k: PushEventKind) => void }) {
  const stored = data.rules.templates[example] ?? null;
  const meta = NOTIFY_OCCASIONS[example];
  const [title, setTitle] = useState(stored?.title ?? "");
  const [body, setBody] = useState(stored?.body ?? "");
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    setTitle(stored?.title ?? "");
    setBody(stored?.body ?? "");
  }, [stored?.title, stored?.body, example]);
  const dirty = title.trim() !== (stored?.title ?? "") || body.trim() !== (stored?.body ?? "");
  const draft = title.trim() || body.trim() ? { title: title.trim(), body: body.trim() } : null;
  const now = new Date();
  const preview = renderNotification(
    example,
    data.rules.style,
    { session: meta.session ? data.sample.session : null, baustelle: meta.session ? data.sample.baustelle : null, was: t(meta.sample.was), wann: clockTime(now), details: t(meta.sample.details) },
    draft,
  );
  const insert = (key: string) => {
    const el = bodyRef.current;
    if (!el) return setBody((b) => `${b}${key}`);
    const at = el.selectionStart ?? body.length;
    const next = `${body.slice(0, at)}${key}${body.slice(el.selectionEnd ?? at)}`;
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at + key.length, at + key.length);
    });
  };
  return (
    <div className="grid scroll-mt-4 gap-3" id="erweitert-vorlagen">
      <div className="grid gap-1">
        <span className="text-callout text-a-ink">{t("Eigene Vorlagen")}</span>
        <span className="text-caption text-a-mut">{t("Leer = Standard des gewählten Stils. Platzhalter werden beim Senden ersetzt.")}</span>
      </div>
      <label className="grid gap-1">
        <span className={LABEL}>{t("Anlass")}</span>
        <SelectField value={example} onChange={(v) => setExample(v as PushEventKind)} testId="template-kind">
          {NOTIFY_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(NOTIFY_OCCASIONS[k].label)}
              {data.rules.templates[k] ? ` · ${t("eigene")}` : ""}
            </option>
          ))}
        </SelectField>
      </label>
      <label className="grid gap-1">
        <span className={LABEL}>{t("Überschrift")}</span>
        <input className={cn(FIELD, "font-body")} value={title} maxLength={120} placeholder={t(meta.title)} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="grid gap-1">
        <span className={LABEL}>{t("Text")}</span>
        <textarea
          ref={bodyRef}
          className="w-full rounded-lg border border-a-line bg-a-p2 px-2.5 py-2 text-callout text-a-ink placeholder:text-a-mut focus:border-a-acc focus:outline-none"
          rows={3}
          maxLength={600}
          value={body}
          placeholder={t("z. B. {session} ({baustelle}): {was} – {wann}")}
          onChange={(e) => setBody(e.target.value)}
          data-testid="template-body"
        />
      </label>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("Platzhalter einfügen")}>
        {NOTIFY_PLACEHOLDERS.map((p) => (
          <button key={p.key} type="button" className={cn(BTN, "px-2 font-mono")} title={t(p.text)} onClick={() => insert(p.key)}>
            {p.key}
            <span className="sr-only"> – {t(p.text)}</span>
          </button>
        ))}
      </div>
      <LockscreenCard title={preview.title} body={preview.body} time={clockTime(now)} label={t("Vorschau dieser Vorlage")} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={cn(BTN, BTN_ACCENT)} disabled={!dirty || busy} onClick={() => save({ rules: { templates: { [example]: draft } } })}>
          {t("Vorlage speichern")}
        </button>
        {stored && (
          <button type="button" className={BTN} disabled={busy} onClick={() => save({ rules: { templates: { [example]: null } } })}>
            {t("Zurück zum Standard")}
          </button>
        )}
      </div>
    </div>
  );
}

export function NotificationAdvanced({ data, save, busy, example, setExample }: { data: NotifySettingsResponse; save: (p: NotifySettingsPatch) => void; busy: boolean; example: PushEventKind; setExample: (k: PushEventKind) => void }) {
  const ref = useRef<HTMLDetailsElement | null>(null);
  // Link "Handy einrichten → Erweitert" (Wege): open and jump there.
  useEffect(() => {
    const open = () => {
      if (!/^#erweitert/.test(window.location.hash) || !ref.current) return;
      ref.current.open = true;
      requestAnimationFrame(() => document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "start" }));
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);
  const [base, setBase] = useState(data.push.publicBaseUrl);
  useEffect(() => setBase(data.push.publicBaseUrl), [data.push.publicBaseUrl]);
  return (
    <details ref={ref} id="erweitert" className="group min-w-0 scroll-mt-4 rounded-xl border border-a-line bg-a-p">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 focus-visible:outline-2 focus-visible:outline-a-acc [&::-webkit-details-marker]:hidden">
        <span>
          <span className="block font-display text-headline font-semibold text-a-ink">{t("Erweitert")}</span>
          <span className="block text-caption text-a-mut">{t("Ruhezeit, Bündeln, Wartezeit, eigene Vorlagen, Handy einrichten")}</span>
        </span>
        <span aria-hidden className="text-a-mut transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      <div className="grid gap-7 border-t border-a-line px-3 py-4">
        <QuietHours data={data} save={save} busy={busy} />
        <div className="grid scroll-mt-4 gap-4 sm:grid-cols-2" id="erweitert-abstand">
          <NumberSetting
            label={t("„Session wartet“ erst nach")}
            hint={t("So lange darf eine Session still auf dich warten.")}
            value={Math.round(data.push.waitingAfterSeconds / 60)}
            min={0}
            max={60}
            unit={t("Min")}
            disabled={busy}
            testId="waiting-after"
            onSave={(v) => save({ push: { waitingAfterSeconds: v * 60 } })}
          />
          <NumberSetting
            label={t("Mindestabstand je Session")}
            hint={t("Dieselbe Session meldet sich höchstens so oft (0 = aus).")}
            value={data.rules.minGapMinutes}
            min={0}
            max={240}
            unit={t("Min")}
            disabled={busy}
            testId="min-gap"
            onSave={(v) => save({ rules: { minGapMinutes: v } })}
          />
          <NumberSetting
            label={t("Gleiche Meldungen zusammenfassen")}
            hint={t("Kommt dasselbe innerhalb dieser Zeit noch einmal, wird es zu einer Mitteilung.")}
            value={data.push.bundleWindowSeconds}
            min={0}
            max={3600}
            unit={t("Sek")}
            disabled={busy}
            onSave={(v) => save({ push: { bundleWindowSeconds: v } })}
          />
          <NumberSetting
            label={t("Sammel-Mitteilung höchstens alle")}
            hint={t("Wenn du weg bist (und für Nyx' „bündeln“).")}
            value={data.away.bundleMinutes}
            min={1}
            max={240}
            unit={t("Min")}
            disabled={busy}
            onSave={(v) => save({ away: { bundleMinutes: v } })}
          />
        </div>
        <div className="grid scroll-mt-4 gap-3" id="erweitert-weg">
          <SwitchRow title={t("Erkennen, wenn ich weg bin")} hint={t("Weg = kein aktives NyxOS-Fenster. Aus: „Wenn weg“ meldet sich nie, alles geht einzeln raus.")} on={data.away.enabled} disabled={busy} onChange={(v) => save({ away: { enabled: v } })} />
          {data.away.enabled && (
            <NumberSetting label={t("Als weg gelten nach")} value={data.away.awayAfterMinutes} min={1} max={240} unit={t("Min")} disabled={busy} onSave={(v) => save({ away: { awayAfterMinutes: v } })} />
          )}
        </div>
        <Templates data={data} save={save} busy={busy} example={example} setExample={setExample} />
        <div className="grid scroll-mt-4 gap-2" id="erweitert-iphone">
          <div className="grid gap-1">
            <span className="text-callout text-a-ink">{t("Handy einrichten (App ntfy)")}</span>
            <span className="text-caption text-a-mut">{t("Wohin der Handy-Weg veröffentlicht und wie du ihn abonnierst.")}</span>
          </div>
          <PhoneSetup target={data.push.ntfyTarget ?? "own"} busy={busy} onTarget={(target) => save({ push: { ntfyTarget: target } })} />
        </div>
        <label className="grid scroll-mt-4 gap-1" id="erweitert-klick">
          <span className="text-callout text-a-ink">{t("Klick-Adresse")}</span>
          <span className="text-caption text-a-mut">{t("Tippst du eine Mitteilung an, öffnet sich NyxOS unter dieser Adresse (z. B. deine Tailscale-Adresse).")}</span>
          <span className="flex flex-wrap gap-2">
            <input className={cn(FIELD, "min-w-0 flex-1")} type="url" value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://nyxos.example.ts.net" data-testid="public-base" />
            <button type="button" className={BTN} disabled={busy || base.trim() === data.push.publicBaseUrl || !/^https?:\/\//.test(base.trim())} onClick={() => save({ push: { publicBaseUrl: base.trim() } })}>
              {t("Speichern")}
            </button>
          </span>
        </label>
      </div>
    </details>
  );
}
