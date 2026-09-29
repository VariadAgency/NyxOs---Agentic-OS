// Einstellungen → „Modelle“. Oben: wer antwortet (Rollen → Modell, aktives Modell sichtbar),
// darunter je Anbieter eine Karte (Schlüssel/Adresse, Test, Modell-Liste, an/aus). Von oben nach unten,
// alles aufklappbar. Schlüssel werden nie angezeigt – nur „gesetzt ••••abcd“.
import { catalogModel, describeModel, EMBEDDING_ROLE_ERROR, formatContext, formatPrice, isEmbeddingModel, MODEL_ROLES, t, type ProviderView, type RoleView, type SecretsKeyState } from "@nyxos/shared";
import { useEffect, useId, useState } from "react";
import { Card, SectionTitle } from "../../components/ui/Card";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { friendlyError } from "../../lib/friendlyError";
import { splitModelLabel } from "../../lib/modelName";
import { PROVIDER_COLOR } from "./providerColors";
import { FIELD, LABEL } from "./fieldStyles";
import { ModelPicker } from "./ModelPicker";
import { useAssignRole, useDeleteProvider, useModelRoles, useProviders, useSaveProvider, useTestProvider } from "./modelsApi";

export const MODELS_ANCHOR = "modelle";

// Feld-Stile liegen in fieldStyles.ts (auch für Zugänge + Modell-Wähler, ohne Kreis-Import).
export { FIELD, LABEL } from "./fieldStyles";

export function KeyNotice({ state }: { state: SecretsKeyState }) {
  if (state === "ok") return null;
  return (
    <Card className="grid gap-1 border-a-wait/40 p-3" role="status">
      <b className="text-caption font-semibold text-a-wait">{state === "missing" ? t("Geheimnis-Speicher noch ohne Schlüssel") : t("Gespeicherte Schlüssel lassen sich nicht öffnen")}</b>
      <p className="text-caption text-a-mut">
        {state === "missing"
          ? t("Schlüssel und Tokens werden verschlüsselt gespeichert. Den Speicher-Schlüssel legt Claude beim nächsten Deploy auf dem Server an – danach kannst du hier alles eintragen.")
          : t("Der Speicher-Schlüssel wurde getauscht. Bitte die betroffenen Schlüssel neu eintragen.")}
      </p>
    </Card>
  );
}

function StatusPill({ p }: { p: ProviderView }) {
  const look = !p.configured
    ? { text: t("nicht eingerichtet"), cls: "border-a-line text-a-mut", dot: "bg-a-dim" }
    : !p.enabled
      ? { text: t("aus"), cls: "border-a-line text-a-mut", dot: "bg-a-idle" }
      : p.lastTest?.ok
        ? { text: t("verbunden · {n} Modelle", { n: p.lastTest.models }), cls: "border-a-ok/40 bg-a-ok/10 text-a-ok", dot: "bg-a-ok" }
        : p.lastTest
          ? { text: t("gestört"), cls: "border-a-bad/40 bg-a-bad/10 text-a-bad", dot: "bg-a-bad" }
          : { text: t("noch nicht getestet"), cls: "border-a-wait/40 bg-a-wait/10 text-a-wait", dot: "bg-a-wait" };
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-label font-medium", look.cls)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", look.dot)} />
      {look.text}
    </span>
  );
}

// ─── Rollen ───

/**
 * Active model of a role – readable name ("Haiku 4.5") and additions ("denkt gründlich", provider), the route small in
 * brackets; the exact id only in the tooltip.
 */
export function ActiveModelChip({ role, label, model, pill }: { role: string; label: string; model: string; pill: string }) {
  const { name, extras, note } = splitModelLabel(label, model);
  return (
    <span className={cn("inline-flex min-w-0 flex-wrap items-center gap-x-1.5 rounded-full border px-2 py-0.5 text-caption font-medium", pill)} data-testid={`active-${role}`} title={t("Kennung: {model}", { model })}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      <span>{[name, ...extras].join(" · ")}</span>
      {note && <span className="font-normal opacity-75">{" "}({note})</span>}
    </span>
  );
}

function RoleRow({ role, providers }: { role: RoleView; providers: ProviderView[] }) {
  const assign = useAssignRole();
  const usable = providers.filter((p) => p.configured && p.enabled);
  const [providerId, setProviderId] = useState<string>(role.active.providerId ?? "");
  const [model, setModel] = useState<string>(role.active.source === "provider" ? role.active.model : "");
  useEffect(() => {
    setProviderId(role.active.providerId ?? "");
    setModel(role.active.source === "provider" ? role.active.model : "");
  }, [role.active.providerId, role.active.model, role.active.source]);
  const chosen = usable.find((p) => p.id === providerId);
  const dirty = providerId !== (role.active.providerId ?? "") || (providerId !== "" && model !== (role.active.source === "provider" ? role.active.model : ""));
  const modelListId = useId();
  // Großer Wähler mit genauen Kennungen, Kontext, Preisen.
  const [picking, setPicking] = useState(false);
  const chosenInfo = providerId && model ? (chosen?.models.find((m) => m.id === model) ?? null) : null;
  const known = model ? (catalogModel(model) ?? catalogModel(model.split("/").pop() ?? "")) : null;
  const ctx = formatContext(chosenInfo?.context ?? known?.context ?? null);
  const price = chosenInfo?.priceIn != null ? formatPrice({ priceIn: chosenInfo.priceIn, priceOut: chosenInfo.priceOut ?? null }) : known ? formatPrice(known) : null;
  // Embedding-Modelle können nicht chatten – nicht anbieten, getippt gleich sagen, warum es nicht geht.
  const embedding = providerId !== "" && isEmbeddingModel(model);
  const pill = role.active.source === "provider" ? "border-a-violet/40 bg-a-violet/10 text-a-violet" : "border-(--a-claude)/40 bg-(--a-claude)/10 text-(--a-claude)";

  return (
    <li className="grid gap-2 rounded-lg px-2 py-2.5 hover:bg-a-p2" data-role={role.role}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-callout font-medium text-a-ink">{role.label}</span>
        <ActiveModelChip role={role.role} label={role.active.label} model={role.active.model} pill={pill} />
        {role.fixed && <span className="text-caption text-a-mut">{t("fest – nicht änderbar")}</span>}
      </div>
      <p className="text-caption text-a-mut">{role.hint}</p>
      {!role.fixed && (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <label className="grid gap-1">
            <span className={LABEL}>{t("Anbieter")}</span>
            <select
              className={FIELD}
              value={providerId}
              aria-label={t("Anbieter für {role}", { role: role.label })}
              onChange={(e) => {
                setProviderId(e.target.value);
                const p = usable.find((x) => x.id === e.target.value);
                setModel(p?.models.find((m) => !isEmbeddingModel(m.id))?.id ?? "");
              }}
            >
              <option value="">{t("Standard: Claude Haiku 4.5 (Claude-Programm)")}</option>
              {usable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            <span className={LABEL}>{t("Modell")}</span>
            <input className={FIELD} list={modelListId} value={model} disabled={!providerId} placeholder={providerId ? t("Modell wählen oder eintippen") : "–"} aria-label={t("Modell für {role}", { role: role.label })} onChange={(e) => setModel(e.target.value)} />
            <datalist id={modelListId}>
              {(chosen?.models ?? []).filter((m) => !isEmbeddingModel(m.id)).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label ?? describeModel(m.id)}
                </option>
              ))}
            </datalist>
          </label>
          <Button variant="primary" disabled={!dirty || assign.isPending || embedding || (providerId !== "" && !model.trim())} onClick={() => assign.mutate({ role: role.role, providerId: providerId || null, model: providerId ? model.trim() : null })}>
            {assign.isPending ? t("Speichere …") : t("Übernehmen")}
          </Button>
        </div>
      )}
      {!role.fixed && providerId && model && (known || ctx || price) && (
        <p className="text-caption text-a-mut" data-testid={`model-info-${role.role}`}>
          {[known?.name, ctx && t("Kontext {ctx}", { ctx }), price && t("{price} pro 1 Mio. Token", { price }), known?.speed].filter(Boolean).join(" · ")}
        </p>
      )}
      {!role.fixed && (
        <Button variant="ghost" className="w-fit" aria-expanded={picking} onClick={() => setPicking((v) => !v)}>
          {picking ? t("Modell-Liste schließen") : t("Aus allen Modellen wählen (mit Version, Kontext, Preis)")}
        </Button>
      )}
      {picking && !role.fixed && (
        <ModelPicker
          selected={providerId ? { providerId, model } : null}
          onClose={() => setPicking(false)}
          onPick={(m) => {
            setProviderId(m.providerId);
            setModel(m.id);
            setPicking(false);
          }}
        />
      )}
      {embedding && (
        <p className="text-caption text-a-bad" data-testid={`embedding-${role.role}`}>
          {t(EMBEDDING_ROLE_ERROR)}
        </p>
      )}
      {assign.isError && <p className="text-caption text-a-bad">{friendlyError(assign.error)}</p>}
    </li>
  );
}

// ─── Anbieter-Karte ───

function ProviderCard({ p, keyState, bridge, startOpen = false, onCreated }: { p: ProviderView; keyState: SecretsKeyState; bridge: { online: boolean; localProxy: boolean }; startOpen?: boolean; onCreated?: () => void }) {
  const [open, setOpen] = useState(startOpen);
  const [baseUrl, setBaseUrl] = useState(p.baseUrl);
  const [label, setLabel] = useState(p.label);
  const [via, setVia] = useState(p.via);
  const [apiKey, setApiKey] = useState("");
  const [testModel, setTestModel] = useState("");
  const save = useSaveProvider();
  const test = useTestProvider();
  const del = useDeleteProvider();
  const isNew = p.kind === "custom" && !p.configured;
  const local = p.kind === "ollama" || p.kind === "lmstudio" || p.kind === "custom";
  const bodyId = useId();
  const listId = useId();

  const doSave = async (extra: { enabled?: boolean; clearKey?: boolean } = {}) => {
    await save.mutateAsync({
      id: isNew ? null : p.id,
      input: { kind: p.kind, label: label.trim() || p.label, baseUrl: baseUrl.trim() || undefined, via, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...extra },
    });
    setApiKey("");
    if (isNew) onCreated?.();
  };

  // Schalter reagiert sofort und speichert nur „an/aus“ (keine halb bearbeiteten Felder); bei Fehler zurück.
  const [enabled, setEnabled] = useState(p.enabled);
  useEffect(() => setEnabled(p.enabled), [p.enabled]);
  const setOn = (on: boolean) => {
    setEnabled(on);
    save.mutate({ id: p.id, input: { kind: p.kind, enabled: on } }, { onError: () => setEnabled(p.enabled) });
  };

  const err = save.error ?? test.error ?? del.error;
  const lastTest = test.data ?? p.lastTest;

  return (
    <Card className="grid gap-2 p-0" data-provider={p.id} data-nyx-risk="">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 text-left" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
          <span data-provider-dot={p.kind} className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PROVIDER_COLOR[p.kind] }} />
          <span className="truncate text-callout font-medium text-a-ink">{p.label}</span>
          {p.key.set && <span className="font-mono text-label text-a-mut">{t("Schlüssel ••••{last4}", { last4: p.key.last4 ?? "" })}</span>}
        </button>
        <StatusPill p={p} />
        {p.configured && (
          <label className="flex items-center gap-1.5 text-caption text-a-mut">
            <input type="checkbox" checked={enabled} onChange={(e) => setOn(e.target.checked)} aria-label={t("{name} an/aus", { name: p.label })} />
            {t("an")}
          </label>
        )}
        <Button variant="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? t("Zuklappen") : p.configured ? t("Bearbeiten") : t("Einrichten")}
        </Button>
      </div>

      {open && (
        <div id={bodyId} className="grid gap-3 border-t border-a-line px-3 pb-3 pt-3">
          <p className="text-caption text-a-mut">{p.keyHint}</p>
          {p.kind === "custom" && (
            <label className="grid gap-1">
              <span className={LABEL}>{t("Name")}</span>
              <input className={FIELD} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("z. B. Mein Server")} />
            </label>
          )}
          <label className="grid gap-1">
            <span className={LABEL}>{t("Adresse")}</span>
            <input className={cn(FIELD, "font-mono")} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" />
          </label>
          {local && (
            <fieldset className="grid gap-1">
              <legend className={LABEL}>{t("Wie der Server es erreicht")}</legend>
              <div className="flex flex-wrap gap-3 text-caption text-a-ink">
                <label className="flex items-center gap-1.5">
                  <input type="radio" checked={via === "bridge"} onChange={() => setVia("bridge")} /> {t("Über deinen Rechner (Brücke)")}
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" checked={via === "direct"} onChange={() => setVia("direct")} /> {t("Direkt über die Adresse")}
                </label>
              </div>
              {via === "bridge" && (
                <p className={cn("text-caption", bridge.online && bridge.localProxy ? "text-a-mut" : "text-a-wait")}>
                  {!bridge.online
                    ? t("Dein Rechner ist gerade nicht verbunden – lokale Modelle gehen erst, wenn die Brücke läuft.")
                    : !bridge.localProxy
                      ? t("Die Brücke ist noch eine ältere Fassung – sie kann lokale Modelle ab dem nächsten Update weiterreichen.")
                      : t("Die Brücke reicht nur Ollama (11434) und LM Studio (1234) weiter.")}
                </p>
              )}
            </fieldset>
          )}
          <label className="grid gap-1">
            <span className={LABEL}>{p.needsKey ? t("Schlüssel") : t("Schlüssel (nur falls nötig)")}</span>
            <input
              className={cn(FIELD, "font-mono")}
              type="password"
              autoComplete="off"
              value={apiKey}
              disabled={keyState !== "ok"}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={keyState !== "ok" ? t("erst nach dem nächsten Deploy möglich") : p.key.set ? t("gesetzt (••••{last4}) – leer lassen = unverändert", { last4: p.key.last4 ?? "" }) : t("hier einfügen")}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={save.isPending || (isNew && !baseUrl.trim())} onClick={() => void doSave().catch(() => {})}>
              {save.isPending ? t("Speichere …") : isNew ? t("Anlegen") : t("Speichern")}
            </Button>
            {p.configured && p.key.set && (
              <Button variant="warn" disabled={save.isPending} onClick={() => void doSave({ clearKey: true }).catch(() => {})}>
                {t("Schlüssel entfernen")}
              </Button>
            )}
            {p.kind === "custom" && p.configured && (
              <Button variant="warn" disabled={del.isPending} onClick={() => window.confirm(t("„{name}“ wirklich löschen?", { name: p.label })) && del.mutate(p.id)}>
                {t("Löschen")}
              </Button>
            )}
          </div>

          {p.configured && (
            <div className="grid gap-2 rounded-lg border border-a-line bg-a-bg/40 p-2.5">
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <label className="grid gap-1">
                  <span className={LABEL}>{t("Testen mit Modell (optional)")}</span>
                  <input className={cn(FIELD, "font-mono")} list={listId} value={testModel} onChange={(e) => setTestModel(e.target.value)} placeholder={t("leer = nur Modelle laden")} />
                  <datalist id={listId}>
                    {p.models.map((m) => (
                      <option key={m.id} value={m.id} />
                    ))}
                  </datalist>
                </label>
                <Button disabled={test.isPending} onClick={() => test.mutate({ id: p.id, model: testModel.trim() || undefined })}>
                  {test.isPending ? t("Teste …") : t("Test")}
                </Button>
              </div>
              {lastTest && (
                <p className={cn("text-caption", lastTest.ok ? "text-a-ok" : "text-a-bad")} data-testid={`test-${p.id}`}>
                  {lastTest.message}
                  {lastTest.reply ? <span className="text-a-mut"> · {t("Antwort: „{reply}“", { reply: lastTest.reply })}</span> : null}
                  <span className="text-a-mut"> · {lastTest.ms} ms</span>
                </p>
              )}
              {p.models.length > 0 && (
                <details className="text-caption text-a-mut">
                  <summary className="cursor-pointer text-a-ink">{t("{n} Modelle", { n: p.models.length })}</summary>
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {p.models.slice(0, 120).map((m) => (
                      <li key={m.id} className="rounded-md border border-a-line bg-a-p2 px-1.5 py-0.5 font-mono text-label text-a-ink">
                        {m.id}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          {err && <p className="text-caption text-a-bad">{friendlyError(err)}</p>}
        </div>
      )}
    </Card>
  );
}

const NEW_CUSTOM: ProviderView = {
  id: "neu",
  kind: "custom",
  label: t("Eigener Endpunkt"),
  api: "openai",
  baseUrl: "",
  via: "direct",
  enabled: true,
  needsKey: false,
  keyHint: t("Adresse eines OpenAI-kompatiblen Servers (endet meist auf /v1), Schlüssel nur falls nötig."),
  key: { set: false, last4: null },
  configured: false,
  models: [],
  lastTest: null,
};

export function ModelsPanel() {
  const providers = useProviders();
  const roles = useModelRoles();
  const [adding, setAdding] = useState(false);
  const list = providers.data?.providers ?? [];
  const roleOrder = (r: RoleView) => MODEL_ROLES.indexOf(r.role);

  return (
    <section className="grid scroll-mt-4 gap-2">
      <SectionTitle>{t("Modelle")}</SectionTitle>
      <p className="text-caption text-a-mut">{t("Standard ist Claude Haiku 4.5 über das Claude-Programm. Schlüssel für andere Anbieter trägst du unter „Zugänge & Schlüssel“ ein.")}</p>
      {providers.data && <KeyNotice state={providers.data.secretsKey} />}
      {(providers.isLoading || roles.isLoading) && <Skeleton className="h-40 w-full" />}
      {(providers.isError || roles.isError) && (
        <Card className="grid gap-2 p-3">
          <p className="text-callout text-a-wait">{friendlyError(providers.error ?? roles.error)}</p>
          <Button
            className="w-fit"
            onClick={() => {
              void providers.refetch();
              void roles.refetch();
            }}
          >
            {t("Erneut versuchen")}
          </Button>
        </Card>
      )}

      {roles.data && providers.data && (
        <Card className="grid gap-1 p-2" aria-label={t("Wer antwortet")}>
          <h3 className="px-2 pb-1 pt-1 text-callout font-medium text-a-ink">{t("Wer antwortet")}</h3>
          <ul className="grid gap-0.5">
            {[...roles.data.roles].sort((a, b) => roleOrder(a) - roleOrder(b)).map((r) => (
              <RoleRow key={r.role} role={r} providers={list} />
            ))}
          </ul>
        </Card>
      )}

      {providers.data && (
        <div className="grid gap-2" aria-label={t("Anbieter")}>
          <h3 className="pt-2 text-callout font-medium text-a-ink">{t("Anbieter")}</h3>
          {list.map((p) => (
            <ProviderCard key={p.id} p={p} keyState={providers.data.secretsKey} bridge={providers.data.bridge} />
          ))}
          {adding ? (
            <ProviderCard p={NEW_CUSTOM} keyState={providers.data.secretsKey} bridge={providers.data.bridge} startOpen onCreated={() => setAdding(false)} />
          ) : (
            <Button className="w-fit" onClick={() => setAdding(true)}>
              {t("+ Eigener Endpunkt (OpenAI-kompatibel)")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
