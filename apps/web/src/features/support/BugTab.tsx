// Tab "Fehler melden": what happened, what came before, what was expected, e-mail (optional), diagnostics with an
// exact preview, optional screenshot (choose or paste, at most 2 MB). Sending is the user's click only — Nyx can
// fill the fields (or leave a draft), but the send button is marked risky (`data-nyx-risk`).
import { SUPPORT_LIMITS, SUPPORT_SCREENSHOT_TYPES, t, type SupportScreenshot, type SupportSendResult, type SupportState } from "@nyxos/shared";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { useLocation } from "react-router";
import { Button } from "../../components/ui/button";
import { useAppInfo } from "../../hooks/useAppInfo";
import { friendlyError } from "../../lib/friendlyError";
import { useRemoveOutboxItem, useSendBug } from "./api";
import { buildDiagnostics } from "./diagnostics";
import { AREA, Field, FIELD, Note } from "./parts";
import { SentNote } from "./SentNote";

const MAX_MB = SUPPORT_LIMITS.screenshotBytes / 1024 / 1024;

function readScreenshot(file: File): Promise<SupportScreenshot> {
  return new Promise((resolve, reject) => {
    if (!(SUPPORT_SCREENSHOT_TYPES as readonly string[]).includes(file.type)) return reject(new Error(t("Bitte ein Bild als PNG, JPEG oder WebP wählen.")));
    if (file.size > SUPPORT_LIMITS.screenshotBytes) return reject(new Error(t("Das Bild ist zu groß (höchstens {mb} MB).", { mb: MAX_MB })));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t("Das Bild ließ sich nicht lesen.")));
    reader.onload = () => {
      const data = String(reader.result ?? "");
      const base64 = data.slice(data.indexOf(",") + 1);
      resolve({ name: file.name || "bildschirmfoto.png", type: file.type as SupportScreenshot["type"], dataBase64: base64 });
    };
    reader.readAsDataURL(file);
  });
}

export function BugTab({ state }: { state: SupportState | undefined }) {
  const info = useAppInfo().data;
  const { pathname } = useLocation();
  const send = useSendBug();
  const dropDraft = useRemoveOutboxItem();
  const [what, setWhat] = useState("");
  const [before, setBefore] = useState("");
  const [expected, setExpected] = useState("");
  const [email, setEmail] = useState("");
  const [attach, setAttach] = useState(true);
  const [shot, setShot] = useState<SupportScreenshot | null>(null);
  const [shotError, setShotError] = useState<string | null>(null);
  const [result, setResult] = useState<SupportSendResult | null>(null);
  const [draftId, setDraftId] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** Draft (and version) already taken over or thrown away — never filled in twice. */
  const seenDraft = useRef<string | null>(null);

  // A draft prepared by Nyx fills an empty form once.
  const draft = state?.drafts.bug ?? null;
  useEffect(() => {
    if (!draft || draft.draft.kind !== "bug") return;
    const key = `${draft.id}@${draft.updatedAt}`;
    if (seenDraft.current === key || what || before || expected) return;
    seenDraft.current = key;
    setWhat(draft.draft.what);
    setBefore(draft.draft.before);
    setExpected(draft.draft.expected);
    setDraftId(draft.id);
  }, [draft, what, before, expected]);

  const diagnostics = useMemo(
    () => buildDiagnostics({ server: state?.diagnostics, version: info?.version, mode: info?.mode, pathname, userName: info?.settings.userName ?? "" }),
    [state?.diagnostics, info?.version, info?.mode, info?.settings.userName, pathname],
  );

  const takeFile = async (file: File | null | undefined) => {
    if (!file) return;
    try {
      setShot(await readScreenshot(file));
      setShotError(null);
    } catch (e) {
      setShot(null);
      setShotError(e instanceof Error ? e.message : t("Das Bild ließ sich nicht lesen."));
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith("image/"));
    if (file) {
      e.preventDefault();
      void takeFile(file);
    }
  };

  const canSend = what.trim().length >= 3 && !send.isPending;
  const submit = () => {
    if (!canSend) return;
    send.mutate(
      { what, before, expected, email: email.trim() || null, diagnostics: attach ? diagnostics : null, screenshot: shot, ...(draftId ? { draftId } : {}) },
      {
        onSuccess: (r) => {
          setResult(r);
          setWhat("");
          setBefore("");
          setExpected("");
          setShot(null);
          setDraftId(null);
        },
      },
    );
  };

  if (result) return <SentNote result={result} configured={state?.configured ?? false} onAgain={() => (setResult(null), send.reset())} againLabel={t("Noch einen Fehler melden")} />;

  return (
    <form
      className="grid gap-4"
      onPaste={onPaste}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {draftId !== null && (
        <Note tone="info" role="status">
          <span>{t("Nyx hat diese Meldung für dich vorbereitet. Prüf sie in Ruhe – abschicken kannst nur du.")}</span>
          <button
            type="button"
            className="w-fit text-caption text-a-acc hover:text-a-ink"
            onClick={() => {
              dropDraft.mutate(draftId);
              setDraftId(null);
              setWhat("");
              setBefore("");
              setExpected("");
            }}
          >
            {t("Entwurf verwerfen")}
          </button>
        </Note>
      )}
      <Field label={t("Was ist passiert?")}>
        <textarea data-nyx="support-bug-what" className={AREA} value={what} maxLength={SUPPORT_LIMITS.textChars} required placeholder={t("z. B. Der Knopf „Speichern“ reagiert nicht.")} onChange={(e) => setWhat(e.target.value)} />
      </Field>
      <Field label={t("Was hast du davor gemacht?")} optional>
        <textarea data-nyx="support-bug-before" className={AREA} value={before} maxLength={SUPPORT_LIMITS.textChars} placeholder={t("Die Schritte, so gut du dich erinnerst.")} onChange={(e) => setBefore(e.target.value)} />
      </Field>
      <Field label={t("Was hättest du erwartet?")} optional>
        <textarea data-nyx="support-bug-expected" className={AREA} value={expected} maxLength={SUPPORT_LIMITS.textChars} onChange={(e) => setExpected(e.target.value)} />
      </Field>
      <Field label={t("E-Mail für Rückfragen")} optional hint={t("Nur wenn du eine Antwort möchtest. Sie geht nur an den Entwickler.")}>
        <input data-nyx="support-bug-email" type="email" autoComplete="email" inputMode="email" className={FIELD} value={email} maxLength={SUPPORT_LIMITS.emailChars} onChange={(e) => setEmail(e.target.value)} />
      </Field>

      <div className="grid gap-2 rounded-lg border border-a-line bg-a-p px-3 py-2.5">
        <label className="flex min-h-11 items-center gap-2.5 text-callout text-a-ink sm:min-h-8">
          <input data-nyx="support-bug-diagnostics" type="checkbox" className="h-4 w-4 accent-(--a-acc)" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
          {t("Diagnose anhängen")}
        </label>
        <p className="text-caption text-a-mut">{t("Hilft beim Finden des Fehlers. Pfade, Rechnernamen, Adressen, Schlüssel und E-Mail-Adressen sind schon entfernt.")}</p>
        <details className="group">
          <summary className="flex min-h-11 cursor-pointer items-center text-caption text-a-acc hover:text-a-ink sm:min-h-7">{t("Genau das wird mitgeschickt")}</summary>
          <pre data-testid="support-diagnostics-preview" className="cc-scroll mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-a-line bg-a-bg p-2.5 font-mono text-label text-a-ink">
            {attach ? JSON.stringify(diagnostics, null, 2) : t("Nichts – das Häkchen ist aus.")}
          </pre>
        </details>
      </div>

      <div className="grid gap-2">
        <span className="text-caption font-medium text-a-ink">
          {t("Bildschirmfoto")}
          <span className="font-normal text-a-mut"> · {t("optional")}</span>
        </span>
        {shot ? (
          <div className="flex min-w-0 items-center gap-3 rounded-lg border border-a-line bg-a-p p-2">
            <img src={`data:${shot.type};base64,${shot.dataBase64}`} alt={t("Vorschau des Bildschirmfotos")} className="h-16 w-24 shrink-0 rounded-md border border-a-line object-cover" />
            <div className="grid min-w-0 flex-1 gap-0.5">
              <span className="truncate text-caption text-a-ink">{shot.name}</span>
              <span className="text-label text-a-mut">{t("Geht so mit, wie es ist – prüf, ob etwas Persönliches zu sehen ist.")}</span>
            </div>
            <Button variant="ghost" className="min-h-11 sm:min-h-8" onClick={() => setShot(null)}>
              {t("Entfernen")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button className="min-h-11 sm:min-h-8" onClick={() => fileRef.current?.click()}>
              {t("Bild wählen")}
            </Button>
            <span className="text-caption text-a-mut">{t("oder mit ⌘V einfügen · höchstens {mb} MB", { mb: MAX_MB })}</span>
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept={SUPPORT_SCREENSHOT_TYPES.join(",")}
          className="sr-only"
          tabIndex={-1}
          aria-label={t("Bildschirmfoto wählen")}
          data-testid="support-screenshot-input"
          onChange={(e) => {
            void takeFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {shotError && (
          <p role="alert" className="text-caption text-a-bad">
            {shotError}
          </p>
        )}
      </div>

      {send.isError && (
        <Note tone="bad" role="alert">
          {friendlyError(send.error, t("Die Meldung ging nicht raus – bitte noch einmal versuchen."))}
        </Note>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" data-nyx="support-bug-send" data-nyx-risk="" className="min-h-11 px-4 sm:min-h-9" disabled={!canSend} aria-busy={send.isPending}>
          {send.isPending ? t("Sendet …") : state?.configured === false ? t("In den Postausgang legen") : t("Fehler melden")}
        </Button>
        {!state?.configured && state && <span className="text-caption text-a-mut">{t("Geht raus, sobald die Meldestelle eingerichtet ist.")}</span>}
      </div>
    </form>
  );
}
