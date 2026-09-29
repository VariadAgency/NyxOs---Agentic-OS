import { dateTimeFormat } from "@nyxos/shared";

/** "22:47" in the user's language and time zone (the formatter is cached in `dateTimeFormat`). */
export function clockTime(d: Date): string {
  return dateTimeFormat({ hour: "2-digit", minute: "2-digit" }).format(d);
}
