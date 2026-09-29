// Eingabezeile unten im Session-Chat. Mehrzeilig (Enter sendet, Shift+Enter neue Zeile),
// Büroklammer + Hineinziehen für Dateien und Bilder, Senden an die LAUFENDE Session. Läuft die
// Session nicht in der NyxOS, ist die Eingabe gesperrt: ein Satz, was los ist, und der Platz für
// den Knopf „In der NyxOS übernehmen“ (`takeover`).
import { t, type ChatAvailability } from "@nyxos/shared";
import { type ClipboardEvent, type KeyboardEvent, type ReactNode, useLayoutEffect, useRef } from "react";
import { cn } from "../../lib/cn";
import { formatSize, type DraftAttachment } from "./attachments";
import { IconClose, IconPaperclip, IconSend } from "./icons";

/** Höchstens so hoch wächst das Eingabefeld, danach scrollt es. */
const MAX_INPUT_PX = 180;
/** `accept` für den Datei-Dialog — dieselben Endungen wie `CHAT_FILE_TYPES`. */
const ACCEPT = "image/png,image/jpeg,image/gif,image/webp,application/pdf,.txt,.md,.csv,.json,.log,.yaml,.yml,.html,.css,.js,.ts,.tsx,.swift,.sql,.sh,.py";

interface ChatComposerProps {
  who: string;
  availability: ChatAvailability | undefined;
  availabilityError: boolean;
  text: string;
  onText: (text: string) => void;
  drafts: DraftAttachment[];
  onAddFiles: (files: File[]) => void;
  onRemove: (id: string) => void;
  onSend: () => void;
  sending: boolean;
  error: string | null;
  /** Platz für „In der NyxOS übernehmen“. Bis dahin steht dort nur der erklärende Satz. */
  takeover?: ReactNode;
  /** „Prompt verbessern“ ein-/ausblenden. */
  assistOpen?: boolean;
  onToggleAssist?: () => void;
}

export function ChatComposer({ who, availability, availabilityError, text, onText, drafts, onAddFiles, onRemove, onSend, sending, error, takeover, assistOpen, onToggleAssist }: ChatComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const locked = !availability?.canSend;
  const canSubmit = !locked && !sending && (text.trim().length > 0 || drafts.length > 0);

  // Feld wächst mit dem Text (bis MAX_INPUT_PX).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_PX)}px`;
  }, [text]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.altKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (canSubmit) onSend();
  };

  // Bilder aus der Zwischenablage (Bildschirmfoto mit ⌘⇧⌃4) direkt anhängen.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...(e.clipboardData?.files ?? [])];
    // Finder/Office legen Text UND Datei ab — dann normal einfügen, nichts schlucken.
    if (files.length === 0 || [...(e.clipboardData?.types ?? [])].includes("text/plain")) return;
    e.preventDefault();
    onAddFiles(files.map((f, i) => (f.name && f.name !== "image.png" ? f : new File([f], `bildschirmfoto-${Date.now()}-${i}.png`, { type: f.type || "image/png" }))));
  };

  const loading = !availability && !availabilityError;
  const lockedMessage = availabilityError ? t("Ich kann gerade nicht prüfen, ob die Session bereit ist. Einen Moment …") : availability?.message;
  // Beim Laden kein falscher Grund; gesperrt steht der echte Grund auch im Feld.
  const placeholder = loading ? t("Einen Moment …") : locked ? (lockedMessage ?? t("Schreiben geht gerade nicht")) : t("Nachricht an {who} …", { who });

  return (
    <div className="shrink-0 border-t border-a-line bg-a-p px-3 pt-2.5 pb-2" data-testid="chat-composer">
      {locked && lockedMessage && (
        <div data-testid="chat-locked" className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-a-wait/30 bg-a-wait/10 px-3 py-2 text-caption text-a-ink">
          <span className="min-w-0 flex-1">{lockedMessage}</span>
          {takeover}
        </div>
      )}
      {!locked && availability?.busy && (
        <p className="mb-1.5 text-caption text-a-wait">
          {t("{who} arbeitet gerade – deine Nachricht kommt in die Warteschlange und wird nach dem aktuellen Schritt gelesen.", { who })}
        </p>
      )}

      {drafts.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5" aria-label={t("Anhänge")}>
          {drafts.map((d) => (
            <li key={d.id} data-testid="chat-attachment" className="flex max-w-[260px] items-center gap-2 rounded-md border border-a-line bg-a-p2 py-1 pr-1 pl-1.5 text-caption">
              {d.previewUrl ? (
                <img src={d.previewUrl} alt="" className="h-7 w-7 shrink-0 rounded object-cover" />
              ) : (
                <span /* typo-keep: Dateiendung im 28-px-Kästchen */ className="grid h-7 w-7 shrink-0 place-items-center rounded bg-a-p3 font-mono text-[9px] text-a-acc uppercase">{d.name.split(".").pop()}</span>
              )}
              <span className="min-w-0 truncate text-a-ink">{d.name}</span>
              <span className="shrink-0 font-mono text-label text-a-mut">{formatSize(d.size)}</span>
              <button type="button" onClick={() => onRemove(d.id)} aria-label={t("Anhang entfernen: {name}", { name: d.name })} className="grid h-5 w-5 shrink-0 place-items-center rounded text-a-mut hover:bg-a-p3 hover:text-a-ink">
                <IconClose size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div
        className={cn(
          "flex items-end gap-1.5 rounded-lg border bg-a-bg px-1.5 py-1.5 transition-colors",
          locked && !loading ? "border-a-line opacity-60" : locked ? "border-a-line" : "border-a-line focus-within:border-a-acc",
        )}
      >
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={locked}
          aria-label={t("Datei anhängen")}
          title={t("Datei oder Bild anhängen")}
          className="grid h-(--a-ctl-h) w-(--a-ctl-h) shrink-0 place-items-center rounded-md text-a-mut hover:bg-a-p2 hover:text-a-ink disabled:pointer-events-none"
        >
          <IconPaperclip />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          data-testid="chat-file-input"
          onChange={(e) => {
            onAddFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          disabled={locked}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          aria-label={t("Nachricht an {who}", { who })}
          placeholder={placeholder}
          className="cc-scroll min-h-(--a-ctl-h) flex-1 resize-none bg-transparent px-1 py-[6px] text-callout leading-[18px] text-a-ink placeholder:text-a-mut focus:outline-none disabled:cursor-not-allowed"
        />
        <button
          type="button"
          onClick={onSend}
          disabled={!canSubmit}
          aria-label={t("Senden")}
          className="inline-flex h-(--a-ctl-h) shrink-0 items-center gap-1.5 rounded-md border border-transparent bg-a-primary px-3 text-caption font-semibold text-a-on-primary transition hover:brightness-110 disabled:pointer-events-none disabled:opacity-35"
        >
          {sending ? t("Sende …") : t("Senden")}
          <IconSend size={14} />
        </button>
      </div>
      <div className="mt-1 flex items-center justify-between gap-3 text-label text-a-mut">
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span>{t("Enter senden · Shift+Enter neue Zeile · Dateien hineinziehen oder einfügen")}</span>
          {onToggleAssist && (
            <button type="button" onClick={onToggleAssist} aria-pressed={assistOpen} className={cn("rounded px-1.5 py-0.5 font-medium transition", assistOpen ? "bg-a-acc/15 text-a-acc" : "text-a-ink hover:bg-a-p2")}>
              ✦ {t("Prompt verbessern")}
            </button>
          )}
        </span>
        {error && (
          <span role="alert" className="text-right text-caption text-a-bad">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
