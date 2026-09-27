// Kein Docker auf dem Rechner (harte Regel) → dieser Test prüft die Compose-Beschreibung von
// Socket-Proxy und Dozzle: nur lesende Rechte, kein Port auf dem Host, feste Bildversionen, kein roher
// Docker-Socket außer beim Proxy (nur lesend eingehängt), Haiku-Agent außerhalb des Docker-Netzes,
// und deploy-all.sh startet beides nur im Projekt „nyxos“ und zählt es nie als Shop-Änderung.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function service(compose: string, name: string): string {
  const lines = compose.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start, `Dienst ${name} fehlt`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}[a-z]/.test(l) || /^[a-z]/.test(l));
  return rest.slice(0, end === -1 ? undefined : end).join("\n");
}
/** Nur Konfigurationszeilen (ohne Kommentare) — sonst träfe z. B. „kein exec“ im Kommentar. */
const code = (block: string) =>
  block
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
const envValue = (block: string, key: string) => new RegExp(`^\\s+${key}: "?([^"\\n]*)"?\\s*$`, "m").exec(block)?.[1];

describe("Compose: Socket-Proxy + Dozzle", () => {
  const compose = read("infra/docker-compose.yml");
  const proxy = code(service(compose, "socket-proxy"));
  const dozzle = code(service(compose, "dozzle"));
  const api = code(service(compose, "api"));
  const agent = code(service(compose, "agent"));

  it("Socket-Proxy: nur lesen — POST und alles Schreibende aus, nur die nötigen Lesebereiche an", () => {
    expect(envValue(proxy, "POST")).toBe("0");
    for (const on of ["CONTAINERS", "ALLOW_LOGS", "IMAGES", "INFO", "EVENTS", "PING", "VERSION"]) expect(envValue(proxy, on), on).toBe("1");
    for (const off of ["EXEC", "ALLOW_START", "ALLOW_STOP", "ALLOW_RESTARTS", "ALLOW_PAUSE", "ALLOW_UNPAUSE", "ALLOW_ARCHIVE", "ALLOW_EXPORT", "BUILD", "COMMIT", "NETWORKS", "VOLUMES", "SECRETS", "SERVICES", "SWARM", "SYSTEM", "PLUGINS", "AUTH"]) {
      expect(envValue(proxy, off), off).toBe("0");
    }
    // Jede gesetzte Freigabe steht in der Liste oben — keine versteckte weitere „1“.
    const enabled = [...proxy.matchAll(/^\s+([A-Z_]+): "1"$/gm)].map((m) => m[1]).sort();
    expect(enabled).toEqual(["ALLOW_LOGS", "CONTAINERS", "EVENTS", "IMAGES", "INFO", "PING", "VERSION"]);
    // haproxy liest die Schalter als bool — auch `1` ohne Anführungszeichen, `true`, `yes`, `on`
    // schalten frei. Darum: JEDER Eintrag der Umgebung ist entweder genau "0" oder eine der erlaubten "1"
    // (einzige Ausnahme LOG_LEVEL). So fällt auch ein neu gesetztes ALLOW_TOP/ALLOW_CHANGES/LIBPOD_*/GRPC auf.
    const envBlock = /environment:\n((?:\s{6}.*\n)+)/.exec(`${proxy}\n`)?.[1] ?? "";
    const entries = [...envBlock.matchAll(/^\s+([A-Z0-9_]+):\s*(.*?)\s*$/gm)].map((m) => [m[1] ?? "", (m[2] ?? "").replace(/^"(.*)"$/, "$1")] as const);
    expect(entries.length).toBeGreaterThan(20);
    for (const [key, value] of entries) {
      if (key === "LOG_LEVEL") continue;
      if (enabled.includes(key)) expect(value, key).toBe("1");
      else expect(value, `${key} muss "0" sein`).toBe("0");
    }
    // Nicht angegeben = Standard des Abbilds; die Schreib-/Datei-Schalter stehen trotzdem ausdrücklich auf 0.
    for (const off of ["ALLOW_CHANGES", "ALLOW_TOP", "CONFIGS", "DISTRIBUTION", "NODES", "SESSION", "TASKS"]) expect(envValue(proxy, off), off).toBe("0");
    expect(proxy).toMatch(/- \/var\/run\/docker\.sock:\/var\/run\/docker\.sock:ro$/m);
    expect(proxy).toMatch(/read_only: true/);
  });

  it("kein Port auf dem Host für Proxy und Dozzle, nur das interne Netz nyxos-docker", () => {
    for (const block of [proxy, dozzle]) {
      expect(block).not.toMatch(/^\s+ports:/m);
      expect(block).not.toMatch(/^\s+network_mode:/m);
      expect(block).toMatch(/networks:\n\s+- docker\n/);
      expect(block).not.toMatch(/- intern$|- shop$/m);
    }
    expect(compose).toMatch(/ {2}docker:\n {4}name: nyxos-docker\n {4}internal: true/);
  });

  it("feste Bildversionen (kein latest, kein Tag-loses Bild)", () => {
    expect(/image: (\S+)/.exec(proxy)?.[1]).toMatch(/^lscr\.io\/linuxserver\/socket-proxy:\d+\.\d+\.\d+$/);
    expect(/image: (\S+)/.exec(dozzle)?.[1]).toMatch(/^amir20\/dozzle:v\d+\.\d+\.\d+$/);
    for (const m of compose.matchAll(/^\s+image: (\S+)$/gm)) {
      const img = m[1] ?? "";
      if (img.startsWith("nyxos-")) continue; // eigene, hier gebaute Bilder
      expect(img, img).toMatch(/:[^:]+$/);
      expect(img, img).not.toMatch(/:latest$/);
    }
  });

  it("Dozzle: nur über den Proxy, Anmeldung per Kopf von der API, Aktionen/Shell/Updates/Statistik aus", () => {
    expect(envValue(dozzle, "DOCKER_HOST")).toBe("tcp://socket-proxy:2375");
    expect(dozzle).not.toMatch(/docker\.sock/);
    expect(envValue(dozzle, "DOZZLE_BASE")).toBe("/dozzle");
    expect(envValue(dozzle, "DOZZLE_AUTH_PROVIDER")).toBe("forward-proxy");
    expect(envValue(dozzle, "DOZZLE_ENABLE_ACTIONS")).toBe("false");
    expect(envValue(dozzle, "DOZZLE_ENABLE_SHELL")).toBe("false");
    expect(envValue(dozzle, "DOZZLE_AUTO_UPDATE")).toBe("off");
    expect(envValue(dozzle, "DOZZLE_NO_ANALYTICS")).toBe("true");
  });

  it("API: erreicht Proxy/Dozzle intern, eigene Datenbank, kein Docker-Socket, keine Host-Ordner", () => {
    expect(api).not.toMatch(/docker\.sock/);
    expect(api).toMatch(/networks:\n\s+- intern\n\s+- db\n\s+- docker/);
    expect(envValue(api, "NYXOS_DOCKER_PROXY_URL")).toBe("http://socket-proxy:2375");
    expect(envValue(api, "NYXOS_DOZZLE_INTERNAL_URL")).toBe("http://dozzle:8080/dozzle");
    expect(envValue(api, "NYXOS_DOZZLE_URL")).toBe("/dozzle/");
    expect(envValue(api, "NTFY_BASE_URL")).toBe("http://ntfy:80");
    expect(envValue(api, "DATABASE_URL")).toMatch(/@postgres:5432\/nyxos$/);
    // Host-Ordner nur über die freiwillige Zusatz-Datei (docker-compose.hostfs.example.yml).
    expect(api).not.toMatch(/type: bind/);
    const hostfs = read("infra/docker-compose.hostfs.example.yml");
    for (const b of hostfs.split("type: bind").slice(1)) {
      expect(b).toMatch(/read_only: true/);
      expect(b).toMatch(/create_host_path: false/);
    }
  });

  it("der Haiku-Agent kommt nicht an den Docker-Lesezugang", () => {
    expect(agent).not.toMatch(/- docker$/m);
    expect(agent).not.toMatch(/socket-proxy|dozzle/);
  });

  it("das API-Abbild bringt die eigene Revision mit", () => {
    const dockerfile = read("infra/Dockerfile");
    expect(dockerfile).toMatch(/COPY package\.json REVISIO\[N\] \.\/meta\//);
  });
});

describe("Push (ntfy): nur im Projekt „nyxos“, von der API unter http://ntfy:80 erreichbar", () => {
  const compose = read("infra/docker-compose.yml");
  const api = code(service(compose, "api"));
  const ntfy = code(service(compose, "ntfy"));
  const networksOf = (block: string) => [.../networks:\n((?:\s+- [\w-]+\n?)+)/.exec(block)?.[1]?.matchAll(/- ([\w-]+)/g) ?? []].map((m) => m[1]);

  it("API und ntfy teilen ein Netz, ntfy lauscht im Container auf 80 (Host nur 127.0.0.1)", () => {
    expect(envValue(api, "NTFY_BASE_URL")).toBe("http://ntfy:80");
    const shared = networksOf(ntfy).filter((n) => networksOf(api).includes(n));
    expect(shared).toContain("intern");
    expect(ntfy).toMatch(/ports:\n\s+- "127\.0\.0\.1:2586:80"/);
    // Kein anderer Lausch-Port gesetzt (ntfy-Standard ist :80).
    expect(ntfy).not.toMatch(/NTFY_LISTEN_HTTP/);
  });

  it("ntfy kommt nicht an den Docker-Lesezugang", () => {
    expect(networksOf(ntfy)).not.toContain("docker");
  });

  it("ntfy läuft nur im Profil push", () => {
    expect(ntfy).toMatch(/profiles: \["push"\]/);
  });
});
