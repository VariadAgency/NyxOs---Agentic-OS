// Was das Menü „⋯“ an einem Nyx-Faden tut – Aufrufe, Rückfrage vor dem Löschen, kurze
// Rückmeldung im Panel. Karten (Zusammenfassung, Aufgabe, Obsidian) landen im Faden; ist ein anderer
// Faden offen, wechselt das Panel dorthin, damit du das Ergebnis siehst (außer Nyx antwortet gerade).
import { t, type HaikuMessage, type HaikuThread } from "@nyxos/shared";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { isDemoReadonly } from "../../lib/demoReadonly";
import { LoginRequiredError } from "../terminal/authClient";
import { deleteThread, HaikuApiError, serverStatusMessage, setThreadArchived, summarizeThread, threadToObsidian, threadToTask } from "./haikuApi";
import { ConfirmDeleteThread, type ThreadMenuItem } from "./ThreadMenu";
import type { useHaikuChat } from "./useHaikuChat";

export const THREADS_KEY = ["haiku", "threads"] as const;
export const ARCHIVE_KEY = ["haiku", "threads", "archiv"] as const;

type Chat = ReturnType<typeof useHaikuChat>;
type Notice = { tone: "busy" | "ok" | "bad"; text: string; link?: { href: string; label: string }; openThread?: number };

const OK_VISIBLE_MS = 6000;
const generic = () => t("Das hat nicht geklappt. Bitte noch einmal versuchen.");

/** Server-Hinweise sind schon verständlich formuliert; nur Status-Codes und Technik fangen wir ab. */
export function friendlyError(e: unknown): string {
  if (e instanceof LoginRequiredError) return e.message;
  if (e instanceof HaikuApiError) {
    if (e.status === 404) return t("Diesen Faden gibt es nicht mehr. Die Liste ist jetzt aktuell.");
    if (e.message === serverStatusMessage(e.status)) return generic();
    return e.message;
  }
  return t("Keine Verbindung zum Server. Bitte gleich noch einmal versuchen.");
}

export function useThreadActions(chat: Chat) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<HaikuThread | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    if (notice?.tone !== "ok") return;
    const timer = setTimeout(() => setNotice(null), OK_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: THREADS_KEY });
  }, [qc]);

  /** Karte zeigen: im offenen Faden sofort, sonst dorthin wechseln (nicht mitten in einer Antwort). */
  const showCard = useCallback(
    async (id: number, message: HaikuMessage | null): Promise<boolean> => {
      if (chat.threadId === id) {
        if (message) chat.appendNote(id, message);
        return true;
      }
      if (chat.busy) return false;
      await chat.openThread(id);
      return true;
    },
    [chat],
  );

  const run = useCallback(
    async (th: HaikuThread, busyText: string, work: () => Promise<Notice | null>) => {
      setBusyId(th.id);
      setNotice({ tone: "busy", text: busyText });
      try {
        setNotice(await work());
      } catch (e) {
        setNotice(isDemoReadonly(e) ? null : { tone: "bad", text: friendlyError(e) });
        if (e instanceof HaikuApiError && e.status === 404) refresh();
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const summarize = (th: HaikuThread) =>
    run(th, t("Nyx fasst den Faden zusammen …"), async () => {
      const msg = await summarizeThread(th.id);
      refresh();
      const shown = await showCard(th.id, msg);
      return { tone: "ok", text: t("Die Zusammenfassung liegt als Karte im Faden."), openThread: shown ? undefined : th.id };
    });

  const toTask = (th: HaikuThread) =>
    run(th, t("Lege die Aufgabe an …"), async () => {
      const res = await threadToTask(th.id);
      const link = { href: res.entry.href, label: res.entry.title };
      if ("existing" in res) return { tone: "ok", text: t("Aus diesem Faden gibt es schon eine Aufgabe:"), link };
      refresh();
      void qc.invalidateQueries({ queryKey: ["entries"] });
      const shown = await showCard(th.id, res.message);
      return { tone: "ok", text: t("Aufgabe angelegt:"), link, openThread: shown ? undefined : th.id };
    });

  const toObsidian = (th: HaikuThread) =>
    run(th, t("Lege den Faden in Obsidian ab …"), async () => {
      const res = await threadToObsidian(th.id);
      refresh();
      const shown = await showCard(th.id, res.message);
      return { tone: "ok", text: t("In Obsidian abgelegt: {path}", { path: res.relPath }), openThread: shown ? undefined : th.id };
    });

  const archive = (th: HaikuThread, archived: boolean) =>
    run(th, archived ? t("Archiviere …") : t("Hole zurück …"), async () => {
      await setThreadArchived(th.id, archived);
      if (archived && chat.threadId === th.id && !chat.busy) chat.reset();
      refresh();
      return { tone: "ok", text: archived ? t("„{title}“ ist im Archiv. Dort kannst du ihn jederzeit zurückholen.", { title: th.title }) : t("„{title}“ ist wieder in der Liste.", { title: th.title }) };
    });

  const doDelete = async () => {
    const th = confirm;
    if (!th) return;
    setDeleting(true);
    try {
      await deleteThread(th.id);
      if (chat.threadId === th.id) chat.reset();
      setNotice({ tone: "ok", text: t("„{title}“ ist gelöscht.", { title: th.title }) });
      refresh();
    } catch (e) {
      setNotice(isDemoReadonly(e) ? null : { tone: "bad", text: friendlyError(e) });
    } finally {
      setDeleting(false);
      setConfirm(null);
    }
  };

  const itemsFor = (th: HaikuThread, archived: boolean): ThreadMenuItem[] => {
    const busy = busyId !== null;
    const del: ThreadMenuItem = { label: t("Löschen …"), tone: "bad", onSelect: () => setConfirm(th), disabled: busy };
    if (archived) return [{ label: t("Zurückholen"), onSelect: () => void archive(th, false), disabled: busy }, del];
    return [
      { label: t("Zusammenfassen"), onSelect: () => void summarize(th), disabled: busy },
      { label: t("Zu Auftrag machen"), onSelect: () => void toTask(th), disabled: busy },
      { label: t("In Obsidian ablegen"), onSelect: () => void toObsidian(th), disabled: busy },
      { label: t("Archivieren"), onSelect: () => void archive(th, true), disabled: busy },
      del,
    ];
  };

  const dialog: ReactNode = confirm ? <ConfirmDeleteThread title={confirm.title || confirm.topic} pending={deleting} onConfirm={() => void doDelete()} onCancel={() => setConfirm(null)} /> : null;

  const noticeLine: ReactNode = notice ? (
    <NoticeLine
      notice={notice}
      onDismiss={() => setNotice(null)}
      onOpen={(id) => {
        setNotice(null);
        void chat.openThread(id);
      }}
    />
  ) : null;

  return { itemsFor, dialog, notice: noticeLine };
}

function NoticeLine({ notice, onDismiss, onOpen }: { notice: Notice; onDismiss: () => void; onOpen: (id: number) => void }) {
  const tone = notice.tone === "bad" ? "border-a-bad/40 bg-a-bad/10 text-a-bad" : notice.tone === "ok" ? "border-a-ok/30 bg-a-ok/10 text-a-ink" : "border-a-line bg-a-p2 text-a-mut";
  return (
    <div role={notice.tone === "bad" ? "alert" : "status"} className={`cc-rise flex min-w-0 items-start gap-2 rounded-lg border px-2.5 py-1.5 text-caption leading-snug ${tone}`}>
      {notice.tone === "busy" && (
        <span className="cc-typing mt-1.5 inline-flex shrink-0 items-center gap-1" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      )}
      {notice.tone === "ok" && (
        <span aria-hidden="true" className="shrink-0 text-a-ok">
          ✓
        </span>
      )}
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {notice.text}
        {notice.link && (
          <>
            {" "}
            <Link to={notice.link.href} className="text-a-acc underline">
              {notice.link.label}
            </Link>
          </>
        )}
        {notice.openThread !== undefined && (
          <>
            {" "}
            <button type="button" onClick={() => onOpen(notice.openThread as number)} className="text-a-acc underline">
              {t("Faden öffnen")}
            </button>
          </>
        )}
      </span>
      {notice.tone !== "busy" && (
        <button type="button" onClick={onDismiss} aria-label={t("Hinweis schließen")} className="shrink-0 text-a-mut hover:text-a-ink">
          ✕
        </button>
      )}
    </div>
  );
}
