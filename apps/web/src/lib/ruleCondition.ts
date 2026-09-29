// Lesbarer Text für eine `sort_rules`-Bedingung (Spiegel von `apps/server/src/categorize.ts
// describeCondition`, hier nur zur Anzeige — keine Logik-Verdopplung, nur Formatierung).
import { t } from "@nyxos/shared";

interface RawCondition {
  stage?: unknown;
  value?: unknown;
  anyOf?: unknown;
}

export function describeRuleCondition(condition: unknown): string {
  const c = (condition ?? {}) as RawCondition;
  switch (c.stage) {
    case "folder":
      return t("Ordner {v}", { v: String(c.value) });
    case "cwd":
      return t("Arbeitsordner {v}", { v: String(c.value) });
    case "skill":
      return t("Skill {v}", { v: String(c.value) });
    case "keyword":
      return t("Titel-Wort „{v}“", { v: Array.isArray(c.anyOf) ? c.anyOf.join(", ") : "" });
    default:
      return t("unbekannte Bedingung");
  }
}
