// Removing secrets from texts that get stored, shown to Nyx or sent somewhere (e.g. the command of an approval card:
// `curl -H "Authorization: Bearer …"`, `export GITHUB_TOKEN=…`). Used by the push log, Nyx' app_api log and the
// diagnostics of a bug report (support.ts). One place, so every caller masks the same way.

export const SECRET_MASK = "•••";

const SECRET_RULES: [RegExp, string][] = [
  [/\b(sk-ant-|sk-|ghp_|gho_|ghs_|ghu_|github_pat_|xox[abprs]-|glpat-|AKIA)[A-Za-z0-9_-]{8,}/g, SECRET_MASK],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${SECRET_MASK}`],
  [/\b([A-Za-z0-9_]*(?:token|secret|passwor[dt]|passwd|pwd|api[_-]?key|authorization|credentials?)[A-Za-z0-9_]*)(\s*[:=]\s*)("?)[^\s"']+/gi, `$1$2$3${SECRET_MASK}`],
];

/** Masks well-known key formats, `Bearer …` and `token=…`-style assignments. Idempotent. */
export function redactSecrets(text: string): string {
  return SECRET_RULES.reduce((acc, [re, rep]) => acc.replace(re, rep), text);
}
