// Einstellungen → „Konnektoren“ (MCP). Liste mit an/aus, Anmelden (Browser oder Geräte-Code),
// Test (= Werkzeuge auflisten), Werkzeuge einzeln freigeben (neue bleiben aus), Hinzufügen aus Vorlagen.
// Tokens werden nie angezeigt. Deine eigenen ~/.claude-Einstellungen bleiben unberührt.
import { locale, t, tc, timeZone, type ConnectorSave, type ConnectorView, type McpAuth, type McpTemplate, type McpTransport, type SecretsKeyState } from "@nyxos/shared";
import { useEffect, useId, useState } from "react";
import { Card, SectionTitle } from "../../components/ui/Card";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { friendlyError } from "../../lib/friendlyError";
import { FIELD, KeyNotice, LABEL } from "./ModelsPanel";
import { startConnectorLogin, useConnectors, useCreateConnector, useDeleteConnector, usePatchConnector, useStartDeviceLogin, useTestConnector } from "./modelsApi";

export const CONNECTORS_ANCHOR = "konnektoren";

const TRANSPORT_LABEL: Record<McpTransport, string> = { http: t("Adresse"), sse: t("Adresse (älterer Weg)"), stdio: t("Befehl") };
const AUTH_LABEL: Record<McpAuth, string> = {
  none: t("keine"),
  bearer: t("Token (Bearer)"),
  header: t("Token in eigener Kopfzeile"),
  env: t("Token als Umgebungsvariable"),
  oauth: t("Anmelden im Browser"),
  device: t("Anmelden mit Link (Geräte-Code)"),
};
/** Konnektoren bunt nach Vorlage (nie grau). */
const DOT: Record<string, string> = {
  higgsfield: "bg-a-conf",
  github: "bg-a-indigo",
  linear: "bg-a-violet",
  notion: "bg-a-done",
  fal: "bg-a-lime",
  elevenlabs: "bg-a-wait",
  replicate: "bg-a-acc",
  "brave-search": "bg-(--a-claude)",
  playwright: "bg-a-ok",
};
const dotFor = (c: { template: string | null }) => DOT[c.template ?? ""] ?? "bg-(--a-codex)";

function needsLogin(c: ConnectorView): boolean {
  return (c.auth === "oauth" || c.auth === "device") && !c.token.set;
}

function StatePill({ c }: { c: ConnectorView }) {
  const look = needsLogin(c)
    ? { text: t("Anmeldung nötig"), cls: "border-a-conf/40 bg-a-conf/10 text-a-conf" }
    : c.auth !== "none" && !c.token.set
      ? { text: t("Token fehlt"), cls: "border-a-conf/40 bg-a-conf/10 text-a-conf" }
      : c.lastTest?.ok
        ? { text: t("{n} Werkzeuge", { n: c.lastTest.tools.length }), cls: "border-a-ok/40 bg-a-ok/10 text-a-ok" }
        : c.lastTest
          ? { text: t("gestört"), cls: "border-a-bad/40 bg-a-bad/10 text-a-bad" }
          : { text: t("noch nicht getestet"), cls: "border-a-wait/40 bg-a-wait/10 text-a-wait" };
  return <span className={cn("inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-label font-medium", look.cls)}>{look.text}</span>;
}

// ─── Eine Karte ───

function ConnectorCard({ c, keyState }: { c: ConnectorView; keyState: SecretsKeyState }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const patch = usePatchConnector();
  const test = useTestConnector();
  const del = useDeleteConnector();
  const device = useStartDeviceLogin();
  const [loginError, setLoginError] = useState<unknown>(null);
  const deviceBusy = device.isPending;
  const bodyId = useId();
  const err = patch.error ?? test.error ?? del.error ?? device.error ?? loginError;
  const allowed = new Set(c.allowedTools ?? []);
  const tools = c.lastTest?.tools ?? [];
  const pending = c.login?.state === "pending";
  // Schalter reagiert sofort; bei Fehler springt er zurück.
  const [enabled, setEnabled] = useState(c.enabled);
  useEffect(() => setEnabled(c.enabled), [c.enabled]);
  const setOn = (on: boolean) => {
    setEnabled(on);
    patch.mutate({ id: c.id, patch: { enabled: on } }, { onError: () => setEnabled(c.enabled) });
  };

  const login = async () => {
    setLoginError(null);
    if (c.auth === "device") return device.mutate(c.id);
    try {
      await startConnectorLogin(c.id);
    } catch (e) {
      setLoginError(e);
    }
  };

  const toggleTool = (name: string, on: boolean) => {
    const next = on ? [...allowed, name] : [...allowed].filter((x) => x !== name);
    patch.mutate({ id: c.id, patch: { allowedTools: next } });
  };

  return (
    <Card className="grid gap-2 p-0" data-connector={c.name}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 text-left" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
          <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", dotFor(c))} />
          <span className="truncate text-callout font-medium text-a-ink">{c.label}</span>
          <span className="font-mono text-label text-a-mut">{TRANSPORT_LABEL[c.transport]}</span>
        </button>
        <StatePill c={c} />
        <label className="flex items-center gap-1.5 text-caption text-a-mut">
          <input type="checkbox" checked={enabled} onChange={(e) => setOn(e.target.checked)} aria-label={t("{name} an/aus", { name: c.label })} />
          {t("Nyx nutzt ihn")}
        </label>
        <Button variant="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? t("Zuklappen") : t("Öffnen")}
        </Button>
      </div>

      {(needsLogin(c) || pending) && !open && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-2.5">
          <Button variant="primary" disabled={deviceBusy || keyState !== "ok"} onClick={() => void login()}>
            {pending ? t("Neuen Link holen") : t("Anmelden")}
          </Button>
          {pending && <DeviceHint c={c} />}
        </div>
      )}

      {open && (
        <div id={bodyId} className="grid gap-3 border-t border-a-line px-3 pb-3 pt-3">
          {c.note && <p className="rounded-md border border-a-wait/30 bg-a-wait/5 px-2.5 py-1.5 text-caption text-a-wait">{c.note}</p>}
          <dl className="grid gap-1 text-caption sm:grid-cols-[10rem_minmax(0,1fr)]">
            <dt className="text-a-mut">{t("Kurzname")}</dt>
            <dd className="font-mono text-a-ink">{c.name}</dd>
            <dt className="text-a-mut">{TRANSPORT_LABEL[c.transport]}</dt>
            <dd className="break-all font-mono text-a-ink">{c.transport === "stdio" ? [c.command, ...c.args].join(" ") : c.url}</dd>
            <dt className="text-a-mut">{t("Anmeldung")}</dt>
            <dd className="text-a-ink">
              {AUTH_LABEL[c.auth]}
              {c.token.set && (
                <span className="text-a-mut">
                  {" · "}
                  {t("gespeichert")}
                  {c.token.last4 ? ` (••••${c.token.last4})` : ""}
                  {c.token.expiresAt ? ` · ${t("gültig bis {date}", { date: new Date(c.token.expiresAt).toLocaleString(locale(), { dateStyle: "short", timeStyle: "short", timeZone: timeZone() }) })}` : ""}
                </span>
              )}
            </dd>
          </dl>
          {c.tokenHint && <p className="text-caption text-a-mut">{c.tokenHint}</p>}

          {(c.auth === "oauth" || c.auth === "device") && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant={c.token.set ? "default" : "primary"} disabled={deviceBusy || keyState !== "ok"} onClick={() => void login()}>
                {c.token.set ? t("Neu anmelden") : pending ? t("Neuen Link holen") : t("Anmelden")}
              </Button>
              {pending && <DeviceHint c={c} />}
              {c.login?.state === "failed" && <span className="text-caption text-a-bad">{c.login.message}</span>}
            </div>
          )}
          {c.auth !== "none" && c.auth !== "oauth" && c.auth !== "device" && (
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <label className="grid gap-1">
                <span className={LABEL}>{t("Token")}</span>
                <input
                  className={cn(FIELD, "font-mono")}
                  type="password"
                  autoComplete="off"
                  value={token}
                  disabled={keyState !== "ok"}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={c.token.set ? t("gespeichert (••••{last4}) – leer lassen = unverändert", { last4: c.token.last4 ?? "" }) : t("hier einfügen")}
                />
              </label>
              <Button variant="primary" disabled={!token.trim() || patch.isPending} onClick={() => patch.mutate({ id: c.id, patch: { token: token.trim() } }, { onSuccess: () => setToken("") })}>
                {t("Speichern")}
              </Button>
            </div>
          )}

          <div className="grid gap-2 rounded-lg border border-a-line bg-a-bg/40 p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={test.isPending} onClick={() => test.mutate(c.id)}>
                {test.isPending ? t("Teste …") : t("Test (Werkzeuge auflisten)")}
              </Button>
              {c.lastTest && (
                <span className={cn("text-caption", c.lastTest.ok ? "text-a-ok" : "text-a-bad")} data-testid={`mcp-test-${c.name}`}>
                  {c.lastTest.message} <span className="text-a-mut">· {c.lastTest.ms} ms</span>
                </span>
              )}
            </div>
            {tools.length > 0 && (
              <div className="grid gap-1.5">
                <p className="text-caption text-a-mut">{t("Nyx nutzt nur angehakte Werkzeuge. Neue Werkzeuge bleiben aus, bis du sie freigibst.")}</p>
                <ul className="grid gap-1">
                  {tools.map((tool) => {
                    const on = allowed.has(tool.name);
                    const isNew = c.allowedTools !== null && !on;
                    return (
                      <li key={tool.name} className="flex min-w-0 items-start gap-2 rounded-md px-1.5 py-1 hover:bg-a-p2">
                        <input type="checkbox" className="mt-0.5" checked={on} disabled={patch.isPending} onChange={(e) => toggleTool(tool.name, e.target.checked)} aria-label={t("Werkzeug {name}", { name: tool.name })} />
                        <div className="min-w-0">
                          <span className="font-mono text-caption text-a-ink">{tool.name}</span>
                          {isNew && <span className="ml-1.5 rounded-full border border-a-wait/40 px-1.5 text-label text-a-wait">{t("neu · aus")}</span>}
                          {tool.description && <p className="line-clamp-2 text-caption text-a-mut">{tool.description}</p>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
          <div>
            <Button variant="warn" disabled={del.isPending} onClick={() => window.confirm(t("Konnektor „{name}“ wirklich entfernen? Die Anmeldung wird mit gelöscht.", { name: c.label })) && del.mutate(c.id)}>
              {t("Entfernen")}
            </Button>
          </div>
          {err ? <p className="text-caption text-a-bad">{friendlyError(err)}</p> : null}
        </div>
      )}
    </Card>
  );
}

function DeviceHint({ c }: { c: ConnectorView }) {
  if (!c.login) return null;
  return (
    <span className="text-caption text-a-mut" role="status">
      {t("Warte auf deine Bestätigung …")}{" "}
      {c.login.verificationUri && (
        <a className="text-a-acc underline" href={c.login.verificationUri} target="_blank" rel="noreferrer noopener">
          {t("Link öffnen")}
        </a>
      )}
      {c.login.userCode && <span className="ml-1 font-mono text-a-ink">{t("Code {code}", { code: c.login.userCode })}</span>}
    </span>
  );
}

// ─── Hinzufügen ───

function fromTemplate(tpl: McpTemplate | null): ConnectorSave {
  if (!tpl) return { name: "", label: "", transport: "http", url: "", auth: "bearer" };
  return { name: tpl.id, label: tpl.label, template: tpl.id, transport: tpl.transport, url: tpl.url ?? null, command: tpl.command ?? null, args: tpl.args ?? [], auth: tpl.auth, authName: tpl.authName ?? null, authConfig: tpl.authConfig ?? null };
}

function AddConnector({ templates, taken, keyState, onDone }: { templates: McpTemplate[]; taken: Set<string>; keyState: SecretsKeyState; onDone: () => void }) {
  const [tpl, setTpl] = useState<McpTemplate | null | undefined>(undefined);
  const [form, setForm] = useState<ConnectorSave>(fromTemplate(null));
  const [argsText, setArgsText] = useState("");
  const create = useCreateConnector();
  useEffect(() => {
    if (tpl === undefined) return;
    const f = fromTemplate(tpl);
    setForm(f);
    setArgsText((f.args ?? []).join(" "));
  }, [tpl]);
  const set = (p: Partial<ConnectorSave>) => setForm((f) => ({ ...f, ...p }));
  const submit = () =>
    create.mutate(
      { ...form, args: argsText.trim() ? argsText.trim().split(/\s+/) : [], url: form.transport === "stdio" ? null : form.url || null, command: form.transport === "stdio" ? form.command : null, ...(form.token?.trim() ? { token: form.token.trim() } : { token: undefined }) },
      { onSuccess: onDone },
    );

  return (
    <Card className="grid gap-3 p-3">
      <div className="grid gap-1.5">
        <span className={LABEL}>{t("Vorlage")}</span>
        <div className="flex flex-wrap gap-1.5">
          {templates.map((tp) => (
            <button
              key={tp.id}
              type="button"
              disabled={taken.has(tp.id)}
              onClick={() => setTpl(tp)}
              className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption text-a-ink hover:border-a-acc disabled:opacity-40", tpl?.id === tp.id ? "border-a-acc bg-a-acc/10" : "border-a-line bg-a-p2")}
              title={taken.has(tp.id) ? t("schon angelegt") : tp.description}
            >
              <span className={cn("h-2 w-2 rounded-full", dotFor({ template: tp.id }))} />
              {tp.label}
            </button>
          ))}
          <button type="button" onClick={() => setTpl(null)} className={cn("rounded-full border px-2.5 py-1 text-caption text-a-ink hover:border-a-acc", tpl === null ? "border-a-acc bg-a-acc/10" : "border-a-line bg-a-p2")}>
            {t("Eigener Konnektor")}
          </button>
        </div>
      </div>
      {tpl !== undefined && (
        <>
          {tpl?.description && <p className="text-caption text-a-mut">{tpl.description}</p>}
          {tpl?.note && <p className="rounded-md border border-a-wait/30 bg-a-wait/5 px-2.5 py-1.5 text-caption text-a-wait">{tpl.note}</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1">
              <span className={LABEL}>{t("Name")}</span>
              <input className={FIELD} value={form.label} onChange={(e) => set({ label: e.target.value })} placeholder={t("z. B. Mein Werkzeug")} />
            </label>
            <label className="grid gap-1">
              <span className={LABEL}>{t("Kurzname (klein, ohne Leerzeichen)")}</span>
              <input className={cn(FIELD, "font-mono")} value={form.name} onChange={(e) => set({ name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} placeholder={t("mein-werkzeug")} />
            </label>
          </div>
          <label className="grid gap-1">
            <span className={LABEL}>{tc("connectors", "Art")}</span>
            <select className={FIELD} value={form.transport} onChange={(e) => set({ transport: e.target.value as McpTransport })}>
              <option value="http">{t("Adresse (HTTP)")}</option>
              <option value="sse">{t("Adresse (SSE, älterer Weg)")}</option>
              <option value="stdio">{t("Befehl (läuft im Nyx-Motor)")}</option>
            </select>
          </label>
          {form.transport === "stdio" ? (
            <div className="grid gap-2 sm:grid-cols-[12rem_minmax(0,1fr)]">
              <label className="grid gap-1">
                <span className={LABEL}>{t("Befehl")}</span>
                <input className={cn(FIELD, "font-mono")} value={form.command ?? ""} onChange={(e) => set({ command: e.target.value })} placeholder="npx" />
              </label>
              <label className="grid gap-1">
                <span className={LABEL}>{t("Argumente")}</span>
                <input className={cn(FIELD, "font-mono")} value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder={t("-y paket@version")} />
              </label>
            </div>
          ) : (
            <label className="grid gap-1">
              <span className={LABEL}>{t("Adresse")}</span>
              <input className={cn(FIELD, "font-mono")} value={form.url ?? ""} onChange={(e) => set({ url: e.target.value })} placeholder="https://…/mcp" />
            </label>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1">
              <span className={LABEL}>{t("Anmeldung")}</span>
              <select className={FIELD} value={form.auth} onChange={(e) => set({ auth: e.target.value as McpAuth })}>
                {(Object.keys(AUTH_LABEL) as McpAuth[])
                  .filter((a) => (a === "device" ? form.auth === "device" : true))
                  .map((a) => (
                    <option key={a} value={a}>
                      {AUTH_LABEL[a]}
                    </option>
                  ))}
              </select>
            </label>
            {(form.auth === "header" || form.auth === "env") && (
              <label className="grid gap-1">
                <span className={LABEL}>{form.auth === "env" ? t("Name der Variable") : t("Name der Kopfzeile")}</span>
                <input className={cn(FIELD, "font-mono")} value={form.authName ?? ""} onChange={(e) => set({ authName: e.target.value })} placeholder={form.auth === "env" ? "API_KEY" : "X-Api-Key"} />
              </label>
            )}
          </div>
          {form.auth !== "none" && form.auth !== "oauth" && form.auth !== "device" && (
            <label className="grid gap-1">
              <span className={LABEL}>{t("Token")}</span>
              <input className={cn(FIELD, "font-mono")} type="password" autoComplete="off" disabled={keyState !== "ok"} value={form.token ?? ""} onChange={(e) => set({ token: e.target.value })} placeholder={keyState !== "ok" ? t("erst nach dem nächsten Deploy möglich") : (tpl?.tokenHint ?? t("hier einfügen"))} />
            </label>
          )}
          {(form.auth === "oauth" || form.auth === "device") && <p className="text-caption text-a-mut">{t("Nach dem Anlegen „Anmelden“ drücken – erst danach zeigt der Test die Werkzeuge.")}</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={create.isPending || !form.name || !form.label} onClick={submit}>
              {create.isPending ? t("Lege an …") : t("Anlegen")}
            </Button>
            <Button variant="ghost" onClick={onDone}>
              {t("Abbrechen")}
            </Button>
          </div>
          {create.isError && <p className="text-caption text-a-bad">{friendlyError(create.error)}</p>}
        </>
      )}
    </Card>
  );
}

export function ConnectorsPanel() {
  const q = useConnectors();
  const [adding, setAdding] = useState(false);
  const data = q.data;
  const anyPending = data?.connectors.some((c) => c.login?.state === "pending") ?? false;
  const { refetch } = q;

  // Während einer Anmeldung öfter nachsehen; Rückkehr aus dem Browser-Fenster meldet sich sofort.
  useEffect(() => {
    if (!anyPending) return;
    const timer = setInterval(() => void refetch(), 3000);
    return () => clearInterval(timer);
  }, [anyPending, refetch]);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin === window.location.origin && (e.data as { type?: string } | null)?.type === "nyxos-mcp-oauth") void refetch();
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [refetch]);

  return (
    <section className="grid scroll-mt-4 gap-2" data-nyx-risk="">
      <SectionTitle>{t("Konnektoren")}</SectionTitle>
      <p className="text-callout text-a-mut">{t("Zusätzliche Werkzeuge für Nyx (MCP) – z. B. Bilder mit Higgsfield erzeugen oder GitHub lesen. Eingeschaltete Konnektoren nutzt Nyx im Chat, abgeschaltete nie.")}</p>
      {data && <KeyNotice state={data.secretsKey} />}
      {q.isLoading && <Skeleton className="h-24 w-full" />}
      {q.isError && (
        <Card className="grid gap-2 p-3">
          <p className="text-callout text-a-wait">{friendlyError(q.error)}</p>
          <Button className="w-fit" onClick={() => void refetch()}>
            {t("Erneut versuchen")}
          </Button>
        </Card>
      )}
      {data && (
        <div className="grid gap-2">
          {data.connectors.length === 0 && !adding && <p className="rounded-lg border border-dashed border-a-line px-3 py-4 text-center text-caption text-a-mut">{t("Noch kein Konnektor. Unten aus einer Vorlage anlegen – Higgsfield ist die erste.")}</p>}
          {data.connectors.map((c) => (
            <ConnectorCard key={c.id} c={c} keyState={data.secretsKey} />
          ))}
          {adding ? (
            <AddConnector templates={data.templates} taken={new Set(data.connectors.map((c) => c.name))} keyState={data.secretsKey} onDone={() => setAdding(false)} />
          ) : (
            <Button className="w-fit" onClick={() => setAdding(true)}>
              {t("+ Konnektor hinzufügen")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
