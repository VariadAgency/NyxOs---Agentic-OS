// Einstellungen → „Zugänge“. Jeder Schlüssel/Token ist eine anklickbare Karte (Zustand, wofür, was es
// freischaltet, Schritt für Schritt wo es ihn gibt, Prüfen, Entfernen). Oben „Alles auf einmal einrichten“:
// alle fehlenden Zugänge auf einem Blatt, schlau einfügen, speichern, Zusammenfassung. Werte werden nie angezeigt.
import { ACCESS_ITEMS, isEditableAccess, t, tc, type AccessId, type AccessItem, type AccessState, type AccessStatus } from "@nyxos/shared";
import { useEffect, useId, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Card, SectionTitle } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { cn } from "../../../lib/cn";
import { friendlyError } from "../../../lib/friendlyError";
import { FIELD, LABEL } from "../fieldStyles";
import { KeyNotice } from "../ModelsPanel";
import { useAccess, useCheckAccess, useRemoveAccess, useSaveAccess } from "./accessApi";
import { StatePill } from "./AccessStatePill";
import { AccessWizard } from "./AccessWizard";

export const ACCESS_ANCHOR = "zugaenge";

/** Link zu einer Stelle in NyxOS (gleiche Seite: hinscrollen, sonst hinwechseln). */
function useGoTo() {
  const navigate = useNavigate();
  const location = useLocation();
  return (target: string) => {
    const [path, hash] = target.split("#");
    if (path === location.pathname && hash) document.getElementById(hash)?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    else void navigate(target);
  };
}

function Steps({ item }: { item: AccessItem }) {
  return (
    <ol className="grid gap-1.5">
      {item.steps.map((s, i) => (
        <li key={s.text} className="grid grid-cols-[1.5rem_1fr] items-start gap-2 text-callout text-a-ink">
          <span className="grid h-6 w-6 place-items-center rounded-full border border-a-line bg-a-p2 font-mono text-label text-a-mut">{i + 1}</span>
          <span className="pt-0.5">
            {s.text}
            {s.url && (
              <>
                {" "}
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-a-acc underline-offset-2 hover:underline">
                  {t("öffnen ↗")}
                </a>
              </>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

function AccessCard({ item, status, open, onToggle }: { item: AccessItem; status: AccessStatus | undefined; open: boolean; onToggle: () => void }) {
  const [value, setValue] = useState("");
  const save = useSaveAccess();
  const check = useCheckAccess();
  const remove = useRemoveAccess();
  const goTo = useGoTo();
  const bodyId = useId();
  const state: AccessState = status?.state ?? (isEditableAccess(item) ? "missing" : "link");
  const editable = isEditableAccess(item);
  const present = state === "ok" || state === "unchecked" || state === "error";
  const lastCheck = check.data?.check ?? status?.lastCheck ?? null;
  const err = save.error ?? check.error ?? remove.error;
  const blocked = status?.blocked ?? null;

  const doSave = async () => {
    await save.mutateAsync({ id: item.id, value: value.trim() });
    setValue("");
    check.mutate(item.id);
  };

  return (
    <Card className="grid p-0" data-access={item.id}>
      <button type="button" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-3 text-left hover:bg-a-p2" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-callout font-medium text-a-ink">{item.label}</span>
            {status?.last4 && <span className="font-mono text-label text-a-mut">{t("endet auf …{last4}", { last4: status.last4 })}</span>}
          </span>
          <span className="text-caption text-a-mut">{status?.detail ?? item.purpose}</span>
        </span>
        <StatePill state={state} />
        <span aria-hidden className={cn("text-a-mut transition-transform duration-150", open && "rotate-90")}>
          ›
        </span>
      </button>

      {open && (
        <div id={bodyId} className="grid gap-4 border-t border-a-line px-3 pb-4 pt-3">
          <div className="grid gap-1">
            <span className={LABEL}>{t("Wofür")}</span>
            <p className="text-callout text-a-ink">{item.purpose}</p>
          </div>
          <div className="grid gap-1">
            <span className={LABEL}>{t("Das schaltet es frei")}</span>
            <ul className="grid gap-0.5 text-callout text-a-ink">
              {item.unlocks.map((u) => (
                <li key={u}>• {u}</li>
              ))}
            </ul>
            {item.cost && <p className="text-caption text-a-mut">{item.cost}</p>}
          </div>
          <div className="grid gap-1.5">
            <span className={LABEL}>{item.storage === "provider-url" ? t("So bekommst du es") : t("So bekommst du den Schlüssel")}</span>
            <Steps item={item} />
            <a href={item.link.url} target="_blank" rel="noopener noreferrer" className="w-fit text-caption text-a-acc underline-offset-2 hover:underline">
              {t("Offizielle Seite: {label} ↗", { label: item.link.label })}
            </a>
          </div>

          {editable ? (
            <div className="grid gap-2 rounded-lg border border-a-line bg-a-bg/40 p-2.5">
              <label className="grid gap-1">
                <span className={LABEL}>{item.storage === "provider-url" ? t("Adresse") : present ? t("Neuen Wert eintragen (ersetzt den alten)") : t("Hier einfügen")}</span>
                <input
                  className={cn(FIELD, "font-mono")}
                  type={item.storage === "provider-url" ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  value={value}
                  disabled={!!blocked}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={blocked ? t("erst nach dem nächsten Deploy möglich") : item.storage === "provider-url" ? (status?.url ?? item.placeholder) : present && status?.last4 ? t("gesetzt · endet auf …{last4}", { last4: status.last4 }) : item.placeholder}
                  aria-label={t("{label}: Wert", { label: item.label })}
                />
              </label>
              {blocked && <p className="text-caption text-a-wait">{blocked}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" disabled={!value.trim() || save.isPending || !!blocked} onClick={() => void doSave().catch(() => {})}>
                  {save.isPending ? t("Speichere …") : t("Speichern + prüfen")}
                </Button>
                <Button disabled={!present || check.isPending} onClick={() => check.mutate(item.id)}>
                  {check.isPending ? t("Prüfe …") : tc("access", "Prüfen")}
                </Button>
                {present && (
                  <Button variant="warn" disabled={remove.isPending} onClick={() => window.confirm(t("{label}: gespeicherten Zugang wirklich entfernen?", { label: item.label })) && remove.mutate(item.id)}>
                    {t("Entfernen")}
                  </Button>
                )}
              </div>
              {lastCheck && (
                <p className={cn("text-caption", lastCheck.ok ? "text-a-ok" : "text-a-bad")} data-testid={`access-check-${item.id}`}>
                  {lastCheck.ok ? "✓ " : "✗ "}
                  {lastCheck.message}
                  <span className="text-a-mut"> · {lastCheck.ms} ms</span>
                </p>
              )}
            </div>
          ) : (
            item.target && (
              <Button className="w-fit" onClick={() => goTo(item.target as string)}>
                {t("Dorthin →")}
              </Button>
            )
          )}
          {err && <p className="text-caption text-a-bad">{friendlyError(err)}</p>}
        </div>
      )}
    </Card>
  );
}

export function AccessPanel() {
  const access = useAccess();
  const location = useLocation();
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState<AccessId | null>(null);
  const [wizard, setWizard] = useState(false);
  const byId = new Map((access.data?.items ?? []).map((s) => [s.id, s]));
  const editable = ACCESS_ITEMS.filter(isEditableAccess);
  const okCount = editable.filter((i) => byId.get(i.id)?.state === "ok").length;
  const missing = editable.filter((i) => byId.get(i.id)?.state === "missing" || byId.get(i.id)?.state === "error");

  useEffect(() => {
    if (location.hash === `#${ACCESS_ANCHOR}`) ref.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    if (location.hash === `#${ACCESS_ANCHOR}-einrichten`) {
      setWizard(true);
      ref.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    }
  }, [location.hash]);

  return (
    <section ref={ref} className="grid scroll-mt-4 gap-2" data-nyx-risk="">
      <SectionTitle>{t("Zugänge")}</SectionTitle>
      <p className="text-callout text-a-mut">{t("Schlüssel und Tokens für Modelle, Telegram und das Ideen-Postfach. Tippe eine Karte an für Infos und Schritte. Gespeichert wird verschlüsselt – angezeigt werden nur die letzten 4 Zeichen.")}</p>
      {access.data && <KeyNotice state={access.data.secretsKey} />}
      {access.isLoading && <Skeleton className="h-40 w-full" />}
      {access.isError && (
        <Card className="grid gap-2 p-3">
          <p className="text-callout text-a-wait">{friendlyError(access.error)}</p>
          <Button className="w-fit" onClick={() => void access.refetch()}>
            {t("Erneut versuchen")}
          </Button>
        </Card>
      )}
      {access.data && (
        <>
          <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
            <div className="grid min-w-0 flex-1 gap-0.5">
              <b className="text-callout font-semibold text-a-ink">
                {t("{ok} von {n} verbunden", { ok: okCount, n: editable.length })}
              </b>
              <span className="text-caption text-a-mut">{missing.length ? t("{n} fehlen oder haben einen Fehler.", { n: missing.length }) : t("Alles eingerichtet.")}</span>
            </div>
            <Button variant="primary" onClick={() => setWizard((v) => !v)} aria-expanded={wizard}>
              {wizard ? t("Assistent schließen") : t("Alles auf einmal einrichten")}
            </Button>
          </Card>
          {wizard && <AccessWizard items={access.data.items} onClose={() => setWizard(false)} />}
          <div className="grid gap-2">
            {ACCESS_ITEMS.map((item) => (
              <AccessCard key={item.id} item={item} status={byId.get(item.id)} open={open === item.id} onToggle={() => setOpen((v) => (v === item.id ? null : item.id))} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
