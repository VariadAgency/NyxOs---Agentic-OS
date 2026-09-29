// Modell-Wähler mit genauen Kennungen. Suche, Filter nach Anbieter, nach Anbieter gruppiert; je Modell Name
// mit Version, genaue Kennung, Kontextfenster, Preis pro 1 Mio. Token (Eingabe/Ausgabe), Tempo und Stärke.
// Modelle von Anbietern ohne Zugang sind sichtbar, aber nicht wählbar (Hinweis → Zugänge).
import { formatContext, formatPrice, isEmbeddingModel, t, type ModelChoice } from "@nyxos/shared";
import { useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { friendlyError } from "../../lib/friendlyError";
import { useModelCatalog } from "./access/accessApi";
import { FIELD } from "./fieldStyles";

const MAX_PER_GROUP = 60;

export function ModelPicker({ selected, onPick, onClose }: { selected: { providerId: string; model: string } | null; onPick: (m: ModelChoice) => void; onClose: () => void }) {
  const catalog = useModelCatalog();
  const [q, setQ] = useState("");
  const [provider, setProvider] = useState<string>("");
  const [onlyUsable, setOnlyUsable] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const all = useMemo(() => (catalog.data?.models ?? []).filter((m) => !isEmbeddingModel(m.id)), [catalog.data]);
  const providers = useMemo(() => {
    const seen = new Map<string, { label: string; count: number; usable: boolean }>();
    for (const m of all) {
      const p = seen.get(m.providerId) ?? { label: m.providerLabel, count: 0, usable: m.usable };
      p.count++;
      seen.set(m.providerId, p);
    }
    return [...seen.entries()];
  }, [all]);
  const needle = q.trim().toLowerCase();
  const list = all.filter((m) => (!provider || m.providerId === provider) && (!onlyUsable || m.usable) && (!needle || `${m.name} ${m.id} ${m.providerLabel} ${m.strength ?? ""}`.toLowerCase().includes(needle)));
  const groups = new Map<string, ModelChoice[]>();
  for (const m of list) groups.set(m.providerId, [...(groups.get(m.providerId) ?? []), m]);
  // Nutzbare Anbieter zuerst.
  const ordered = [...groups.entries()].sort((a, b) => Number(b[1][0]?.usable) - Number(a[1][0]?.usable));

  return (
    <div className="grid gap-2 rounded-lg border border-a-line bg-a-bg/40 p-2.5" data-testid="model-picker">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <input className={FIELD} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Suchen: Name, Kennung, Anbieter …")} aria-label={t("Modell suchen")} autoFocus />
        <label className="flex items-center gap-1.5 text-caption text-a-mut">
          <input type="checkbox" checked={onlyUsable} onChange={(e) => setOnlyUsable(e.target.checked)} />
          {t("nur mit Zugang")}
        </label>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("Anbieter filtern")}>
        <button type="button" onClick={() => setProvider("")} className={cn("rounded-full border px-2.5 py-0.5 text-caption", provider === "" ? "border-a-acc bg-a-acc/10 text-a-ink" : "border-a-line text-a-mut hover:text-a-ink")}>
          {t("Alle · {n}", { n: all.length })}
        </button>
        {providers.map(([id, p]) => (
          <button key={id} type="button" onClick={() => setProvider(id === provider ? "" : id)} className={cn("rounded-full border px-2.5 py-0.5 text-caption", provider === id ? "border-a-acc bg-a-acc/10 text-a-ink" : "border-a-line text-a-mut hover:text-a-ink", !p.usable && "opacity-70")}>
            {p.label} · {p.count}
          </button>
        ))}
      </div>

      {catalog.isLoading && <Skeleton className="h-32 w-full" />}
      {catalog.isError && <p className="text-caption text-a-wait">{friendlyError(catalog.error)}</p>}
      {catalog.data && list.length === 0 && <p className="px-1 py-2 text-callout text-a-mut">{t("Kein Modell passt zur Suche.")}</p>}

      <div className="grid max-h-[28rem] gap-3 overflow-y-auto pr-1">
        {ordered.map(([pid, models]) => {
          const first = models[0] as ModelChoice;
          const open = expanded.has(pid) || !!needle;
          const visible = open ? models : models.slice(0, MAX_PER_GROUP);
          return (
            <section key={pid} className="grid gap-1" aria-label={first.providerLabel}>
              <h4 className="flex items-center gap-2 px-1 text-caption font-semibold text-a-ink">
                {first.providerLabel}
                <span className="font-normal text-a-mut">
                  {t("{n} Modelle", { n: models.length })}
                  {first.usable ? "" : ` · ${t("Zugang fehlt (Einstellungen → Zugänge & Schlüssel)")}`}
                </span>
              </h4>
              <ul className="grid gap-1">
                {visible.map((m) => {
                  const isSel = selected?.providerId === m.providerId && selected.model === m.id;
                  const ctx = formatContext(m.context);
                  const price = formatPrice(m);
                  return (
                    <li key={`${m.providerId}:${m.id}`}>
                      <button
                        type="button"
                        disabled={!m.usable}
                        onClick={() => onPick(m)}
                        className={cn(
                          "grid w-full gap-0.5 rounded-lg border px-2.5 py-2 text-left transition-colors duration-150",
                          isSel ? "border-a-acc bg-a-acc/10" : "border-a-line hover:bg-a-p2",
                          !m.usable && "cursor-not-allowed opacity-60 hover:bg-transparent",
                        )}
                        data-model={m.id}
                        title={m.usable ? t("{name} wählen", { name: m.name }) : t("Für diesen Anbieter fehlt noch der Zugang")}
                      >
                        <span className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-callout font-medium text-a-ink">{m.name}</span>
                          <span className="font-mono text-label text-a-mut">{m.id}</span>
                          {m.source === "live" && <span className="text-label text-a-ok">{t("live")}</span>}
                        </span>
                        <span className="flex flex-wrap gap-x-3 text-caption text-a-mut">
                          {ctx && <span>{t("Kontext {ctx}", { ctx })}</span>}
                          {price && <span>{t("{price} pro 1 Mio. Token (ein/aus)", { price })}</span>}
                          {m.speed && <span>{m.speed}</span>}
                        </span>
                        {m.strength && <span className="text-caption text-a-mut">{m.strength}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {!open && models.length > MAX_PER_GROUP && (
                <Button variant="ghost" className="w-fit" onClick={() => setExpanded((s) => new Set(s).add(pid))}>
                  {t("Alle {n} zeigen", { n: models.length })}
                </Button>
              )}
            </section>
          );
        })}
      </div>
      <Button variant="ghost" className="w-fit" onClick={onClose}>
        {t("Schließen")}
      </Button>
    </div>
  );
}
