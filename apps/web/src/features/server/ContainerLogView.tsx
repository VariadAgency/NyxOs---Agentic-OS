// Logs eines Containers, aufgeklappt direkt unter seiner Zeile (von oben nach unten, keine
// Seitenspalte). Letzte 200 Zeilen über den Lese-Proxy, filterbar; live mitlesen in Dozzle.
import { locale, t, timeZone } from "@nyxos/shared";
import { friendlyError } from "../../lib/friendlyError";
import { ErrorDetails } from "../../components/ErrorDetails";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { fetchContainerLogs } from "../../lib/api";
import { cn } from "../../lib/cn";
import { useAuthStatus } from "../../hooks/useAuthStatus";
import { openLoginDialog } from "../terminal/authClient";

const timeFmt = new Intl.DateTimeFormat(locale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: timeZone() });

function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const parts: Array<{ t: string; hit: boolean }> = [];
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  let i = 0;
  for (;;) {
    const j = lower.indexOf(n, i);
    if (j === -1) break;
    if (j > i) parts.push({ t: text.slice(i, j), hit: false });
    parts.push({ t: text.slice(j, j + n.length), hit: true });
    i = j + n.length;
  }
  if (i < text.length) parts.push({ t: text.slice(i), hit: false });
  return (
    <>
      {parts.map((p, k) =>
        p.hit ? (
          <mark key={k} className="rounded-sm bg-a-wait/30 text-a-ink">
            {p.t}
          </mark>
        ) : (
          <span key={k}>{p.t}</span>
        ),
      )}
    </>
  );
}

export function ContainerLogView({ id, name, dozzleUrl }: { id: string; name: string; dozzleUrl: string | null }) {
  const [filter, setFilter] = useState("");
  const [onlyErr, setOnlyErr] = useState(false);
  // Logs nur mit Anmeldung. Ohne Anmeldung gar nicht erst abfragen (die Anfrage würde auf den
  // Anmelde-Dialog warten und „Lädt …“ bliebe stehen), sondern „Bitte anmelden“ zeigen.
  const auth = useAuthStatus();
  const signedOut = auth.data?.authenticated === false;
  const logs = useQuery({ queryKey: ["server", "logs", id], queryFn: () => fetchContainerLogs(id, 200), staleTime: 5_000, retry: false, enabled: auth.data?.authenticated === true });
  const lines = useMemo(() => {
    const all = logs.data?.lines ?? [];
    const n = filter.trim().toLowerCase();
    return all.filter((l) => (!onlyErr || l.stream === "err") && (!n || l.text.toLowerCase().includes(n)));
  }, [logs.data, filter, onlyErr]);
  const total = logs.data?.lines.length ?? 0;
  const dozzleLink = dozzleUrl ? `${dozzleUrl.replace(/\/?$/, "/")}show?name=${encodeURIComponent(name)}` : null;

  return (
    <div className="grid gap-2 rounded-lg border border-a-line bg-a-bg/60 p-3" data-testid={`logs-${name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-label uppercase tracking-wider text-a-mut">{t("Logs · letzte 200 Zeilen")}</span>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("Filtern …")}
          aria-label={t("Logs von {name} filtern", { name })}
          className="h-(--a-ctl-h) min-w-0 flex-1 rounded-md border border-a-line bg-a-p px-2 text-caption text-a-ink placeholder:text-a-mut focus:border-a-acc focus:outline-none sm:max-w-64"
        />
        <label className="flex cursor-pointer select-none items-center gap-1.5 text-caption text-a-mut">
          <input type="checkbox" checked={onlyErr} onChange={(e) => setOnlyErr(e.target.checked)} className="accent-(--a-bad)" />
          {t("nur Fehlerausgabe")}
        </label>
        <button type="button" onClick={() => void logs.refetch()} className="h-(--a-ctl-h) rounded-md border border-a-line px-2.5 text-caption text-a-ink transition-colors duration-150 hover:bg-a-p2">
          {t("Neu laden")}
        </button>
        {dozzleLink && (
          <a href={dozzleLink} target="_blank" rel="noreferrer" className="h-(--a-ctl-h) content-center rounded-md border border-a-acc/40 px-2.5 text-caption text-a-acc transition-colors duration-150 hover:bg-a-acc/10">
            {t("Live mitlesen (Dozzle)")} ↗
          </a>
        )}
      </div>
      {signedOut ? (
        <div className="flex flex-wrap items-center gap-2 text-caption text-a-wait">
          <span>{t("Bitte anmelden – Logs können Zugangsdaten enthalten und sind nur nach der Anmeldung sichtbar.")}</span>
          <button type="button" onClick={() => openLoginDialog()} className="rounded-md border border-a-acc/50 px-2 py-0.5 text-a-acc hover:bg-a-acc/10">
            {t("Mit Touch ID anmelden")}
          </button>
        </div>
      ) : logs.isPending ? (
        <p className="text-caption text-a-mut">{t("Lädt die letzten Zeilen …")}</p>
      ) : logs.isError ? (
        <div className="flex flex-wrap items-center gap-2 text-caption text-a-wait">
          <span>{friendlyError(logs.error, t("Die Logs sind gerade nicht lesbar."))}</span>
          <button type="button" onClick={() => void logs.refetch()} className="rounded-md border border-a-line px-2 py-0.5 text-a-ink hover:bg-a-p2">
            {t("Erneut versuchen")}
          </button>
          <ErrorDetails error={logs.error} />
        </div>
      ) : total === 0 ? (
        <p className="text-caption text-a-mut">{t("Dieser Container hat noch nichts ausgegeben.")}</p>
      ) : (
        <>
          <ol className="max-h-[420px] overflow-auto rounded-md border border-a-line/60 bg-a-p/60 py-1 font-mono text-caption leading-5" aria-label={t("Logs von {name}", { name })}>
            {lines.map((l, i) => (
              <li key={i} className={cn("grid grid-cols-[auto_minmax(0,1fr)] gap-3 px-2.5 hover:bg-a-p2", l.stream === "err" && "bg-a-bad/5")}>
                <span className="whitespace-nowrap text-a-mut tabular-nums">{l.at ? timeFmt.format(new Date(l.at)) : ""}</span>
                <span className={cn("whitespace-pre-wrap break-all", l.stream === "err" ? "text-a-bad" : "text-a-ink")}>
                  <Highlight text={l.text} needle={filter.trim()} />
                </span>
              </li>
            ))}
            {lines.length === 0 && <li className="px-2.5 text-a-mut">{t("Keine Zeile passt zum Filter.")}</li>}
          </ol>
          <span className="text-label text-a-mut">
            {filter || onlyErr ? t("{shown} von {total} Zeilen (gefiltert)", { shown: lines.length, total }) : t("{shown} von {total} Zeilen", { shown: lines.length, total })}
          </span>
        </>
      )}
    </div>
  );
}
