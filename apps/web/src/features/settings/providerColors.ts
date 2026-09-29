import type { ProviderKind } from "@nyxos/shared";

/**
 * Anbieter-Farben (Einstellungen → Modelle → Anbieter). Jede Farbe ist ein eigener Farbton aus der
 * POS-Palette (Tokens in `app.css`), damit sich die Punkte auf einen Blick unterscheiden:
 * Anthropic Orange (Marke), OpenAI das App-Blau (`--a-acc`, wie überall), Gemini Violett, DeepSeek Türkis,
 * OpenRouter Magenta, Groq Gelb, Mistral Lime, xAI Himmelblau, LM Studio Grün, Ollama Weiß, eigener Endpunkt Grau.
 * Vorher teilten sich Gemini und DeepSeek dasselbe Blau und OpenRouter (Indigo) lag direkt daneben.
 * `test/provider-colors.test.tsx` prüft, dass alle Werte paarweise verschieden sind.
 */
export const PROVIDER_COLOR: Record<ProviderKind, string> = {
  anthropic: "var(--a-claude)",
  openai: "var(--a-acc)",
  gemini: "var(--a-violet)",
  deepseek: "var(--a-teal)",
  openrouter: "var(--a-magenta)",
  groq: "var(--a-yellow)",
  mistral: "var(--a-lime)",
  xai: "var(--a-codex)",
  lmstudio: "var(--a-ok)",
  ollama: "var(--a-ink)",
  custom: "var(--a-idle)",
};
