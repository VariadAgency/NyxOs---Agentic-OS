// Chat-Kachel einer Session — Verlauf (ChatPanel) oben, Eingabe unten, Dateien lassen sich
// auf die ganze Kachel ziehen. Senden geht an die LAUFENDE Session (Server → Brücke → tmux).
import { friendlyError } from "../../lib/friendlyError";
import { type DragEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ChatPanel } from "../../components/sessions/ChatPanel";
import type { Session } from "../../lib/api";
import { cn } from "../../lib/cn";
import { useQueryClient } from "@tanstack/react-query";
import { CHAT_MAX_FILE_BYTES, t, type ChatSendResult } from "@nyxos/shared";
import { deliveriesKey, useChatAvailability, useSendChatMessage } from "./api";
import { DeliveryQueue, DeliveryQueueToggle } from "./DeliveryQueue";
import { PHONE_QUERY, useMediaQuery } from "../../hooks/useMediaQuery";
import { SessionAgentsBar } from "../session-agents/SessionAgentsBar";
import { addDrafts, readBase64, releasePreview, type DraftAttachment } from "./attachments";
import { ChatComposer } from "./ChatComposer";
import { PromptAssistPanel } from "./PromptAssistPanel";
import { loadAssistOpen, saveAssistOpen } from "./promptAssist";
import { IconPaperclip } from "./icons";
import { addPending, removePending, updatePending } from "./pending";
import { SessionSummaryCard } from "./SessionSummary";

interface SessionChatProps {
  session: Session;
  at: number | null;
  /** Kopf der Kachel (z. B. Knopf „Infos einklappen“), rechts oben über dem Verlauf. */
  toolbar?: ReactNode;
  /** Platz für „In der NyxOS übernehmen“. */
  takeover?: ReactNode;
}

const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");

export function SessionChat({ session, at, toolbar, takeover }: SessionChatProps) {
  const who = session.tool === "codex" ? "Codex" : "Claude";
  const availability = useChatAvailability(session.id);
  const send = useSendChatMessage(session.id);
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState<DraftAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  // Phone: agents bar and queue share one line (queue collapsed).
  const phone = useMediaQuery(PHONE_QUERY);
  const [queueOpen, setQueueOpen] = useState(false);
  const queueId = useId();
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  // Vorschaubilder beim Verlassen freigeben.
  useEffect(() => () => draftsRef.current.forEach(releasePreview), []);

  const canSend = availability.data?.canSend ?? false;

  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    const r = addDrafts(draftsRef.current, files);
    setDrafts(r.next);
    setError(r.error);
  };

  const removeDraft = (id: string) => {
    const d = draftsRef.current.find((x) => x.id === id);
    if (d) releasePreview(d);
    setDrafts((list) => list.filter((x) => x.id !== id));
  };

  /** Ein Weg an die Session für Eingabezeile UND „Prompt verbessern“ (Warteschlange, Pending-Blase, Fehler). */
  const deliver = (body: string, attachments: { name: string; dataBase64: string }[], files: DraftAttachment[]) =>
    new Promise<ChatSendResult>((resolve, reject) => {
      const key = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      addPending(session.id, { key, text: body, files: files.map((f) => f.name), sentAt: Date.now(), state: "sending" });
      send.mutate(
        { text: body, attachments },
        {
          onSuccess: (r) => {
            // Wartet die Nachricht in der Zustell-Warteschlange der NyxOS, steht sie dort
            // (dauerhaft, zurückziehbar) — keine zweite Blase im Verlauf.
            if (r.queued && r.deliveryId) removePending(session.id, key);
            else updatePending(session.id, key, { state: r.uncertain ? "uncertain" : r.queued ? "queued" : "delivered" });
            if (r.queued) void qc.invalidateQueries({ queryKey: deliveriesKey(session.id) });
            resolve(r);
          },
          onError: (e) => {
            removePending(session.id, key);
            reject(e);
          },
        },
      );
    });

  const onSend = async () => {
    const body = text.trim();
    const files = drafts;
    if ((!body && files.length === 0) || send.isPending) return;
    setError(null);
    let attachments: { name: string; dataBase64: string }[];
    try {
      attachments = await Promise.all(files.map(async (f) => ({ name: f.name, dataBase64: await readBase64(f.file) })));
    } catch (e) {
      setError(friendlyError(e, t("Eine Datei konnte nicht gelesen werden.")));
      return;
    }
    setText("");
    setDrafts([]);
    try {
      await deliver(body, attachments, files);
      files.forEach(releasePreview);
    } catch (e) {
      // Nichts geht verloren: Text und Anhänge zurück ins Feld, Grund darunter.
      setText((cur) => (cur ? cur : body));
      setDrafts((d) => (d.length > 0 ? d : files));
      setError(friendlyError(e, t("Die Nachricht ist nicht angekommen.")));
    }
  };

  // Prompt verbessern: auf breiten Kacheln daneben, sonst unter dem Verlauf (einklappbar, gemerkt).
  const [assistOpen, setAssistOpen] = useState(loadAssistOpen);
  const toggleAssist = (open: boolean) => {
    setAssistOpen(open);
    saveAssistOpen(open);
  };
  const sendFromAssist = async (body: string) => {
    if (send.isPending) throw new Error(t("Es wird gerade schon gesendet – einen Moment."));
    await deliver(body, [], []);
  };

  return (
    <div
      data-testid="session-main"
      className="@container relative flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-a-line bg-a-p max-md:rounded-none max-md:border-0"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = canSend ? "copy" : "none";
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (canSend) addFiles([...(e.dataTransfer?.files ?? [])]);
        else setError(availability.data?.message ?? t("Schreiben geht gerade nicht."));
      }}
    >
      {toolbar}
      {/* bleibende Zusammenfassung von Nyx oben im Chat (aufklappbar). */}
      <SessionSummaryCard sessionId={session.id} />
      <div className="flex min-h-0 flex-1 flex-col @min-[900px]:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <ChatPanel key={session.id} sessionId={session.id} at={at} />
          </div>
          {phone ? (
            <>
              {queueOpen && <DeliveryQueue sessionId={session.id} id={queueId} />}
              {/* One line: agents on the left (tap → sheet), "2 waiting" on the right (tap → list above). */}
              <div className="cc-kb-hide flex min-w-0 items-stretch" data-testid="chat-status-strip">
                <SessionAgentsBar session={session} className="min-w-0 flex-1" />
                <DeliveryQueueToggle sessionId={session.id} open={queueOpen} onToggle={() => setQueueOpen((v) => !v)} controls={queueId} />
              </div>
            </>
          ) : (
            <>
              <DeliveryQueue sessionId={session.id} />
              {/* Agents of the session (only when there are any) — a click opens the popup in the chat window. */}
              <SessionAgentsBar session={session} className="cc-kb-hide" />
            </>
          )}
          <ChatComposer
            who={who}
            availability={availability.data}
            availabilityError={availability.isError && !availability.data}
            text={text}
            onText={setText}
            drafts={drafts}
            onAddFiles={addFiles}
            onRemove={removeDraft}
            onSend={() => void onSend()}
            sending={send.isPending}
            error={error}
            takeover={takeover}
            assistOpen={assistOpen}
            onToggleAssist={() => toggleAssist(!assistOpen)}
          />
        </div>
        {assistOpen && (
          <PromptAssistPanel
            key={session.id}
            sessionId={session.id}
            who={who}
            availability={availability.data}
            onSend={sendFromAssist}
            sending={send.isPending}
            onUseInComposer={(value) => {
              setText(value);
              setError(null);
            }}
            onClose={() => toggleAssist(false)}
            className="max-h-[55%] shrink-0 border-t border-a-line @min-[900px]:max-h-none @min-[900px]:w-[400px] @min-[900px]:border-t-0 @min-[900px]:border-l"
          />
        )}
      </div>
      {dragging && (
        <div className={cn("pointer-events-none absolute inset-1.5 z-20 grid place-items-center rounded-lg border-2 border-dashed", canSend ? "border-a-acc bg-a-bg/85" : "border-a-wait bg-a-bg/85")}>
          <div className="grid justify-items-center gap-2 text-center">
            <IconPaperclip size={26} className={canSend ? "text-a-acc" : "text-a-wait"} />
            <b className="text-callout text-a-ink">{canSend ? t("Dateien hier ablegen") : t("Gerade kein Senden möglich")}</b>
            <span className="text-caption text-a-mut">{canSend ? t("Bilder, PDF, Text- und Code-Dateien · bis {mb} MB", { mb: CHAT_MAX_FILE_BYTES / (1024 * 1024) }) : availability.data?.message}</span>
          </div>
        </div>
      )}
    </div>
  );
}
