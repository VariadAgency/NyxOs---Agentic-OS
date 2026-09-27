// Shared constants (catalogs, presets, label lists) are written in German. The app language can change at
// runtime, so they must not be translated once at import: these helpers turn text fields into getters that
// translate on every read. Spreading, JSON.stringify and property access all see the current language.
import { t } from "./i18n/index.js";

type Translators<T> = { [K in keyof T]?: (value: NonNullable<T[K]>) => T[K] };

/** Copy of `item` whose listed fields are translated on every read (missing/null values stay as they are). */
export function lazyFields<T extends object>(item: T, fields: Translators<T>): T {
  const out = { ...item };
  for (const key of Object.keys(fields) as (keyof T)[]) {
    const fn = fields[key];
    const value = item[key];
    if (!fn || value === undefined || value === null) continue;
    Object.defineProperty(out, key, { enumerable: true, configurable: true, get: () => fn(value as NonNullable<T[typeof key]>) });
  }
  return out;
}

/** Translates one German source text (no placeholders). */
export const tr = <S extends string>(de: S): S => t(de) as S;

/** Translates every text of a list. */
export const trList = (list: readonly string[]): string[] => list.map((de) => t(de));

/** Label map whose values are German source texts, translated on every read. */
export function lazyRecord<T extends Record<string, string>>(labels: T): T {
  const out = {} as T;
  for (const key of Object.keys(labels) as (keyof T)[]) {
    const de = labels[key] as string;
    Object.defineProperty(out, key, { enumerable: true, configurable: true, get: () => t(de) });
  }
  return out;
}
