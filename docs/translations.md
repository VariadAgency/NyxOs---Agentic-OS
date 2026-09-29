# Translations

NyxOS ships in **German** and **English**. The translation layer lives in `packages/shared/src/i18n/` and is
shared by the server, the bridge and the web app.

## How it works

**German is the source language.** Every text a user can see is written in German and wrapped in `t()`. The
German text itself is the key — there are no separate IDs to keep in sync.

```ts
import { t } from "@nyxos/shared";

t("Einstellungen");                         // "Settings" in English
t("{n} Sessions offen", { n: 3 });          // placeholders use {name}
t("Guten Morgen", undefined, "en");         // force a language (Telegram messages, prompts)
```

- `packages/shared/src/i18n/index.ts` holds `t()`, `setLang()`, `getLang()`, `locale()` (for `Intl`
  formatters) and `pick()`.
- `packages/shared/src/i18n/en/*.ts` are the English dictionaries — one file per area (`web-app.ts`,
  `web-sessions.ts`, `server.ts`, `bridge.ts`, `onboarding.ts`, …). Each maps German source text to English:

  ```ts
  // packages/shared/src/i18n/en/web-settings.ts
  const en: Record<string, string> = {
    "Einstellungen": "Settings",
    "{n} Sessions offen": "{n} open sessions",
  };
  export default en;
  ```

- `en/index.ts` merges all area files into one frozen map.
- **A missing key falls back to German.** Nothing breaks when a translation is missing; the text simply stays
  German.

### Longer texts

For whole paragraphs, prompts for Nyx or texts with different sentence structure, write both variants side by
side with `pick()`:

```ts
import { pick } from "@nyxos/shared";

const intro = pick({
  de: "Ich schaue kurz in deine offenen Sessions …",
  en: "Let me look at your open sessions …",
});
```

### Where the language comes from

| Part | Source of the language |
|---|---|
| Web app | Loaded before the first render from the server setting (`/api/app/info`); before the onboarding the browser language is used. Changing it in **Settings → Info & Help** reloads the page. |
| Server | The stored setting `lang` is applied at start and whenever it changes (texts in notifications, Telegram, Nyx's replies). |
| Bridge | Same setting, for its messages to the UI. |
| `nyxos` command, `install.sh` | The system language (`NYXOS_LANG`, `LC_ALL`, `LC_MESSAGES`, `LANG`): German if it starts with `de`, otherwise English. |

## Rules for contributors

1. **Write UI texts in German and wrap them in `t()`** — also in the server and the bridge when the text reaches
   the user.
2. **Add the English translation** to the matching `packages/shared/src/i18n/en/<area>.ts` in the same pull
   request.
3. **Keep placeholders identical** in both languages (`{n}`, `{name}`, …).
4. **Do not build sentences from pieces** (`t("Neue") + " " + t("Aufgabe")`) — translate the whole sentence
   with placeholders instead. Word order differs between languages.
5. Code, identifiers and code comments are English; only user-facing text starts in German.
6. Dates, numbers and times: use `Intl` with `locale()` and `timeZone()` from `@nyxos/shared`, never a fixed
   format.

## Improving a translation

Find the German text in the code (search for the exact string), then change its value in the English
dictionary. If the German text itself changes, the key changes too — update the English entry's key in the
same commit.

## Adding a language

Adding a third language touches a few places. Please open an issue first so we can coordinate.

1. **Types and settings**
   - `packages/shared/src/i18n/index.ts`: add the code to `Lang` and `LANGS`, to `isLang()`, and a locale in
     `locale()`.
   - `packages/shared/src/app-settings.ts`: add it to `AppLangSchema`.
2. **Dictionaries** — create `packages/shared/src/i18n/<code>/` with the same area files as `en/` and an
   `index.ts`, then teach `t()` to look up the new map. Start by copying the English files and translating the
   values (keys stay German).
3. **`pick()` variants** — `pick()` takes one variant per language. After adding the code to `Lang`,
   `pnpm typecheck` lists every place that needs a new variant.
4. **Installer and CLI** — `install.sh` and `apps/cli/nyxos.mjs` choose between German and English with a small
   `say(de, en)` helper; extend it if you want the command line translated too.
5. **Settings** — add the language to the picker under **Settings → Info & Help** and to the onboarding.
6. **Voice** (optional) — speech output voices are chosen per language; see `infra/nyx-voice/`.
7. Run `pnpm typecheck && pnpm test`.
