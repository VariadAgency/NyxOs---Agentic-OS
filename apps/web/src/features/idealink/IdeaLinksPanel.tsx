// Ideen-Links, Route `/einstellungen/ideen-links`. Je Person ein Link zur Mini-Seite mit
// Haiku-Chat (nur Ideen suchen/anlegen). Die URL mit Token zeigt der Server GENAU EINMAL beim Anlegen
// (gespeichert ist nur der Hash) — deshalb der große Kopieren-Block direkt danach.
import { friendlyError } from "../../lib/friendlyError";
import { locale, t, timeZone, type IdeaLink, type IdeaLinkCreated } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { formatDateTime, relativeTime } from "../../lib/format";
import { createIdeaLink, fetchIdeaLinks, revokeIdeaLink } from "../haiku/haikuApi";
import { ErrorBox, FIELD, LABEL, riseStyle } from "../haiku/ui";

const EXPIRY_DAYS = [7, 30, 90] as const;
const RATES = [5, 10, 20] as const;

type LinkState = "aktiv" | "abgelaufen" | "widerrufen";

function linkState(link: IdeaLink, now = Date.now()): LinkState {
  if (link.revokedAt) return "widerrufen";
  if (!link.active || Date.parse(link.expiresAt) <= now) return "abgelaufen";
  return "aktiv";
}

const STATE_LABEL: Record<LinkState, string> = { aktiv: t("aktiv"), abgelaufen: t("abgelaufen"), widerrufen: t("widerrufen") };

const STATE_STYLE: Record<LinkState, string> = {
  aktiv: "bg-a-ok/10 text-a-ok",
  abgelaufen: "bg-a-p3 text-a-mut",
  widerrufen: "bg-a-bad/10 text-a-bad",
};

function dateOnly(iso: string): string {
  return new Date(iso).toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric", timeZone: timeZone() });
}

export function IdeaLinksPanel() {
  const qc = useQueryClient();
  const links = useQuery({ queryKey: ["idealinks"], queryFn: fetchIdeaLinks });
  const [name, setName] = useState("");
  const [days, setDays] = useState<number>(30);
  const [rate, setRate] = useState<number>(10);
  const [created, setCreated] = useState<IdeaLinkCreated | null>(null);

  const create = useMutation({
    mutationFn: () => createIdeaLink({ name: name.trim(), expiresInDays: days, ratePerHour: rate }),
    onSuccess: (res) => {
      setCreated(res);
      setName("");
      void qc.invalidateQueries({ queryKey: ["idealinks"] });
    },
  });

  return (
    <div className="grid w-full min-w-0 content-start gap-4 p-4 md:p-6" data-nyx-risk="">
      <header className="grid gap-1">
        <h1 className="font-display text-title2 font-bold text-a-ink">{t("Ideen-Links")}</h1>
        <p className="text-callout leading-relaxed text-a-mut">
          {t("Ein Link pro Person: Wer ihn hat, kann Nyx eine Idee erzählen. Nyx prüft, ob es sie schon gibt, und legt sonst eine neue Idee im Eingang an. Mehr sieht die Person nicht.")}
        </p>
        <p className="w-fit rounded-md border border-a-wait/30 bg-a-wait/10 px-2 py-1 text-caption text-a-wait">
          {t("Der Link funktioniert im Tailnet (Handy mit Tailscale). Öffentlich erreichbar ist er erst, wenn du NyxOS öffentlich freigibst.")}
        </p>
      </header>

      <form
        className="cc-card grid min-w-0 gap-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <h2 className="font-display text-headline font-semibold text-a-ink">{t("Neuen Link anlegen")}</h2>
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <label className="grid min-w-0 gap-1">
            <span className={LABEL}>{t("Name")}</span>
            <input className={FIELD} value={name} maxLength={60} placeholder={t("z. B. Lena")} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="grid min-w-0 gap-1">
            <span className={LABEL}>{t("Ablauf")}</span>
            <select className={FIELD} value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {EXPIRY_DAYS.map((d) => (
                <option key={d} value={d}>
                  {t("{n} Tage", { n: d })}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-1">
            <span className={LABEL}>{t("Anfragen pro Stunde")}</span>
            <select className={FIELD} value={rate} onChange={(e) => setRate(Number(e.target.value))}>
              {RATES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={!name.trim() || create.isPending}
            className="rounded-lg border border-transparent bg-a-primary px-3 py-1.5 text-caption font-semibold text-a-on-primary hover:brightness-110 disabled:opacity-40"
          >
            {create.isPending ? t("Legt an …") : t("Link anlegen")}
          </button>
          {create.isError && <span className="text-caption text-a-bad">{t("Link konnte nicht angelegt werden.")} {friendlyError(create.error, t("Bitte noch einmal versuchen."))}</span>}
        </div>
      </form>

      {created && <CreatedLink created={created} onHide={() => setCreated(null)} />}

      <section aria-label={t("Alle Links")} className="grid min-w-0 gap-2">
        <h2 className="font-mono text-label uppercase tracking-wide text-a-mut">{t("Alle Links")}</h2>
        {links.isLoading && (
          <div className="grid gap-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-[74px] animate-pulse rounded-xl bg-a-p2 motion-reduce:animate-none" />
            ))}
          </div>
        )}
        {links.isError && <ErrorBox text={t("Links konnten nicht geladen werden.")} onRetry={() => void links.refetch()} />}
        {links.isSuccess && links.data.length === 0 && <p className="text-caption text-a-mut">{t("Noch keine Links angelegt.")}</p>}
        {links.isSuccess && links.data.length > 0 && (
          <ul className="grid min-w-0 gap-2">
            {links.data.map((link, i) => (
              <LinkRow key={link.id} link={link} index={i} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CreatedLink({ created, onHide }: { created: IdeaLinkCreated; onHide: () => void }) {
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
  };

  return (
    <section aria-label={t("Neuer Link")} className="cc-card cc-rise grid min-w-0 gap-3 border-a-acc/50 p-4">
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate font-display text-headline font-semibold text-a-ink">{t("Link für {name}", { name: created.link.name })}</h2>
        <button type="button" onClick={onHide} className="rounded-md px-2 py-1 text-caption text-a-mut hover:bg-a-p2 hover:text-a-ink">
          {t("Ausblenden")}
        </button>
      </div>
      <p className="select-all break-all rounded-lg border border-a-line bg-a-bg px-3 py-2.5 font-mono text-callout text-a-acc">{created.url}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded-lg border border-transparent bg-a-primary px-3 py-1.5 text-caption font-semibold text-a-on-primary hover:brightness-110"
        >
          {t("Kopieren")}
        </button>
        <span className="text-caption text-a-wait">{t("Jetzt kopieren – später nicht mehr sichtbar.")}</span>
        {copied === "ok" && (
          <span role="status" className="text-caption text-a-ok">
            {t("Kopiert.")}
          </span>
        )}
        {copied === "fail" && (
          <span role="status" className="text-caption text-a-bad">
            {t("Kopieren ging nicht – bitte markieren und von Hand kopieren.")}
          </span>
        )}
      </div>
    </section>
  );
}

function LinkRow({ link, index }: { link: IdeaLink; index: number }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: () => revokeIdeaLink(link.id),
    onSuccess: () => {
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: ["idealinks"] });
    },
  });
  const state = linkState(link);

  return (
    <li className="cc-card cc-rise grid min-w-0 gap-2 px-4 py-3" style={riseStyle(index)}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <b className="min-w-0 truncate text-callout font-semibold text-a-ink">{link.name}</b>
        <span className={cn("rounded-full px-2 py-px font-mono text-label", STATE_STYLE[state])}>{STATE_LABEL[state]}</span>
        <span className="flex-1" />
        {state === "aktiv" && !confirming && (
          <button type="button" onClick={() => setConfirming(true)} className="rounded-md border border-a-line px-2.5 py-1 text-caption text-a-mut hover:border-a-bad/60 hover:text-a-bad">
            {t("Widerrufen")}
          </button>
        )}
      </div>
      <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 font-mono text-caption text-a-mut">
        <span title={formatDateTime(link.expiresAt)}>
          {state === "abgelaufen" ? t("abgelaufen am {date}", { date: dateOnly(link.expiresAt) }) : t("gültig bis {date}", { date: dateOnly(link.expiresAt) })}
        </span>
        <span>{link.uses === 1 ? t("1 Nutzung") : t("{n} Nutzungen", { n: link.uses })}</span>
        <span>{link.ideasCreated === 1 ? t("1 Idee angelegt") : t("{n} Ideen angelegt", { n: link.ideasCreated })}</span>
        <span>{link.lastUsedAt ? t("zuletzt {when}", { when: relativeTime(link.lastUsedAt) ?? dateOnly(link.lastUsedAt) }) : t("noch nie benutzt")}</span>
        <span>{t("{n}/Std", { n: link.ratePerHour })}</span>
      </div>
      {confirming && (
        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-a-bad/30 bg-a-bad/5 px-3 py-2 text-caption text-a-ink">
          <span className="min-w-0 flex-1">{t("Link für {name} sofort sperren? Das lässt sich nicht rückgängig machen.", { name: link.name })}</span>
          <button
            type="button"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate()}
            className="rounded-md border border-a-bad/60 bg-a-bad/15 px-2.5 py-1 text-caption font-semibold text-a-bad disabled:opacity-50"
          >
            {t("Ja, widerrufen")}
          </button>
          <button type="button" onClick={() => setConfirming(false)} className="rounded-md px-2 py-1 text-caption text-a-mut hover:text-a-ink">
            {t("Abbrechen")}
          </button>
        </div>
      )}
      {revoke.isError && <p className="text-caption text-a-bad">{t("Widerrufen fehlgeschlagen – bitte noch einmal.")}</p>}
    </li>
  );
}
