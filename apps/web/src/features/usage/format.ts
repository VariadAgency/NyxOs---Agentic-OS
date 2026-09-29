// Zahl-Helfer für den Nutzung-Tab. Reine Funktionen, kein React.
import { formatTokensCompact, getLang, locale, t } from "@nyxos/shared";

const fullFmt = new Intl.NumberFormat(locale());
const usdFmt = new Intl.NumberFormat(locale(), { style: "currency", currency: "USD", maximumFractionDigits: 2 });

/** Liegt in `@nyxos/shared` (auch der Server schreibt Token-Mengen) — hier nur weitergereicht. */
export { formatTokensCompact };

export function formatTokensFull(n: number): string {
  return fullFmt.format(n);
}

/** `null` = kein Preis hinterlegt — "keine Quelle" statt einer erfundenen Zahl. */
export function formatUsd(n: number | null): string {
  return n === null ? t("keine Quelle") : usdFmt.format(n);
}

const UNITS: [RegExp, number][] = [
  [/^(bio|billionen?|t|tn|trillions?)$/, 1e12],
  [/^(mrd|milliarden?|b|bn)$/, 1e9],
  [/^(mio|millionen?|m|mn|millions?)$/, 1e6],
  [/^(tsd|tausend|k|thousands?)$/, 1e3],
];

/** Token-Menge so lesen, wie man sie sagt oder tippt: „10 Mrd.“, „1,5 Mrd“, „500 Mio.“, „10.000.000.000“
 * (Englisch: „10B“, „1.5 bn“, „500M“, „10,000,000,000“). `null` = keine gültige, positive Zahl. */
export function parseTokenAmount(input: string): number | null {
  const m = /^([\d.,\s]+?)\s*([a-zäöü]+)?\.?$/i.exec(input.trim());
  if (!m?.[1]) return null;
  let num = m[1].replace(/\s/g, "");
  if (getLang() === "en") num = num.replace(/,/g, "");
  else if (num.includes(",")) num = num.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(num)) num = num.replace(/\./g, "");
  if (!/^\d+(\.\d+)?$/.test(num)) return null;
  let factor = 1;
  if (m[2]) {
    const unit = UNITS.find(([re]) => re.test(m[2]?.toLowerCase() ?? ""));
    if (!unit) return null;
    factor = unit[1];
  }
  const value = Math.round(Number(num) * factor);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Token-Menge fürs Eingabefeld: kurz („10 Mrd.“), aber nur, wenn das beim erneuten Speichern exakt
 * dieselbe Zahl ergibt — sonst die volle Zahl (ein Ziel darf sich nie still durch Runden ändern). */
export function formatTokenInput(n: number): string {
  const short = formatTokensCompact(n);
  return parseTokenAmount(short) === n ? short : formatTokensFull(n);
}
