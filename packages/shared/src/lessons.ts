// Lernbuch (Einstellungen → Lernbuch) — verallgemeinert `sort_rules` auf weitere Regel-Arten.

export type RuleKind = "sortierung" | "reservierung" | "konflikt" | "freigabe";

export interface LearnedRule {
  id: number;
  kind: RuleKind;
  /** z. B. { folderPrefix: "App/backend" } — Bedeutung hängt von `kind` ab. */
  condition: Record<string, unknown>;
  action: Record<string, unknown>;
  /** menschenlesbar: "gelernt am 25.09.2026 aus 3 Konflikten in 7 Tagen (App/backend)". */
  origin: string;
  active: boolean;
  hitCount: number;
  createdAt: string;
  lastHitAt: string | null;
}
