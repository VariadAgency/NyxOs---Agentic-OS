import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { PENDING as TYPO_PENDING, WEB_SRC, eslintPlugin as typoPlugin } from "./scripts/lint/typography.mjs";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "apps/bridge/bin/**", "**/.dev-archive/**", ".claude/**", ".probe/**", "**/e2e/.output/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { console: "readonly", process: "readonly", Buffer: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", fetch: "readonly", performance: "readonly", URL: "readonly", AbortSignal: "readonly", WebSocket: "readonly", location: "readonly", document: "readonly", NodeJS: "readonly", Response: "readonly" } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
  // R2 · P2d-2: Schrift nur aus der Skala (text-title … text-label, apps/web/src/app.css). Feste Größen wie
  // `text-[12px]` oder `text-xs` sind verboten; `npx eslint --fix` bzw. `node scripts/lint/typography.mjs --apply`
  // ersetzt sie. Bewusste Ausnahme: Kommentar „typo-keep“ in der Zeile (Glyphen in winzigen Ringen) oder große
  // Kennzahl ≥ 26 px mit `tabular-nums`. Die Dateien in PENDING (parallel in Arbeit) folgen nach dem Codemod-Lauf.
  {
    files: [`${WEB_SRC}/**/*.{ts,tsx}`],
    ignores: TYPO_PENDING.map((g) => `${WEB_SRC}/${g}`),
    plugins: { typo: typoPlugin },
    rules: { "typo/no-fixed-font-size": "error" },
  },
);
