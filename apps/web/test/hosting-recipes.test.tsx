// Command generator of „Betrieb & Zugriff“ (features/hosting/recipes.ts). Form values must end up in the commands
// correctly AND safely – checked with a real shell (sh), not only by comparing text. The commands must match the real
// project (install.sh, nyxos, infra/, the bridge's install, the service names).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HOSTING_FORMS, DomainFormSchema, ProviderFormSchema, ServerFormSchema, t, type HostingForms } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { appendLines, clean, edition, envUpdateCommand, printLines, shPath, shq, type Recipe, type RecipeContext } from "../src/features/hosting/recipes";

const sh = (script: string, cwd?: string) => execFileSync("/bin/sh", ["-c", script], { encoding: "utf8", cwd, env: { PATH: "/usr/bin:/bin", HOME: cwd ?? tmpdir() } });

const EVIL = ["a b", "it's", 'x"y', "$(touch PWNED)", "`touch PWNED`", "a;touch PWNED", "a|touch PWNED", "a&&touch PWNED", "$HOME", "*", "~/x", "a\nb", "-rf"];

function forms(over: Partial<HostingForms> = {}): HostingForms {
  return { ...structuredClone(DEFAULT_HOSTING_FORMS), ...over };
}
const ctx: RecipeContext = { mode: "server", allowedHosts: [], way: "server", port: 47800 };
const local: RecipeContext = { mode: "local", allowedHosts: [], way: "local", port: 47810 };
const cmds = (r: Recipe) => r.steps.map((s) => s.command ?? "").join("\n");

describe("Shell quoting", () => {
  it("harmlose Werte bleiben lesbar, alles andere wird gequotet", () => {
    expect(shq("nyxos.tail1234.ts.net")).toBe("nyxos.tail1234.ts.net");
    expect(shq("203.0.113.10")).toBe("203.0.113.10");
    expect(shq("a b")).toBe("'a b'");
    expect(shq("it's")).toBe(`'it'\\''s'`);
    expect(shq("")).toBe("''");
  });

  it("jeder böse Wert kommt in der Shell genau so an (ohne Steuerzeichen) – nichts wird ausgeführt", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosting-"));
    for (const v of EVIL) {
      const out = sh(`printf '%s' ${shq(v)}`, dir);
      expect(out, v).toBe(clean(v));
    }
    expect(existsSync(join(dir, "PWNED"))).toBe(false);
  });

  it("Zeilenumbrüche werden entfernt – so entsteht nie eine zusätzliche Zeile (z. B. ProxyCommand in ~/.ssh/config)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosting-"));
    sh(appendLines(["Host x\nProxyCommand touch PWNED", "  HostName y"], "cfg"), dir);
    const lines = readFileSync(join(dir, "cfg"), "utf8").split("\n").filter(Boolean);
    expect(lines).toEqual(["Host xProxyCommand touch PWNED", "  HostName y"]);
    expect(existsSync(join(dir, "PWNED"))).toBe(false);
  });

  it("~/-Pfade bleiben Home-relativ, der Rest ist gequotet", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosting-"));
    expect(sh(`printf '%s' ${shPath("~/.ssh/id_ed25519")}`, dir)).toBe(`${dir}/.ssh/id_ed25519`);
    expect(sh(`printf '%s' ${shPath("~/a b/$(touch PWNED)")}`, dir)).toBe(`${dir}/a b/$(touch PWNED)`);
    expect(existsSync(join(dir, "PWNED"))).toBe(false);
  });

  it("printLines gibt jede Zeile einzeln und wörtlich aus", () => {
    expect(sh(printLines(["nyx.example.com {", "  reverse_proxy 127.0.0.1:47800", "}"]))).toBe("nyx.example.com {\n  reverse_proxy 127.0.0.1:47800\n}\n");
  });
});

describe(".env command", () => {
  it("ersetzt/ergänzt genau die Schlüssel, behält den Rest, legt eine Sicherung an, Rechte 600", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosting-env-"));
    writeFileSync(join(dir, ".env"), "NYXOS_DB_PASSWORD=secret\nNYXOS_ALLOWED_HOSTS=alt.ts.net\nNTFY_TOKEN=abc\n");
    sh(
      envUpdateCommand(dir, ".env", [
        ["NYXOS_ALLOWED_HOSTS", "alt.ts.net,nyxos.tail1234.ts.net"],
        ["NYXOS_AUTH_READS", "1"],
      ]),
    );
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env.split("\n").filter(Boolean)).toEqual(["NYXOS_DB_PASSWORD=secret", "NTFY_TOKEN=abc", "NYXOS_ALLOWED_HOSTS=alt.ts.net,nyxos.tail1234.ts.net", "NYXOS_AUTH_READS=1"]);
    expect(sh(`ls -a ${shq(dir)}`)).toMatch(/\.env\.bak-\d{14}/);
    expect(sh(`stat -f %Lp ${shq(join(dir, ".env"))} 2>/dev/null || stat -c %a ${shq(join(dir, ".env"))}`).trim()).toBe("600");
  });

  it("ein böser Wert landet wörtlich in der .env und wird nie ausgeführt", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosting-env-"));
    writeFileSync(join(dir, ".env"), "A=1\n");
    sh(envUpdateCommand(dir, ".env", [["NYXOS_ALLOWED_HOSTS", "x$(touch PWNED)\nEVIL=1"]]), dir);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("A=1\nNYXOS_ALLOWED_HOSTS=x$(touch PWNED)EVIL=1\n");
    expect(existsSync(join(dir, "PWNED"))).toBe(false);
  });
});

describe("Recipes", () => {
  const O = () => edition();

  it("missing required fields → no commands, a clear list", () => {
    const r = O().wayRecipe("server", forms(), ctx);
    expect(r.missing).toEqual(["Adresse", "SSH-Nutzer"]);
    expect(r.steps.filter((s) => s.command)).toHaveLength(0);
  });

  it("own server: values in the ssh config, the real steps from docs/server-mode.md", () => {
    const r = O().wayRecipe("server", forms({ server: { address: "203.0.113.10", sshUser: "ubuntu", sshPort: 2222, sshAlias: "nyx", domain: "" } }), ctx);
    const c = cmds(r);
    expect(c).toContain("'  HostName 203.0.113.10'");
    expect(c).toContain("'  User ubuntu'");
    expect(c).toContain("'  Port 2222'");
    expect(c).toContain("git clone https://github.com/VariadAgency/NyxOs---Agentic-OS.git nyxos && cd nyxos && cp infra/.env.example infra/.env && chmod 600 infra/.env");
    expect(c).toContain("docker compose -f infra/docker-compose.yml up -d --build");
    expect(c).toContain("ssh nyx 'curl -fsS http://127.0.0.1:47800/health'");
    expect(c).toContain("exec api node dist/cli.js passkey-setup");
    expect(c).toContain("exec api node dist/cli.js add-machine my-laptop");
    expect(c).toContain("launchctl bootout gui/$(id -u)/app.nyxos.server 2>/dev/null || systemctl --user disable --now nyxos-server.service");
    expect(c).toContain("~/.nyxos/runtime/node/bin/node ~/.nyxos/app/current/bridge/bridge.js install --server-url http://127.0.0.1:47801 --token-file ~/.nyxos/server-token --tunnel-host nyx --local-port 47801 --remote-port 47800");
  });

  it("the ssh config from the recipe gives exactly one clean block – even with an evil value", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosting-ssh-"));
    const r = O().wayRecipe("server", forms({ server: { address: "evil\nProxyCommand touch PWNED", sshUser: "u", sshPort: 22, sshAlias: "nyx", domain: "" } }), ctx);
    const step = r.steps.find((s) => s.command?.includes(".ssh/config"));
    expect(step).toBeTruthy();
    sh(step?.command ?? "", dir);
    const cfg = readFileSync(join(dir, ".ssh", "config"), "utf8");
    expect(cfg).not.toMatch(/^ProxyCommand/m);
    expect(cfg).toContain("  HostName evilProxyCommand touch PWNED");
    expect(cfg).toContain("ControlMaster auto");
    expect(existsSync(join(dir, "PWNED"))).toBe(false);
  });

  it("provider: how-to, public key, Docker from get.docker.com (sudo only without root)", () => {
    const r = O().wayRecipe("provider", forms({ provider: { provider: "aws-lightsail", address: "203.0.113.10", sshUser: "ubuntu", sshPort: 22, sshAlias: "nyx", keyFile: "~/.ssh/id_ed25519" } }), ctx);
    expect(r.steps[0]?.note).toMatch(/ubuntu/);
    expect(cmds(r)).toContain("ssh nyx 'curl -fsSL https://get.docker.com | sudo sh'");
    expect(cmds(r)).toContain("cat \"$HOME\"/.ssh/id_ed25519.pub");
  });

  it("this computer while running locally: no installation, the state via nyxos status/doctor", () => {
    const r = O().wayRecipe("local", forms(), local);
    const c = cmds(r);
    expect(c).not.toContain("install.sh");
    expect(c).toMatch(/nyxos status[\s\S]*nyxos doctor[\s\S]*nyxos open/);
  });

  it("this computer from a server: the one-line installer of the README", () => {
    const r = O().wayRecipe("local", forms(), { ...ctx, way: "local" });
    expect(cmds(r)).toContain("curl -fsSL https://raw.githubusercontent.com/VariadAgency/NyxOs---Agentic-OS/main/install.sh | bash");
  });

  it("autostart off: nyxos stop + systemd disable of both real units (Linux), honest note for macOS", () => {
    const r = O().wayRecipe("local", forms({ local: { autostart: false } }), local);
    const c = cmds(r);
    expect(c).toContain("nyxos stop");
    expect(c).toContain("systemctl --user disable nyxos-server.service nyxos-bridge.service");
    expect(r.steps.some((s) => s.title === "macOS" && /launchd/.test(s.note ?? ""))).toBe(true);
  });

  it("tailscale on this computer: serve to the real local port, allow the host (plist / systemd drop-in), sign-in link", () => {
    const r = O().phoneRecipe("tailscale", forms({ tailscale: { name: "nyxos.tail1234.ts.net", httpsPort: 443 } }), { ...local, allowedHosts: ["old.example.com"] });
    const c = cmds(r);
    expect(c).toContain("tailscale serve --bg --https=443 http://127.0.0.1:47810");
    expect(c).not.toContain("sudo tailscale serve");
    expect(c).toContain("plutil -replace EnvironmentVariables.NYXOS_ALLOWED_HOSTS -string old.example.com,nyxos.tail1234.ts.net ~/Library/LaunchAgents/app.nyxos.server.plist && nyxos restart");
    expect(c).toContain("~/.config/systemd/user/nyxos-server.service.d/access.conf");
    expect(c).toContain("NYXOS_NO_BROWSER=1 nyxos open");
  });

  it("the systemd drop-in from the recipe is a valid [Service] block with the merged hosts", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosting-unit-"));
    const r = O().phoneRecipe("tailscale", forms({ tailscale: { name: "nyxos.tail1234.ts.net", httpsPort: 8443 } }), local);
    const step = r.steps.find((s) => s.command?.includes("access.conf"));
    // Only the file part (without daemon-reload / nyxos restart, which must never run in tests).
    const cmd = (step?.command ?? "").split(" && systemctl")[0] ?? "";
    sh(cmd, dir);
    expect(readFileSync(join(dir, ".config/systemd/user/nyxos-server.service.d/access.conf"), "utf8")).toBe("[Service]\nEnvironment=NYXOS_ALLOWED_HOSTS=nyxos.tail1234.ts.net:8443\n");
  });

  it("the sign-in link command turns the link of `nyxos open` into one for the phone address", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosting-open-"));
    // A stand-in for `nyxos open` without a browser: the same two lines the real command prints (apps/cli/nyxos.mjs).
    writeFileSync(join(dir, "nyxos"), '#!/bin/sh\necho "Open this link in your browser (valid for 2 minutes):"\necho "  http://127.0.0.1:47810/auth/local?code=abc123&next=%2F"\n', { mode: 0o755 });
    const r = O().phoneRecipe("tailscale", forms({ tailscale: { name: "nyxos.tail1234.ts.net", httpsPort: 443 } }), local);
    const step = r.steps.find((s) => s.command?.includes("nyxos open"));
    const out = execFileSync("/bin/sh", ["-c", step?.command ?? ""], { encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin` } });
    expect(out.trim()).toBe("https://nyxos.tail1234.ts.net/auth/local?code=abc123&next=%2F");
  });

  it("tailscale on a server: sudo serve on the published port, .env with NYXOS_* and AUTH_READS=1, passkey note", () => {
    const r = O().phoneRecipe("tailscale", forms({ tailscale: { name: "nyxos.tail1234.ts.net", httpsPort: 443 } }), { ...ctx, allowedHosts: ["old.example.com"] });
    const c = cmds(r);
    expect(c).toContain("sudo tailscale serve --bg --https=443 http://127.0.0.1:47800");
    expect(c).toContain("NYXOS_ALLOWED_HOSTS=old.example.com,nyxos.tail1234.ts.net");
    expect(c).toContain("NYXOS_AUTH_READS=1");
    expect(c).toContain("cd ~/nyxos && docker compose -f infra/docker-compose.yml up -d");
    expect(r.steps.some((s) => s.where === "phone" && /Code erzeugen/.test(s.note ?? ""))).toBe(true);
  });

  it("cloudflare: the token never stands in a command, it is read hidden", () => {
    const r = O().phoneRecipe("cloudflare", forms({ cloudflare: { hostname: "nyx.example.com" } }), ctx);
    expect(cmds(r)).toContain("read -rs");
    expect(cmds(r)).toContain('cloudflared service install "$TUNNEL_TOKEN"');
    expect(r.warning).toMatch(/öffentlich/);
    const onMac = O().phoneRecipe("cloudflare", forms({ cloudflare: { hostname: "nyx.example.com" } }), local);
    expect(cmds(onMac)).toContain("brew install cloudflared");
  });

  it("own domain: Caddy block to the right port, printed literally", () => {
    const r = O().phoneRecipe("domain", forms({ domain: { domain: "nyx.example.com", email: "me@example.com" } }), ctx);
    const step = r.steps.find((s) => s.command?.includes("Caddyfile"));
    expect(sh((step?.command ?? "").split(" | sudo")[0] ?? "")).toBe("nyx.example.com {\n  reverse_proxy 127.0.0.1:47800\n  tls me@example.com\n}\n");
    expect(O().phoneRecipe("domain", forms({ domain: { domain: "nyx.example.com", email: "" } }), local).warning).toMatch(/Tailscale/);
  });
});

describe("Form messages", () => {
  it("every message of the form rules (German source text, shown through t()) has an English entry", () => {
    const issues = [
      ...(ServerFormSchema.safeParse({ address: "http://x", sshUser: "a b", sshPort: 22, sshAlias: "a b", domain: "x" }).error?.issues ?? []),
      ...(ProviderFormSchema.safeParse({ provider: "digitalocean", address: "", sshUser: "", sshPort: 22, sshAlias: "", keyFile: "a b" }).error?.issues ?? []),
      ...(DomainFormSchema.safeParse({ domain: "", email: "nope" }).error?.issues ?? []),
    ];
    const messages = [...new Set(issues.map((i) => i.message))];
    expect(messages.length).toBeGreaterThanOrEqual(6);
    for (const m of messages) expect(t(m, undefined, "en"), m).not.toBe(m);
  });
});
