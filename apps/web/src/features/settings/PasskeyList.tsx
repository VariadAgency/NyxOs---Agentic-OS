// Passkeys verwalten (Einstellungen → Anmeldung). Nach Test-Läufen können Test-Passkeys
// herumliegen — du sollst sie selbst mit einem Klick entfernen können. Die Liste lädt erst auf Knopfdruck,
// weil der Server dafür eine frische Touch-ID-Bestätigung verlangt (wie „Code erzeugen"): so fragt die
// Seite nicht bei jedem Öffnen der Einstellungen nach dem Finger.
import { locale, t, timeZone } from "@nyxos/shared";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import { friendlyError } from "../../lib/friendlyError";
import { listPasskeys, removePasskey, renamePasskey, type PasskeyInfo } from "../terminal/authClient";

const dateFmt = new Intl.DateTimeFormat(locale(), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: timeZone() });
const when = (iso: string | null) => {
  if (!iso) return t("noch nie");
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? t("unbekannt") : t("{time} Uhr", { time: dateFmt.format(new Date(ms)) });
};

const cancelled = (msg: string) => /NotAllowedError|abgebrochen|cancel|not allowed/i.test(msg);

export function PasskeyList() {
  const [items, setItems] = useState<PasskeyInfo[] | null>(null);
  const [busy, setBusy] = useState<null | "load" | string>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const run = async (kind: string, fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      const msg = friendlyError(e);
      setError(cancelled(msg) ? t("Abgebrochen – bitte noch einmal versuchen.") : msg);
    } finally {
      setBusy(null);
    }
  };

  const load = () =>
    run("load", async () => {
      setNotice(null);
      setItems(await listPasskeys());
    });

  const remove = (p: PasskeyInfo) =>
    run(p.id, async () => {
      try {
        await removePasskey(p.id);
        setNotice(t("„{name}“ ist entfernt. Geräte, die damit angemeldet waren, sind abgemeldet.", { name: p.name }));
      } finally {
        setConfirmId(null);
        // Immer neu laden — auch nach einem Fehler (z. B. schon von woanders entfernt).
        setItems(await listPasskeys().catch(() => items));
      }
    });

  const rename = (p: PasskeyInfo) =>
    run(`rename-${p.id}`, async () => {
      await renamePasskey(p.id, draft);
      setRenameId(null);
      setNotice(t("Umbenannt in „{name}“.", { name: draft.trim() }));
      setItems(await listPasskeys());
    });

  if (items === null) {
    return (
      <div className="grid gap-1.5 border-t border-a-line pt-3">
        <span className="text-callout text-a-ink">Passkeys</span>
        <span className="text-caption text-a-mut">{t("Welche Geräte dürfen sich anmelden? Zum Ansehen einmal kurz Touch ID.")}</span>
        <Button className="w-fit" disabled={busy !== null} onClick={() => void load()}>
          {busy === "load" ? t("Warte auf Touch ID …") : t("Passkeys anzeigen")}
        </Button>
        {error && (
          <p role="alert" className="text-caption text-a-bad">
            {error}
          </p>
        )}
      </div>
    );
  }

  const onlyOne = items.length <= 1;
  return (
    <div className="grid gap-2 border-t border-a-line pt-3" data-testid="passkey-list" data-nyx-risk="">
      <div className="flex items-center gap-2">
        <span className="text-callout text-a-ink">{t("Passkeys ({n})", { n: items.length })}</span>
        <Button variant="ghost" className="ml-auto" disabled={busy !== null} onClick={() => void load()}>
          {busy === "load" ? t("Lade …") : t("Neu laden")}
        </Button>
      </div>
      <ul className="grid gap-1.5">
        {items.map((p) => {
          const locked = p.current || onlyOne;
          return (
            <li key={p.id} className={cn("grid gap-1.5 rounded-md border p-2.5", p.current ? "border-a-acc/60 bg-a-p2" : "border-a-line bg-a-p2")}>
              <div className="flex flex-wrap items-center gap-2">
                {renameId === p.id ? (
                  <form
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void rename(p);
                    }}
                  >
                    <input
                      aria-label={t("Neuer Name für „{name}“", { name: p.name })}
                      className="rounded-md border border-a-line bg-a-p3 px-2 py-1 text-callout text-a-ink"
                      maxLength={60}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      autoFocus
                    />
                    <Button variant="primary" type="submit" disabled={busy !== null || !draft.trim()}>
                      {busy === `rename-${p.id}` ? t("Speichere …") : t("Speichern")}
                    </Button>
                    <Button variant="ghost" type="button" disabled={busy !== null} onClick={() => setRenameId(null)}>
                      {t("Abbrechen")}
                    </Button>
                  </form>
                ) : (
                  <span className="text-callout font-medium text-a-ink">{p.name}</span>
                )}
                {p.shortId && <span className="rounded-full bg-a-p3 px-2 py-0.5 font-mono text-label text-a-mut" title={t("Kurze Kennung dieses Passkeys")}>#{p.shortId}</span>}
                {p.current && <span className="rounded-full bg-a-acc/15 px-2 py-0.5 text-label text-a-acc">{t("dieses Gerät · gerade benutzt")}</span>}
                {renameId !== p.id && confirmId !== p.id && (
                  <Button
                    variant="ghost"
                    className="ml-auto"
                    disabled={busy !== null}
                    onClick={() => {
                      setNotice(null);
                      setDraft(p.name);
                      setRenameId(p.id);
                    }}
                  >
                    {t("Umbenennen")}
                  </Button>
                )}
                {confirmId !== p.id && (
                  <Button
                    variant="ghost"
                    disabled={busy !== null || locked}
                    title={p.current ? t("Mit diesem Passkey bist du gerade angemeldet") : onlyOne ? t("Dein letzter Passkey bleibt immer") : undefined}
                    onClick={() => {
                      setNotice(null);
                      setConfirmId(p.id);
                    }}
                  >
                    {t("Entfernen")}
                  </Button>
                )}
              </div>
              <span className="text-caption text-a-mut">
                {t("angelegt {created} · zuletzt benutzt {used}", { created: when(p.createdAt), used: when(p.lastUsedAt) })}
              </span>
              {p.current && <span className="text-caption text-a-mut">{t("Bleibt, solange du damit angemeldet bist – entfernen geht von einem anderen Gerät aus.")}</span>}
              {!p.current && onlyOne && <span className="text-caption text-a-mut">{t("Dein letzter Passkey bleibt immer, sonst kämst du nicht mehr hinein.")}</span>}
              {confirmId === p.id && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-a-bad/50 p-2 text-caption text-a-ink" role="group" aria-label={t("„{name}“ entfernen bestätigen", { name: p.name })}>
                  <span>{t("„{name}“ wirklich entfernen? Geräte, die damit angemeldet sind, werden abgemeldet.", { name: p.name })}</span>
                  <Button variant="primary" disabled={busy !== null} onClick={() => void remove(p)}>
                    {busy === p.id ? t("Entferne …") : t("Ja, entfernen")}
                  </Button>
                  <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirmId(null)}>
                    {t("Abbrechen")}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {notice && <p className="text-caption text-a-ok">{notice}</p>}
      {error && (
        <p role="alert" className="text-caption text-a-bad">
          {error}
        </p>
      )}
    </div>
  );
}
