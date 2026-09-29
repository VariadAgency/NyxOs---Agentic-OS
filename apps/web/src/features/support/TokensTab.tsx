// Tab "Buy me Tokens": a warm word why donations help, amount chips 3/5/10/25 € or a free amount, once/monthly,
// name + message (optional, "thank me publicly"). Payment happens INSIDE NyxOS: the own server asks the support
// service for a payment page (`embedUrl`) and the sheet shows it in a sandboxed frame (DonationFrame). Which payment
// provider sits behind it is the website's business. Without a support address: honest "being set up", no button.
import { locale, SUPPORT_AMOUNTS_EUR, SUPPORT_LIMITS, t, type SupportDonateResult, type SupportState } from "@nyxos/shared";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { friendlyError } from "../../lib/friendlyError";
import { useStartDonation } from "./api";
import { DonationFrame } from "./DonationFrame";
import { Chips, Field, FIELD, HeartIcon, Note } from "./parts";

type Interval = "once" | "monthly";
const INTERVALS: { value: Interval; label: string }[] = [
  { value: "once", label: t("Einmalig") },
  { value: "monthly", label: t("Monatlich") },
];
const CUSTOM = "custom";

/** "12,50" / "12.5" / "12" → cents, or null when it is not a valid amount. */
export function parseEuroAmount(text: string): number | null {
  const v = text.trim().replace(/\s*€$/, "").replace(",", ".");
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(v)) return null;
  const cents = Math.round(Number(v) * 100);
  return cents >= SUPPORT_LIMITS.amountMinCents && cents <= SUPPORT_LIMITS.amountMaxCents ? cents : null;
}

export function TokensTab({ state }: { state: SupportState | undefined }) {
  const start = useStartDonation();
  const [chip, setChip] = useState<number | typeof CUSTOM>(10);
  const [custom, setCustom] = useState("");
  const [interval, setDonationInterval] = useState<Interval>("once");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [publicThanks, setPublicThanks] = useState(false);
  const [session, setSession] = useState<SupportDonateResult | null>(null);
  const [outcome, setOutcome] = useState<"paid" | "cancelled" | null>(null);

  const amountCents = chip === CUSTOM ? parseEuroAmount(custom) : chip * 100;
  const configured = state?.configured === true;
  const digits = amountCents !== null && amountCents % 100 !== 0 ? 2 : 0;
  const amountLabel = amountCents === null ? "" : new Intl.NumberFormat(locale(), { style: "currency", currency: "EUR", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amountCents / 100);

  if (outcome === "paid") {
    return (
      <div className="grid gap-4" data-testid="support-thanks">
        <Note tone="ok" role="status">
          <strong className="flex items-center gap-2 font-semibold">
            <HeartIcon className="h-4 w-4 text-a-conf" />
            {t("Danke von Herzen!")}
          </strong>
          <span>{t("Deine Unterstützung ist angekommen. Sie hält NyxOS am Leben – und sorgt für die nächsten Updates.")}</span>
        </Note>
        <Button className="w-fit min-h-11 sm:min-h-9" onClick={() => (setOutcome(null), setSession(null), start.reset())}>
          {t("Fertig")}
        </Button>
      </div>
    );
  }

  if (session) {
    return (
      <DonationFrame
        session={session}
        onPaid={() => setOutcome("paid")}
        onCancel={() => {
          setSession(null);
          setOutcome("cancelled");
        }}
      />
    );
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!configured || amountCents === null || start.isPending) return;
        setOutcome(null);
        start.mutate({ amountCents, currency: "EUR", interval, name, message, publicThanks }, { onSuccess: setSession });
      }}
    >
      <div className="grid gap-2 text-callout leading-relaxed text-a-ink">
        <p>{t("NyxOS ist frei und bleibt es. Gebaut wird es von einer einzelnen Person – mit vielen Nächten und noch mehr Tokens.")}</p>
        <p className="text-a-mut">{t("Jede Spende hilft direkt: Sie bezahlt Opus-Tokens für neue Funktionen, den Server für Updates und die Zeit, die in jede Version fließt. Danke, dass du darüber nachdenkst!")}</p>
      </div>

      {outcome === "cancelled" && (
        <Note tone="info" role="status">
          {t("Bezahlung abgebrochen – es wurde nichts abgebucht.")}
        </Note>
      )}
      {!configured && state && (
        <Note tone="wait" role="status">
          {state.problem ?? t("Bezahlen wird gerade eingerichtet – danke, dass du helfen willst!")}
        </Note>
      )}

      <fieldset className="grid gap-2" disabled={!configured}>
        <legend className="mb-1.5 text-caption font-medium text-a-ink">{t("Betrag")}</legend>
        <Chips
          label={t("Betrag")}
          nyx="support-tokens-amount"
          options={[...SUPPORT_AMOUNTS_EUR.map((eur) => ({ value: eur as number | typeof CUSTOM, label: `${eur} €` })), { value: CUSTOM, label: t("Eigener Betrag") }]}
          value={chip}
          onChange={setChip}
        />
        {chip === CUSTOM && (
          <Field label={t("Eigener Betrag in Euro")} hint={t("Zwischen 1 € und 1000 €.")}>
            <input data-nyx="support-tokens-custom" className={FIELD} inputMode="decimal" placeholder={t("z. B. 15")} value={custom} onChange={(e) => setCustom(e.target.value)} aria-invalid={custom !== "" && amountCents === null} />
          </Field>
        )}
      </fieldset>

      <fieldset className="grid gap-2" disabled={!configured}>
        <legend className="mb-1.5 text-caption font-medium text-a-ink">{t("Wie oft?")}</legend>
        <Chips label={t("Wie oft?")} options={INTERVALS} value={interval} onChange={setDonationInterval} nyx="support-tokens-interval" />
      </fieldset>

      <fieldset className="grid gap-3" disabled={!configured}>
        <Field label={t("Dein Name")} optional>
          <input data-nyx="support-tokens-name" className={FIELD} value={name} maxLength={SUPPORT_LIMITS.nameChars} autoComplete="name" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("Nachricht an den Entwickler")} optional>
          <input data-nyx="support-tokens-message" className={FIELD} value={message} maxLength={SUPPORT_LIMITS.messageChars} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        <label className="flex min-h-11 items-center gap-2.5 text-callout text-a-ink sm:min-h-8">
          <input type="checkbox" className="h-4 w-4 accent-(--a-acc)" checked={publicThanks} onChange={(e) => setPublicThanks(e.target.checked)} />
          {t("Öffentlich danken (Name und Nachricht auf der Unterstützer-Seite)")}
        </label>
      </fieldset>

      {start.isError && (
        <Note tone="bad" role="alert">
          {friendlyError(start.error, t("Die Bezahlseite ließ sich nicht öffnen – bitte gleich noch einmal versuchen."))}
        </Note>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="primary"
          data-nyx="support-tokens-pay"
          data-nyx-risk=""
          className="min-h-11 px-4 sm:min-h-9"
          disabled={!configured || amountCents === null || start.isPending}
          aria-busy={start.isPending}
        >
          {start.isPending ? t("Öffnet …") : amountLabel ? t("Weiter zur Bezahlung · {amount}", { amount: interval === "monthly" ? t("{amount} im Monat", { amount: amountLabel }) : amountLabel }) : t("Weiter zur Bezahlung")}
        </Button>
        <span className="text-caption text-a-mut">{t("Bezahlt wird hier in NyxOS, auf einer gesicherten Seite der Projekt-Website.")}</span>
      </div>
    </form>
  );
}
