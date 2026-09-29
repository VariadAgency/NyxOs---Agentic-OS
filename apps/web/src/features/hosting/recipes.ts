// Settings → „Betrieb & Zugriff“: ALL commands and texts of the three ways and the phone access in ONE place.
//
// Every command here matches the real project: `install.sh` and the `nyxos` command (apps/cli/nyxos.mjs: open,
// status, restart, stop, doctor), the services it sets up (launchd `app.nyxos.server` / `app.nyxos.bridge`, systemd
// `nyxos-server.service` / `nyxos-bridge.service`, apps/bridge/src/service.ts), server mode with `infra/`
// (`infra/.env`, `docker compose -f infra/docker-compose.yml`, `node dist/cli.js passkey-setup|add-machine`) and the
// bridge's `install --tunnel-host` (docs/server-mode.md, docs/getting-started.md, docs/configuration.md).
// `ACTIVE_EDITION` keeps the shape shared with the private server edition; this file only carries "oss".
//
// Security: every form value ends up in a command ONLY through `shq()` (POSIX quoting in single quotes); control
// characters (line breaks …) are removed first (`clean()`), so e.g. no extra line appears in ~/.ssh/config. The forms
// also check the values strictly (packages/shared/src/hosting.ts). Secrets (tunnel token) never stand in a command –
// they are read with `read -rs` where they are needed.
import { HOSTING_PROVIDERS, NYXOS_REPO, t, type HostingForms, type HostingMode, type HostingProvider, type HostingWay, type PhoneWay } from "@nyxos/shared";

export type Edition = "oss";
export const ACTIVE_EDITION: Edition = "oss";

// ── Shell building blocks ───────────────────────────────────────────────────────────────────────────────────────

/** Removes control characters (line break, tab, ESC …). Indentation stays (ssh config, Caddyfile). */
export function clean(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, "");
}

/** Form value: without control characters and surrounding white space. */
const val = (v: string): string => clean(v).trim();

/** POSIX quoting: harmless values stay readable, everything else goes into '…' (a ' becomes '\''). */
export function shq(v: string): string {
  const s = clean(v);
  if (s !== "" && /^[A-Za-z0-9@%+=:,./_-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Quote a path with `~/` so that the shell still expands `~` to the home folder. */
export function shPath(p: string): string {
  const s = clean(p);
  if (s.startsWith("~/")) return `"$HOME"/${shq(s.slice(2))}`;
  return shq(s);
}

/** Print several lines safely (every line its own quoted argument). */
export function printLines(lines: string[]): string {
  return `printf '%s\\n' ${lines.map((l) => shq(l)).join(" ")}`;
}

/** Append several lines safely to a file. */
export function appendLines(lines: string[], target: string): string {
  return `${printLines(lines)} >> ${target}`;
}

// ── Types ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type StepWhere = "computer" | "server" | "phone" | "browser" | "provider";

export interface RecipeStep {
  title: string;
  where: StepWhere;
  /** Command to copy (missing for plain manual steps, e.g. „install the app“). */
  command?: string;
  note?: string;
}

export interface Recipe {
  steps: RecipeStep[];
  /** Required fields still missing (names as in the form). While something is missing, the page shows no commands. */
  missing: string[];
  /** Hint above the steps. */
  warning?: string;
}

export interface WayInfo {
  title: string;
  /** One sentence: what is it? */
  short: string;
  needs: string;
  permanent: string;
  cost: string;
  security: string;
  badge?: string;
}

export interface RecipeContext {
  /** How NyxOS runs right now (from the server). */
  mode: HostingMode;
  /** Addresses already allowed (never overwritten when adding one). */
  allowedHosts: string[];
  /** Chosen way (the phone recipes differ between this computer and a server). */
  way: HostingWay | null;
  /** Port of NyxOS from the server: local = the local server's port, server = the published port (default 47800). */
  port?: number;
}

export interface EditionDef {
  label: string;
  /** How the computer is called in texts. */
  machineWord: string;
  ways: Record<HostingWay, WayInfo>;
  phone: Record<PhoneWay, WayInfo>;
  wayRecipe: (way: HostingWay, forms: HostingForms, ctx: RecipeContext) => Recipe;
  phoneRecipe: (way: PhoneWay, forms: HostingForms, ctx: RecipeContext) => Recipe;
}

// ── Shared parts ────────────────────────────────────────────────────────────────────────────────────────────────

export function whereLabel(where: StepWhere): string {
  switch (where) {
    case "computer":
      return t("Auf deinem Rechner");
    case "server":
      return t("Auf dem Server");
    case "phone":
      return t("Am Handy");
    case "browser":
      return t("Im Browser");
    case "provider":
      return t("Beim Anbieter");
  }
}

/** Name in the tailnet or domain → host as the browser sends it (without :443). */
export function phoneHost(way: PhoneWay, forms: HostingForms): string | null {
  if (way === "tailscale") return forms.tailscale.name ? `${forms.tailscale.name.toLowerCase()}${forms.tailscale.httpsPort === 443 ? "" : `:${forms.tailscale.httpsPort}`}` : null;
  if (way === "cloudflare") return forms.cloudflare.hostname ? forms.cloudflare.hostname.toLowerCase() : null;
  return forms.domain.domain ? forms.domain.domain.toLowerCase() : null;
}

function mergeHosts(current: string[], add: string): string {
  const out = [...current.map((h) => val(h).toLowerCase()).filter(Boolean)];
  const h = val(add).toLowerCase();
  if (h && !out.includes(h)) out.push(h);
  return out.join(",");
}

/** Replace/add keys in a .env – with a backup copy, mode 600, values only quoted. */
export function envUpdateCommand(dir: string, file: string, entries: Array<[string, string]>): string {
  const keys = entries.map(([k]) => `-e ${shq(`^${k}=`)}`).join(" ");
  const lines = entries.map(([k, v]) => `${k}=${val(v)}`);
  return [
    `cd ${dir}`,
    `cp ${file} "${file}.bak-$(date +%Y%m%d%H%M%S)"`,
    `{ grep -v ${keys} ${file}; printf '%s\\n' ${lines.map((l) => shq(l)).join(" ")}; } > ${file}.new`,
    `chmod 600 ${file}.new`,
    `mv ${file}.new ${file}`,
  ].join(" && ");
}

function sshConfigLines(alias: string, address: string, user: string, port: number, keyFile?: string): string[] {
  const lines = ["", `Host ${val(alias)}`, `  HostName ${val(address)}`, `  User ${val(user)}`, `  Port ${port}`];
  if (keyFile) lines.push(`  IdentityFile ${val(keyFile)}`);
  // One shared connection instead of many logins (fail2ban-style protection would block the IP otherwise).
  lines.push("  ControlMaster auto", "  ControlPath ~/.ssh/cm/%r@%h:%p", "  ControlPersist 15m");
  return lines;
}

function sshConfigStep(alias: string, address: string, user: string, port: number, keyFile?: string): RecipeStep {
  return {
    title: t("SSH-Zugang „{alias}“ eintragen (eine geteilte Verbindung, sonst sperrt der Server dich evtl. aus)", { alias: val(alias) }),
    where: "computer",
    command: `mkdir -p ~/.ssh/cm && chmod 700 ~/.ssh/cm && ${appendLines(sshConfigLines(alias, address, user, port, keyFile), "~/.ssh/config")}`,
    note: t("Hängt einen Block an ~/.ssh/config an. Steht der Name dort schon, den alten Block vorher löschen."),
  };
}

function providerHowto(id: HostingProvider): string {
  switch (id) {
    case "digitalocean":
      return t("DigitalOcean (cloud.digitalocean.com) → Create → Droplets → Ubuntu 24.04, kleinste Größe mit 2 GB RAM, Anmeldung „SSH Key“. Die IPv4-Adresse oben eintragen.");
    case "netcup":
      return t("netcup Kundenbereich → VPS oder Root-Server mit Ubuntu 24.04 bestellen, im Server Control Panel deinen SSH-Schlüssel hinterlegen. Die IP-Adresse oben eintragen.");
    case "ionos":
      return t("IONOS Cloud Panel → „Server & Cloud“ → VPS mit Ubuntu 24.04, SSH-Schlüssel hinterlegen. Die IP-Adresse oben eintragen.");
    case "aws-lightsail":
      return t("AWS Lightsail → „Create instance“ → Linux/Unix → „OS Only“ → Ubuntu 24.04, 2 GB RAM. Der Nutzer heißt dort „ubuntu“. Die öffentliche IP oben eintragen.");
    case "other":
      return t("Beim Anbieter einen Linux-Server (Ubuntu 24.04 oder Debian 12, mind. 2 GB RAM) mit deinem SSH-Schlüssel anlegen. Die IP-Adresse oben eintragen.");
  }
}

export function providerLabel(id: HostingProvider): string {
  if (id === "other") return t("anderer");
  return HOSTING_PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

function providerPrelude(forms: HostingForms): RecipeStep[] {
  const p = forms.provider;
  const pub = p.keyFile ? `${p.keyFile}.pub` : "~/.ssh/id_ed25519.pub";
  return [
    { title: t("Server bei {provider} anlegen", { provider: providerLabel(p.provider) }), where: "provider", note: providerHowto(p.provider) },
    {
      title: t("Deinen öffentlichen SSH-Schlüssel anzeigen (beim Anbieter einfügen)"),
      where: "computer",
      command: `test -f ${shPath(pub)} || ssh-keygen -t ed25519 -f ${shPath(pub.replace(/\.pub$/, ""))}; cat ${shPath(pub)}`,
      note: t("Gibt es noch keinen Schlüssel, legt der Befehl einen an. Nur die .pub-Datei weitergeben, nie die ohne Endung."),
    },
  ];
}

function dockerInstallStep(alias: string, user: string): RecipeStep {
  const sudo = val(user) === "root" ? "" : "sudo ";
  return {
    title: t("Docker installieren (offizielles Skript von docker.com)"),
    where: "server",
    command: `ssh ${shq(alias)} ${shq(`curl -fsSL https://get.docker.com | ${sudo}sh`)}`,
    note: t("Keinen weiteren Port öffnen – NyxOS lauscht auf dem Server nur an 127.0.0.1."),
  };
}

function required(pairs: Array<[string, string | undefined]>): string[] {
  return pairs.filter(([, v]) => !v?.trim()).map(([label]) => label);
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Published port on the server (infra/docker-compose.yml: 127.0.0.1:${NYXOS_PORT:-47800}). */
const SERVER_PORT = 47800;
/** Local end of the bridge's SSH tunnel (docs/server-mode.md, option A). */
const TUNNEL_PORT = 47801;
const COMPOSE = "docker compose -f infra/docker-compose.yml";
const BRIDGE = "~/.nyxos/runtime/node/bin/node ~/.nyxos/app/current/bridge/bridge.js install";
const SERVER_UNIT = "nyxos-server.service";
const BRIDGE_UNIT = "nyxos-bridge.service";
const CLOUDFLARED_DEB = "curl -fsSL -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && sudo dpkg -i /tmp/cloudflared.deb";

/** Does the phone recipe target this computer (local mode) or a server? */
function isLocal(ctx: RecipeContext): boolean {
  return (ctx.way ?? (ctx.mode === "server" ? "server" : "local")) === "local";
}

/** Port NyxOS listens on in the chosen setup (the server knows its own; otherwise the default). */
function portOf(ctx: RecipeContext): number {
  const own = isLocal(ctx) ? ctx.mode !== "server" : ctx.mode === "server";
  return own ? (ctx.port ?? SERVER_PORT) : SERVER_PORT;
}

function serverSteps(alias: string): RecipeStep[] {
  const on = (cmd: string) => `ssh ${shq(alias)} ${shq(`cd nyxos && ${cmd}`)}`;
  return [
    {
      title: t("NyxOS holen und Einstellungsdatei anlegen"),
      where: "server",
      command: `ssh ${shq(alias)} ${shq(`git clone https://github.com/${NYXOS_REPO}.git nyxos && cd nyxos && cp infra/.env.example infra/.env && chmod 600 infra/.env`)}`,
    },
    {
      title: t("infra/.env ausfüllen"),
      where: "server",
      note: t("Datenbank-Passwort (openssl rand -base64 24), NYXOS_SECRETS_KEY (openssl rand -base64 32 – gut aufheben!), NYXOS_AUTH_READS=1. Die Beispieldatei erklärt jeden Eintrag."),
    },
    { title: t("Starten"), where: "server", command: on(`${COMPOSE} up -d --build`) },
    { title: t("Prüfen: NyxOS antwortet auf dem Server"), where: "server", command: `ssh ${shq(alias)} ${shq(`curl -fsS http://127.0.0.1:${SERVER_PORT}/health`)}` },
    { title: t("Einrichtungs-Code für den Passkey"), where: "server", command: on(`${COMPOSE} exec api node dist/cli.js passkey-setup`), note: t("15 Minuten gültig.") },
    { title: t("Zugangs-Token für die Brücke erzeugen (wird einmal angezeigt)"), where: "server", command: on(`${COMPOSE} exec api node dist/cli.js add-machine my-laptop`) },
    { title: t("Token sicher speichern (vorher kopieren)"), where: "computer", command: "umask 077 && pbpaste > ~/.nyxos/server-token", note: t("macOS. Unter Linux den Token mit einem Editor in ~/.nyxos/server-token einfügen.") },
    {
      title: t("Lokalen Server abschalten (macOS / Linux)"),
      where: "computer",
      command: `launchctl bootout gui/$(id -u)/app.nyxos.server 2>/dev/null || systemctl --user disable --now ${SERVER_UNIT}`,
    },
    {
      title: t("Brücke auf den Server umstellen (SSH-Tunnel)"),
      where: "computer",
      command: `${BRIDGE} --server-url http://127.0.0.1:${TUNNEL_PORT} --token-file ~/.nyxos/server-token --tunnel-host ${shq(alias)} --local-port ${TUNNEL_PORT} --remote-port ${SERVER_PORT}`,
      note: t("„nyxos update“ stellt die Brücke wieder auf den Lokal-Modus – danach diesen Befehl wiederholen."),
    },
    { title: t("Öffnen"), where: "browser", note: `http://127.0.0.1:${TUNNEL_PORT}` },
  ];
}

/** Allow the phone address in NyxOS and sign in there. */
function accessSteps(host: string, ctx: RecipeContext): RecipeStep[] {
  const hosts = mergeHosts(ctx.allowedHosts, host);
  if (isLocal(ctx)) {
    return [
      {
        title: t("Adresse in NyxOS erlauben (macOS)"),
        where: "computer",
        command: `plutil -replace EnvironmentVariables.NYXOS_ALLOWED_HOSTS -string ${shq(hosts)} ~/Library/LaunchAgents/app.nyxos.server.plist && nyxos restart`,
        note: t("„nyxos update“ schreibt diese Datei neu – danach den Befehl wiederholen."),
      },
      {
        title: t("Adresse in NyxOS erlauben (Linux)"),
        where: "computer",
        command: `mkdir -p ~/.config/systemd/user/${SERVER_UNIT}.d && ${printLines(["[Service]", `Environment=NYXOS_ALLOWED_HOSTS=${hosts}`])} > ~/.config/systemd/user/${SERVER_UNIT}.d/access.conf && systemctl --user daemon-reload && nyxos restart`,
        note: t("Eine Zusatz-Datei neben dem Dienst – „nyxos update“ lässt sie stehen."),
      },
      {
        title: t("Am Handy anmelden (einmaliger Link)"),
        where: "computer",
        command: `NYXOS_NO_BROWSER=1 nyxos open | sed -n ${shq(`s#http://127.0.0.1:[0-9]*#https://${val(host)}#p`)}`,
        note: t("Gibt einen Anmelde-Link für diese Adresse aus – 2 Minuten gültig, nur einmal. Öffne ihn am Handy (z. B. an dich selbst schicken). Im Lokal-Modus gibt es keine Passkeys; die Anmeldung hält 30 Tage und verlängert sich beim Benutzen."),
      },
    ];
  }
  return [
    {
      title: t("Adresse in NyxOS erlauben + Anmeldung auch zum Lesen"),
      where: "server",
      command: envUpdateCommand("~/nyxos", "infra/.env", [
        ["NYXOS_ALLOWED_HOSTS", hosts],
        ["NYXOS_AUTH_READS", "1"],
      ]),
      note: t("Auf dem Server (per ssh). Ohne NYXOS_AUTH_READS=1 startet NyxOS absichtlich nicht. Legt vorher eine Sicherungskopie der .env an."),
    },
    { title: t("Neu starten"), where: "server", command: `cd ~/nyxos && ${COMPOSE} up -d` },
    {
      title: t("Passkey für die neue Adresse"),
      where: "phone",
      note: t("Ein Passkey gilt nur für die Adresse, unter der er angelegt wurde. Am Rechner: Einstellungen → Konto & Anmeldung → „Code erzeugen“. Dann am Handy die Adresse öffnen → „Anmelden“ → Code eintragen."),
    },
  ];
}

function oss(): EditionDef {
  return {
    label: t("NyxOS (Open Source)"),
    machineWord: t("Rechner"),
    ways: {
      local: {
        title: t("Auf diesem Rechner"),
        short: t("NyxOS läuft ganz auf deinem Rechner – ein Befehl richtet alles ein."),
        needs: t("macOS 13+ oder Linux mit systemd."),
        permanent: t("Nur solange der Rechner an ist und nicht schläft."),
        cost: t("Kostenlos."),
        security: t("Alles bleibt auf dem Rechner, nur über 127.0.0.1 erreichbar."),
      },
      server: {
        title: t("Eigener Server"),
        short: t("NyxOS läuft auf einem Server, der dir gehört oder den du schon mietest. Auf deinem Rechner bleibt nur die Brücke."),
        needs: t("Einen Linux-Server mit Docker und SSH-Zugang."),
        permanent: t("Ja – rund um die Uhr, auch wenn dein Rechner schläft."),
        cost: t("Was der Server ohnehin kostet."),
        security: t("Kein offener Port: nur über SSH-Tunnel oder Tailscale erreichbar."),
      },
      provider: {
        title: t("Fremder Server / Anbieter"),
        short: t("Du mietest einen kleinen Server bei einem Anbieter und NyxOS läuft dort."),
        needs: t("Ein Konto beim Anbieter und einen SSH-Schlüssel."),
        permanent: t("Ja – rund um die Uhr."),
        cost: t("Etwa 4–10 € im Monat für einen kleinen Server."),
        security: t("Kein offener Port außer SSH; Zugriff über Tunnel oder Tailscale."),
      },
    },
    phone: {
      tailscale: {
        title: "Tailscale",
        short: t("Ein privates Netz zwischen deinen Geräten. Das Handy erreicht NyxOS, als wäre es im selben WLAN."),
        needs: t("Tailscale auf dem Rechner bzw. Server und am Handy (ein Konto)."),
        permanent: t("Ja, solange der Rechner bzw. Server läuft."),
        cost: t("Kostenlos für private Nutzung."),
        security: t("Nur deine eigenen Geräte kommen dran – nichts ist öffentlich im Internet."),
        badge: t("Empfohlen"),
      },
      cloudflare: {
        title: "Cloudflare Tunnel",
        short: t("Cloudflare leitet eine Adresse deiner Domain zu NyxOS weiter, ohne dass ein Port offen ist."),
        needs: t("Eine Domain bei Cloudflare und ein kostenloses Cloudflare-Konto."),
        permanent: t("Ja, der Tunnel läuft als Dienst."),
        cost: t("Kostenlos (die Domain kostet etwa 1–15 € im Jahr)."),
        security: t("Öffentlich im Internet – geschützt nur durch die Anmeldung. Am besten Cloudflare Access davorschalten."),
      },
      domain: {
        title: t("Eigene Domain mit HTTPS"),
        short: t("Deine Domain zeigt direkt auf den Server; Caddy holt das Zertifikat automatisch."),
        needs: t("Eine Domain und einen Server mit offenen Ports 80 und 443."),
        permanent: t("Ja."),
        cost: t("Nur die Domain (etwa 1–15 € im Jahr)."),
        security: t("Öffentlich im Internet – geschützt nur durch die Anmeldung (Passkey)."),
      },
    },
    wayRecipe(way, forms, ctx) {
      if (way === "local") {
        // Local mode IS this way: no installation, only the state and the real service switches.
        const steps: RecipeStep[] =
          ctx.mode === "local"
            ? [
                { title: t("Zustand von Server und Brücke"), where: "computer", command: "nyxos status", note: t("NyxOS läuft schon auf diesem Rechner.") },
                { title: t("Voraussetzungen prüfen"), where: "computer", command: "nyxos doctor" },
              ]
            : [
                {
                  title: t("Installieren"),
                  where: "computer",
                  command: `curl -fsSL https://raw.githubusercontent.com/${NYXOS_REPO}/main/install.sh | bash`,
                  note: t("Richtet Server und Brücke als Dienste ein (launchd bzw. systemd) und öffnet den Browser."),
                },
                { title: t("Prüfen"), where: "computer", command: "nyxos doctor" },
              ];
        if (forms.local.autostart) {
          steps.push({ title: t("Autostart: an (Standard)"), where: "computer", note: t("Server und Brücke laufen als Dienste und starten mit dem Rechner (macOS: launchd, Linux: systemd). Neu starten: nyxos restart") });
        } else {
          const units = `${SERVER_UNIT} ${BRIDGE_UNIT}`;
          steps.push(
            { title: t("Jetzt anhalten (Server und Brücke)"), where: "computer", command: "nyxos stop" },
            {
              title: t("Nicht mehr von selbst starten (Linux)"),
              where: "computer",
              command: `systemctl --user disable ${units}`,
              note: t("Bei Bedarf starten: systemctl --user start {units} · Autostart wieder an: systemctl --user enable --now {units}", { units }),
            },
            {
              title: "macOS",
              where: "computer",
              note: t("launchd startet Server und Brücke bei jeder Anmeldung wieder (so richtet nyxos die Dienste ein). Nach der Anmeldung also „nyxos stop“; starten mit „nyxos restart“."),
            },
          );
        }
        steps.push({ title: t("Öffnen"), where: "computer", command: "nyxos open" });
        return { steps, missing: [] };
      }
      if (way === "server") {
        const s = forms.server;
        const missing = required([
          [t("Adresse"), s.address],
          [t("SSH-Nutzer"), s.sshUser],
          [t("SSH-Name"), s.sshAlias],
        ]);
        if (missing.length) return { steps: [], missing };
        return {
          steps: [sshConfigStep(s.sshAlias, s.address, s.sshUser, s.sshPort), { title: t("Verbindung und Docker prüfen"), where: "computer", command: `ssh ${shq(s.sshAlias)} ${shq("docker compose version")}` }, ...serverSteps(s.sshAlias)],
          missing,
        };
      }
      const p = forms.provider;
      const missing = required([
        [t("Adresse"), p.address],
        [t("SSH-Nutzer"), p.sshUser],
        [t("SSH-Name"), p.sshAlias],
      ]);
      const prelude = providerPrelude(forms);
      if (missing.length) return { steps: prelude.slice(0, 1), missing };
      return { steps: [...prelude, sshConfigStep(p.sshAlias, p.address, p.sshUser, p.sshPort, p.keyFile || undefined), dockerInstallStep(p.sshAlias, p.sshUser), ...serverSteps(p.sshAlias)], missing };
    },
    phoneRecipe(way, forms, ctx) {
      const host = phoneHost(way, forms);
      const local = isLocal(ctx);
      const where: StepWhere = local ? "computer" : "server";
      const port = portOf(ctx);
      if (way === "tailscale") {
        const f = forms.tailscale;
        const missing = required([[t("Tailscale-Name"), f.name]]);
        if (!host || missing.length) return { steps: [{ title: t("Tailscale-Namen nachsehen"), where: "browser", note: t("Tailscale-Konsole → Machines. Der volle Name endet auf .ts.net.") }], missing };
        const install: RecipeStep[] = local
          ? [
              { title: t("Tailscale installieren und anmelden (macOS)"), where: "computer", note: t("Die Tailscale-App von tailscale.com/download installieren und anmelden. Den Befehl „tailscale“ bringt die App mit.") },
              { title: t("Tailscale installieren und anmelden (Linux)"), where: "computer", command: "curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up" },
            ]
          : [{ title: t("Tailscale installieren und anmelden"), where: "server", command: "curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up" }];
        return {
          missing,
          steps: [
            ...install,
            { title: t("HTTPS im Tailnet einschalten"), where: "browser", note: t("Tailscale-Konsole → DNS: „MagicDNS“ und „HTTPS Certificates“ einschalten.") },
            {
              title: t("NyxOS im Tailnet freigeben (mit HTTPS)"),
              where,
              command: `${local ? "" : "sudo "}tailscale serve --bg --https=${f.httpsPort} http://127.0.0.1:${port}`,
              note: local ? t("Unter Linux mit sudo davor. Nur Geräte in deinem Tailnet erreichen diese Adresse.") : t("Nur Geräte in deinem Tailnet erreichen diese Adresse. Ist Port 443 schon belegt, oben einen anderen HTTPS-Port wählen (z. B. 8443)."),
            },
            ...accessSteps(host, ctx),
            { title: t("Tailscale-App aufs Handy"), where: "phone", note: t("App installieren, mit demselben Konto anmelden.") },
          ],
        };
      }
      if (way === "cloudflare") {
        const missing = required([[t("Adresse (Hostname)"), forms.cloudflare.hostname]]);
        if (!host || missing.length) return { steps: [], missing };
        const install: RecipeStep[] = local
          ? [
              { title: t("cloudflared installieren (macOS)"), where: "computer", command: "brew install cloudflared" },
              { title: t("cloudflared installieren (Linux, Debian/Ubuntu)"), where: "computer", command: CLOUDFLARED_DEB, note: t("Für ARM-Rechner „arm64“ statt „amd64“.") },
            ]
          : [{ title: t("cloudflared installieren"), where: "server", command: CLOUDFLARED_DEB, note: t("Für ARM-Server „arm64“ statt „amd64“.") }];
        return {
          missing,
          warning: t("Damit ist NyxOS öffentlich im Internet erreichbar. Nur mit Anmeldung – am besten zusätzlich Cloudflare Access."),
          steps: [
            { title: t("Tunnel bei Cloudflare anlegen"), where: "browser", note: t("Cloudflare Zero Trust → Networks → Tunnels → „Create a tunnel“ (cloudflared). Public Hostname: {host} → Service http://127.0.0.1:{port}. Den Token kopieren.", { host, port }) },
            ...install,
            { title: t("Tunnel als Dienst starten (Token verdeckt eingeben)"), where, command: 'read -rs -p "Tunnel-Token: " TUNNEL_TOKEN && echo && sudo cloudflared service install "$TUNNEL_TOKEN"; unset TUNNEL_TOKEN', note: t("Der Token erscheint nicht auf dem Bildschirm und nicht im Verlauf.") },
            ...accessSteps(host, ctx),
          ],
        };
      }
      const d = forms.domain;
      const missing = required([[t("Domain"), d.domain]]);
      if (!host || missing.length) return { steps: [], missing };
      const site = [`${host} {`, `  reverse_proxy 127.0.0.1:${port}`, ...(d.email ? [`  tls ${d.email}`] : []), "}"];
      return {
        missing,
        warning: local ? t("Eine eigene Domain braucht einen dauerhaft erreichbaren Rechner mit offenen Ports 80/443 – für den Lokal-Modus passt Tailscale besser.") : undefined,
        steps: [
          { title: t("DNS-Eintrag setzen"), where: "provider", note: t("Beim Domain-Anbieter einen A-Eintrag {host} → öffentliche IP-Adresse des Servers.", { host }) },
          { title: t("Caddy installieren (Debian/Ubuntu)"), where, command: "sudo apt install -y caddy" },
          { title: t("Adresse in Caddy eintragen und neu laden"), where, command: `${printLines(site)} | sudo tee -a /etc/caddy/Caddyfile >/dev/null && sudo systemctl reload caddy`, note: t("Caddy holt das HTTPS-Zertifikat selbst (Let’s Encrypt).") },
          ...accessSteps(host, ctx),
        ],
      };
    },
  };
}

export const EDITIONS: Record<Edition, () => EditionDef> = { oss };
/** Built on every call, so the texts follow the chosen language. */
export const edition = (): EditionDef => EDITIONS[ACTIVE_EDITION]();
