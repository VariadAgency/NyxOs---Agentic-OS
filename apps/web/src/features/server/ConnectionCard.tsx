// „Verbindung“ — wie man NyxOS und den Server erreicht. Nur Befehle und Adressen, keine Geheimnisse.
// SSH-Befehle erscheinen nur, wenn ein SSH-Host eingerichtet ist (NYXOS_SERVER_SSH_HOST); der Schlüssel
// dazu liegt auf deinem Rechner (Eintrag in ~/.ssh/config).
import { t } from "@nyxos/shared";
import { useState } from "react";
import { Card } from "../../components/ui/Card";
import { toneVar, type Tone } from "../../lib/tones";

export interface ConnectionCommand {
  label: string;
  command: string;
  hint: string;
}

export interface ConnectionLink {
  label: string;
  href: string;
  hint: string;
  tone: Tone;
}

/** Kopierbare SSH-Befehle — nur mit eingerichtetem SSH-Host, sonst keine. */
export function serverCommands(sshHost: string | null): ConnectionCommand[] {
  if (!sshHost) return [];
  return [
    { label: t("Anmelden per SSH"), command: `ssh ${sshHost}`, hint: t("Anmeldung mit deinem SSH-Schlüssel") },
    { label: t("Tunnel zu NyxOS"), command: `ssh -N -L 127.0.0.1:47801:127.0.0.1:47800 ${sshHost}`, hint: t("macht die Brücke von selbst; nur nötig, wenn sie nicht läuft") },
    { label: t("Container ansehen"), command: `ssh ${sshHost} docker ps`, hint: t("nur lesen") },
  ];
}

/** Links: die Adresse, unter der NyxOS gerade offen ist, und Dozzle, falls eingerichtet. */
export function serverLinks(origin: string, dozzleUrl: string | null): ConnectionLink[] {
  const links: ConnectionLink[] = [];
  if (origin) links.push({ label: "NyxOS", href: origin, hint: t("diese Adresse von NyxOS"), tone: "nyx" });
  if (dozzleUrl) links.push({ label: t("Live-Logs (Dozzle)"), href: dozzleUrl, hint: t("alle Container live mitlesen"), tone: "teal" });
  return links;
}

function Copy({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md border border-a-line bg-a-bg px-2 py-1 font-mono text-caption text-a-ink" title={command}>
        {command}
      </code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="shrink-0 rounded-md border border-a-line px-2 py-1 text-caption text-a-ink transition-colors duration-150 hover:bg-a-p2"
      >
        {copied ? t("Kopiert") : t("Kopieren")}
      </button>
    </div>
  );
}

export function ConnectionCard({ tailscale, sshHost, dozzleUrl = null, local = false }: { tailscale: boolean | null; sshHost: string | null; dozzleUrl?: string | null; local?: boolean }) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const commands = serverCommands(sshHost);
  const links = serverLinks(origin, dozzleUrl);
  return (
    <Card className="grid gap-4" data-testid="server-connection">
      {commands.length > 0 ? (
        <ul className="grid gap-3">
          {commands.map((c) => (
            <li key={c.command} className="grid gap-1">
              <span className="text-callout text-a-ink">
                {c.label} <span className="text-caption text-a-mut">· {c.hint}</span>
              </span>
              <Copy command={c.command} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-caption text-a-mut">
          {local
            ? t("NyxOS läuft auf diesem Rechner. Für ein Terminal zu einem Server trägst du dessen SSH-Host als NYXOS_SERVER_SSH_HOST ein.")
            : t("Kein SSH-Host eingerichtet. Mit NYXOS_SERVER_SSH_HOST erscheinen hier die Befehle zum Anmelden und das Terminal zum Server.")}
        </p>
      )}
      {links.length > 0 && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))] gap-2">
          {links.map((l) => (
            <li key={l.href}>
              <a href={l.href} target="_blank" rel="noreferrer" className="grid gap-0.5 rounded-lg border border-a-line px-3 py-2 transition-colors duration-150 hover:bg-a-p2">
                <span className="flex items-center gap-1.5 text-callout text-a-ink">
                  <span className="h-2 w-2 rounded-full" style={{ background: toneVar(l.tone) }} aria-hidden />
                  {l.label} ↗
                </span>
                <span className="truncate font-mono text-label text-a-mut">{l.href}</span>
                <span className="text-caption text-a-mut">{l.hint}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {!local && (
        <p className="text-caption text-a-mut">
          Tailscale:{" "}
          {tailscale === null ? (
            t("unbekannt (Server-Daten nach der Anmeldung)")
          ) : tailscale ? (
            <span className="text-a-ok">{t("auf dem Server aktiv")}</span>
          ) : (
            t("noch nicht eingerichtet, Zugriff bis dahin über den SSH-Tunnel.")
          )}
        </p>
      )}
    </Card>
  );
}
