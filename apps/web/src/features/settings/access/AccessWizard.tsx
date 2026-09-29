// „Alles auf einmal einrichten“. Ein Blatt mit allen fehlenden Zugängen: oben alles auf einmal einfügen
// (erkennt die Art am Anfang des Schlüssels oder am Namen, z. B. OPENAI_API_KEY=…), darunter je Zugang ein Feld
// mit Link zur offiziellen Seite. Leere Felder werden übersprungen. Danach: Zusammenfassung mit Prüf-Ergebnis.
import { ACCESS_ITEMS, accessItem, t, detectCredentials, isEditableAccess, type AccessBulkResult, type AccessId, type AccessStatus } from "@nyxos/shared";
import { useMemo, useState } from "react";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/cn";
import { friendlyError } from "../../../lib/friendlyError";
import { FIELD, LABEL } from "../fieldStyles";
import { useBulkAccess } from "./accessApi";
import { StatePill } from "./AccessStatePill";

export function AccessWizard({ items, onClose }: { items: AccessStatus[]; onClose: () => void }) {
  const byId = useMemo(() => new Map(items.map((s) => [s.id, s])), [items]);
  const [showAll, setShowAll] = useState(false);
  const [values, setValues] = useState<Partial<Record<AccessId, string>>>({});
  const [paste, setPaste] = useState("");
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const [result, setResult] = useState<AccessBulkResult | null>(null);
  const bulk = useBulkAccess();

  const editable = ACCESS_ITEMS.filter(isEditableAccess);
  const needed = (id: AccessId) => {
    const s = byId.get(id)?.state;
    return s === "missing" || s === "error";
  };
  // Kern-Zugänge zuerst, dann der Rest.
  const shown = editable.filter((i) => showAll || needed(i.id) || values[i.id]).sort((a, b) => Number(!!b.core) - Number(!!a.core));
  const filled = editable.filter((i) => values[i.id]?.trim());

  const applyPaste = (text: string) => {
    const found = detectCredentials(text);
    if (!found.length) {
      setPasteNote(t("Nichts erkannt. Einfach einzeln in die Felder unten einfügen."));
      return;
    }
    setValues((v) => {
      const next = { ...v };
      for (const f of found) if (isEditableAccess(accessItem(f.id))) next[f.id] = f.value;
      return next;
    });
    const labels = found.filter((f) => isEditableAccess(accessItem(f.id))).map((f) => accessItem(f.id).label);
    const elsewhere = found.filter((f) => !isEditableAccess(accessItem(f.id))).map((f) => accessItem(f.id).label);
    const recognized = t("Erkannt: {list}.", { list: labels.join(", ") || "–" });
    setPasteNote(elsewhere.length ? `${recognized} ${t("{list} bitte an der verlinkten Stelle eintragen.", { list: elsewhere.join(", ") })}` : recognized);
    setPaste("");
  };

  const submit = async () => {
    const entries = filled.map((i) => ({ id: i.id, value: (values[i.id] as string).trim() }));
    const r = await bulk.mutateAsync(entries);
    setResult(r);
    // Gespeicherte Werte sofort aus dem Speicher des Browsers nehmen.
    const saved = new Set(r.results.filter((x) => x.saved).map((x) => x.id));
    setValues((v) => Object.fromEntries(Object.entries(v).filter(([id]) => !saved.has(id as AccessId))));
  };

  if (result) {
    const ok = result.results.filter((r) => r.saved && r.check?.ok !== false).length;
    return (
      <Card className="grid gap-3 border-a-acc/40 p-3" aria-label={t("Zusammenfassung")}>
        <b className="text-callout font-semibold text-a-ink">
          {t("Fertig – {ok} von {n} eingerichtet", { ok, n: result.results.length })}
        </b>
        <ul className="grid gap-1.5">
          {result.results.map((r) => {
            const good = r.saved && r.check?.ok !== false;
            return (
              <li key={r.id} className="grid gap-0.5 rounded-lg border border-a-line px-2.5 py-2" data-testid={`wizard-result-${r.id}`}>
                <span className="flex items-center gap-2 text-callout text-a-ink">
                  <span className={good ? "text-a-ok" : "text-a-bad"}>{good ? "✓" : "✗"}</span>
                  {accessItem(r.id).label}
                </span>
                <span className={cn("text-caption", good ? "text-a-mut" : "text-a-bad")}>{r.error ?? r.check?.message ?? t("gespeichert")}</span>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setResult(null)}>{t("Weitere eintragen")}</Button>
          <Button variant="primary" onClick={onClose}>
            {t("Schließen")}
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="grid gap-4 border-a-acc/40 p-3" aria-label={t("Alles auf einmal einrichten")} data-nyx-risk="">
      <div className="grid gap-1">
        <b className="text-callout font-semibold text-a-ink">{t("Alles auf einmal einrichten")}</b>
        <p className="text-caption text-a-mut">{t("Füll aus, was du hast – leere Felder werden übersprungen. Am Ende prüft NyxOS jeden Zugang einmal.")}</p>
      </div>

      <label className="grid gap-1">
        <span className={LABEL}>{t("Schlau einfügen (mehrere Schlüssel auf einmal)")}</span>
        <textarea
          className={cn(FIELD, "min-h-20 font-mono")}
          value={paste}
          spellCheck={false}
          autoComplete="off"
          placeholder={`${t("z. B. eine Liste oder .env-Zeilen:")}\nsk-ant-…\nOPENAI_API_KEY=sk-proj-…\n123456789:ABC…`}
          onChange={(e) => setPaste(e.target.value)}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (text && detectCredentials(text).length) {
              e.preventDefault();
              applyPaste(text);
            }
          }}
          aria-label={t("Mehrere Schlüssel einfügen")}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={!paste.trim()} onClick={() => applyPaste(paste)}>
            {t("Erkennen")}
          </Button>
          {pasteNote && (
            <span className="text-caption text-a-mut" data-testid="wizard-paste-note">
              {pasteNote}
            </span>
          )}
        </div>
      </label>

      <ol className="grid gap-3">
        {shown.map((item, i) => {
          const s = byId.get(item.id);
          return (
            <li key={item.id} className="grid gap-1.5 rounded-lg border border-a-line p-2.5" data-wizard-item={item.id}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono text-label text-a-mut">{i + 1}.</span>
                <span className="text-callout font-medium text-a-ink">{item.label}</span>
                {s && <StatePill state={s.state} />}
                <a href={item.link.url} target="_blank" rel="noopener noreferrer" className="ml-auto text-caption text-a-acc underline-offset-2 hover:underline">
                  {item.link.label} ↗
                </a>
              </div>
              <p className="text-caption text-a-mut">{item.purpose}</p>
              <input
                className={cn(FIELD, "font-mono")}
                type={item.storage === "provider-url" ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={values[item.id] ?? ""}
                disabled={!!s?.blocked}
                placeholder={s?.blocked ? t("erst nach dem nächsten Deploy möglich") : (item.placeholder ?? t("hier einfügen"))}
                onChange={(e) => setValues((v) => ({ ...v, [item.id]: e.target.value }))}
                aria-label={t("{label}: Wert", { label: item.label })}
              />
            </li>
          );
        })}
        {shown.length === 0 && <li className="text-callout text-a-mut">{t("Alles eingerichtet. Mit „Alle zeigen“ kannst du vorhandene Zugänge ersetzen.")}</li>}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={!filled.length || bulk.isPending} onClick={() => void submit().catch(() => {})}>
          {bulk.isPending
            ? t("Speichere und prüfe …")
            : filled.length === 0
              ? t("Zugänge speichern + prüfen")
              : filled.length === 1
                ? t("1 Zugang speichern + prüfen")
                : t("{n} Zugänge speichern + prüfen", { n: filled.length })}
        </Button>
        <Button variant="ghost" onClick={() => setShowAll((v) => !v)}>
          {showAll ? t("Nur fehlende zeigen") : t("Alle zeigen")}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t("Abbrechen")}
        </Button>
      </div>
      {bulk.isError && <p className="text-caption text-a-bad">{friendlyError(bulk.error)}</p>}
    </Card>
  );
}
