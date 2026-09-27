// Kein Docker auf dem Rechner (harte Regel) → statt eines lokalen Image-Builds prüft dieser Test die
// Bau- und Start-Beschreibung des Haiku-Motors: CLI fest versioniert im Agent-Abbild, Token nur zur
// Laufzeit aus ~/nyxos/.env (nie im Abbild, nie im API-Container), API im Server-Betrieb auf den
// Agent-Container geschaltet, Deploy startet das Profil `agent` nur mit Token. Der echte Build läuft beim Deploy.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Einen Dienst-Block aus der Compose-Datei schneiden (Einrückung 2 = Dienstname). */
function service(compose: string, name: string): string {
  const lines = compose.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start, `Dienst ${name} fehlt`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}[a-z]/.test(l) || /^[a-z]/.test(l));
  return rest.slice(0, end === -1 ? undefined : end).join("\n");
}

describe("Haiku-Motor: Abbild + Compose", () => {
  const dockerfile = read("infra/Dockerfile.agent");
  const compose = read("infra/docker-compose.yml");

  it("Agent-Abbild installiert das offizielle claude-CLI in fester Version und prüft es beim Bau", () => {
    const pin = /ARG CLAUDE_CODE_VERSION=(\S+)/.exec(dockerfile)?.[1];
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dockerfile).toMatch(/npm install -g @anthropic-ai\/claude-code@\$\{CLAUDE_CODE_VERSION\}/);
    expect(dockerfile).toMatch(/RUN claude --version/);
    // glibc-Basis: das CLI bringt ein natives Programm mit; Alpine (musl) bräuchte Zusatzpakete.
    expect(dockerfile).toMatch(/FROM node:24-bookworm-slim\s*$/m);
    expect(dockerfile).toMatch(/haiku-worker\.js/);
    expect(dockerfile).toMatch(/haiku-mcp\.js/);
  });

  it("der Token kommt nie ins Abbild (keine Anweisung nennt Token oder .env)", () => {
    const instructions = dockerfile
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    expect(instructions).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(instructions).not.toMatch(/\.env/);
  });

  it("Compose: Agent bekommt Token + Arbeiter-Geheimnis aus .env, nur internes Netz, nur Profil agent", () => {
    const agent = service(compose, "agent");
    expect(agent).toMatch(/profiles: \["agent"\]/);
    expect(agent).toMatch(/CLAUDE_CODE_OAUTH_TOKEN: \$\{CLAUDE_CODE_OAUTH_TOKEN:-\}/);
    expect(agent).toMatch(/NYXOS_WORKER_TOKEN: \$\{NYXOS_WORKER_TOKEN:-\}/);
    expect(agent).toMatch(/NYXOS_WORKER_URL: ws:\/\/api:8080\/haiku-worker/);
    expect(agent).not.toMatch(/env_file/);
    expect(agent).not.toMatch(/shop/);
    expect(agent).not.toMatch(/docker\.sock/);
  });

  it("Compose: API ist im Server-Betrieb auf den Agent-Container geschaltet, kennt nur „Token gesetzt ja/nein“", () => {
    const api = service(compose, "api");
    expect(api).toMatch(/NYXOS_HAIKU_REMOTE: "1"/);
    expect(api).toMatch(/NYXOS_HAIKU_TOKEN_SET: \$\{CLAUDE_CODE_OAUTH_TOKEN:\+1\}/);
    // env_file reicht die ganze .env durch – den Token selbst im API-Container ausdrücklich leeren.
    expect(api).toMatch(/CLAUDE_CODE_OAUTH_TOKEN: ""/);
  });

});
