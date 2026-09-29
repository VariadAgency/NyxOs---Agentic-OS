// Words for „Betrieb & Zugriff“ – from the server's facts, never claiming more than was checked
// („reachable“ only after a successful check or a real access from outside, each with its time).
import { dateTimeFormat, quote, t, type HostingCheckCode, type HostingCheckResult, type HostingForms, type HostingProfileInput, type HostingStatus, type HostingWay, type PhoneWay } from "@nyxos/shared";
import { edition, providerLabel } from "./recipes";

export type Tone = "ok" | "wait" | "bad" | "mut";

export interface StatusLine {
  id: string;
  tone: Tone;
  text: string;
}

/** „vor 3 Min“, „heute um 14:02“, „am 27.09. um 14:02“ – relative to the server clock. */
export function when(iso: string, serverNow: string | number = Date.now()): string {
  const at = Date.parse(iso);
  const now = typeof serverNow === "number" ? serverNow : Date.parse(serverNow);
  if (!Number.isFinite(at)) return "";
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return t("gerade eben");
  if (diff < 60 * 60_000) return t("vor {n} Min", { n: Math.round(diff / 60_000) });
  const d = new Date(at);
  const time = dateTimeFormat({ hour: "2-digit", minute: "2-digit" }).format(d);
  if (new Date(now).toDateString() === d.toDateString()) return t("heute um {time}", { time });
  return t("am {date} um {time}", { date: dateTimeFormat({ day: "2-digit", month: "2-digit" }).format(d), time });
}

export function statusLines(s: HostingStatus): StatusLine[] {
  const lines: StatusLine[] = [];
  const name = s.hostName ? ` ${quote(s.hostName)}` : "";
  if (s.mode === "server") {
    const addr = s.allowedHosts.length ? t("Erlaubte Adressen: {hosts}.", { hosts: s.allowedHosts.join(", ") }) : t("Nur über den SSH-Tunnel (127.0.0.1) erreichbar.");
    lines.push({ id: "mode", tone: "ok", text: `${t("Läuft auf deinem Server{name}.", { name })} ${addr}` });
  } else if (s.mode === "local") {
    lines.push({
      id: "mode",
      tone: "ok",
      text: s.allowedHosts.length
        ? t("Läuft auf diesem Rechner{name}, über 127.0.0.1:{port} und {hosts}.", { name, port: s.port, hosts: s.allowedHosts.join(", ") })
        : t("Läuft auf diesem Rechner{name}, nur über 127.0.0.1:{port}.", { name, port: s.port }),
    });
  } else {
    lines.push({ id: "mode", tone: "wait", text: t("Läuft als Probe-Server auf diesem Rechner{name} – nur zum Testen.", { name }) });
  }
  if (s.request.host) {
    lines.push({
      id: "request",
      tone: s.request.https || !s.request.remote ? "ok" : "wait",
      text: s.request.https
        ? t("Du bist gerade verbunden über {host} (HTTPS).", { host: s.request.host })
        : s.request.remote
          ? t("Du bist gerade verbunden über {host} – ohne HTTPS.", { host: s.request.host })
          : t("Du bist gerade verbunden über {host}.", { host: s.request.host }),
    });
  }
  const b = s.bridge;
  const reason = b.reason ? ` (${b.reason})` : "";
  if (b.state === "online") lines.push({ id: "bridge", tone: "ok", text: b.machine ? t("Die Brücke auf {machine} ist verbunden.", { machine: quote(b.machine) }) : t("Die Brücke ist verbunden.") });
  else if (b.state === "reconnecting") lines.push({ id: "bridge", tone: "wait", text: t("Die Brücke verbindet sich neu{reason} …", { reason }) });
  else lines.push({ id: "bridge", tone: "bad", text: t("Die Brücke ist nicht verbunden{reason}.", { reason }) });

  const p = s.phone;
  if (p.state === "reachable") {
    const proof =
      p.check?.verdict === "ok"
        ? t("geprüft {when} über {url}", { when: when(p.check.at, s.serverNow), url: p.check.url })
        : p.lastRemote
          ? p.lastRemote.mobile
            ? t("zuletzt vom Handy geöffnet {when} über {host}", { when: when(p.lastRemote.at, s.serverNow), host: p.lastRemote.host })
            : t("zuletzt geöffnet {when} über {host}", { when: when(p.lastRemote.at, s.serverNow), host: p.lastRemote.host })
          : "";
    lines.push({ id: "phone", tone: "ok", text: t("Vom Handy: erreichbar – {proof}.", { proof }) });
  } else if (p.state === "unreachable") {
    lines.push({ id: "phone", tone: "bad", text: t("Vom Handy: nicht erreichbar – letzte Prüfung {when}: {result}", { when: p.check ? when(p.check.at, s.serverNow) : "", result: p.check ? checkText(p.check) : "" }) });
  } else if (p.state === "not_checked" && p.check?.code === "dns") {
    lines.push({ id: "phone", tone: "wait", text: t("Vom Handy: noch nicht bestätigt – NyxOS kennt den Namen {url} nicht (Tailscale-Namen kennt oft nur dein Tailnet). Öffne die Adresse am Handy, dann steht hier „erreichbar“.", { url: p.url }) });
  } else if (p.state === "not_checked") {
    lines.push({ id: "phone", tone: "wait", text: t("Vom Handy: eingerichtet ({url}), aber noch nicht geprüft.", { url: p.url }) });
  } else {
    lines.push({ id: "phone", tone: "mut", text: t("Vom Handy: noch nicht erreichbar.") });
  }
  lines.push({
    id: "auth",
    tone: s.authReads ? "ok" : s.allowedHosts.length ? "bad" : "mut",
    text: s.authReads ? t("Anmeldung nötig – auch nur zum Lesen.") : t("Lesen geht ohne Anmeldung (in Ordnung, solange NyxOS nur über 127.0.0.1 erreichbar ist)."),
  });
  return lines;
}

export function checkText(r: HostingCheckResult): string {
  const code: HostingCheckCode = r.code;
  switch (code) {
    case "ok":
      return t("Erreichbar: NyxOS antwortet über HTTPS unter {url}.", { url: r.url });
    case "host_not_allowed":
      return t("NyxOS antwortet unter {url}, lässt diese Adresse aber noch nicht zu. Den Schritt „Adresse in NyxOS erlauben“ ausführen.", { url: r.url });
    case "no_https":
      return t("NyxOS antwortet, aber ohne HTTPS – am Handy klappt die Anmeldung so nicht.");
    case "nyx_unhealthy":
      return r.detail ? t("NyxOS antwortet, meldet aber ein Problem ({detail}).", { detail: r.detail }) : t("NyxOS antwortet, meldet aber ein Problem.");
    case "not_nyx":
      return t("Unter {url} antwortet etwas – aber nicht NyxOS.", { url: r.url });
    case "http_error":
      return t("Die Adresse antwortet mit Fehler {status}.", { status: r.status ?? "?" });
    case "timeout":
      return t("Keine Antwort innerhalb von 6 Sekunden.");
    case "dns":
      return t("Diese Adresse findet NyxOS im Netz nicht. Tailscale-Namen kennt oft nur dein Tailnet – öffne die Adresse am Handy, NyxOS merkt sich den Zugriff hier.");
    case "blocked":
      return t("Diese Adresse zeigt ins interne Netz – NyxOS ruft sie aus Sicherheitsgründen nicht auf.");
    case "invalid_url":
      return t("Das ist keine gültige Adresse (nur http:// oder https://, ohne Nutzername).");
    case "network":
      return t("Keine Verbindung – abgelehnt oder unterbrochen.");
    case "self_ok":
      return t("NyxOS läuft hier auf diesem Rechner und ist gesund.");
    case "self_elsewhere":
      return t("NyxOS läuft gerade auf dem Server, nicht auf diesem Rechner – von hier aus nicht prüfbar. Den Zustand auf dem Rechner zeigt „nyxos status“.");
  }
}

export const WAY_TITLES = (): Record<HostingWay, string> => {
  const w = edition().ways;
  return { local: w.local.title, server: w.server.title, provider: w.provider.title };
};
export const PHONE_TITLES = (): Record<PhoneWay, string> => {
  const p = edition().phone;
  return { tailscale: p.tailscale.title, cloudflare: p.cloudflare.title, domain: p.domain.title };
};

function formSummary(key: HostingWay | PhoneWay, f: HostingForms): string {
  const v = (label: string, value: string | number | boolean) => (value === "" ? `${label}: ${t("(leer)")}` : `${label}: ${String(value)}`);
  switch (key) {
    case "local":
      return v(t("Autostart"), f.local.autostart ? t("an") : t("aus"));
    case "server":
      return [v(t("Adresse"), f.server.address), v(t("SSH-Nutzer"), f.server.sshUser), v(t("SSH-Port"), f.server.sshPort), v(t("SSH-Name"), f.server.sshAlias), v(t("Domain"), f.server.domain)].join(", ");
    case "provider":
      return [v(t("Anbieter"), providerLabel(f.provider.provider)), v(t("Adresse"), f.provider.address), v(t("SSH-Nutzer"), f.provider.sshUser), v(t("SSH-Port"), f.provider.sshPort), v(t("SSH-Name"), f.provider.sshAlias), v(t("Schlüssel"), f.provider.keyFile)].join(", ");
    case "tailscale":
      return [v(t("Tailscale-Name"), f.tailscale.name), v(t("HTTPS-Port"), f.tailscale.httpsPort)].join(", ");
    case "cloudflare":
      return v(t("Adresse"), f.cloudflare.hostname);
    case "domain":
      return [v(t("Domain"), f.domain.domain), v(t("Zertifikats-Mail"), f.domain.email)].join(", ");
  }
}

/**
 * Prepared request for Nyx: chosen way + form values (WITHOUT secrets – the page does not even know them, only „set
 * yes/no“) + the current state. Nyx may read „Betrieb & Zugriff“, run checks and save the form.
 */
export function nyxHelpPrompt(input: { profile: HostingProfileInput; status: HostingStatus | null; secretsSet: string[]; focus?: HostingWay | PhoneWay }): string {
  const { profile, status, focus } = input;
  const wt = WAY_TITLES();
  const pt = PHONE_TITLES();
  const title = (k: HostingWay | PhoneWay) => (k in wt ? wt[k as HostingWay] : pt[k as PhoneWay]);
  const out: string[] = [];
  out.push(t("Hilf mir, NyxOS einzurichten (Einstellungen → Betrieb & Zugriff, Fassung: {edition}).", { edition: edition().label }));
  if (focus) out.push(t("Es geht gerade um: {what}.", { what: title(focus) }));
  out.push(t("Wo NyxOS laufen soll: {what}.", { what: profile.way ? `${wt[profile.way]} – ${formSummary(profile.way, profile.forms)}` : t("noch nicht gewählt") }));
  out.push(t("Vom Handy erreichen: {what}.", { what: profile.phoneWay ? `${pt[profile.phoneWay]} – ${formSummary(profile.phoneWay, profile.forms)}` : t("noch nicht gewählt") }));
  if (focus && focus !== profile.way && focus !== profile.phoneWay) out.push(t("Formular {name}: {values}.", { name: quote(title(focus)), values: formSummary(focus, profile.forms) }));
  if (input.secretsSet.length) out.push(t("Sicher gespeichert (Wert kennst du nicht): {list}.", { list: input.secretsSet.join(", ") }));
  if (status) out.push(t("So läuft es gerade: {lines}", { lines: statusLines(status).map((l) => l.text).join(" ") }));
  out.push(t("Erklär mir kurz den nächsten Schritt. Du kannst den Stand mit GET /api/hosting/status lesen, das Formular mit PUT /api/hosting/profile speichern und eine Adresse mit POST /api/hosting/check prüfen."));
  return out.join("\n");
}
