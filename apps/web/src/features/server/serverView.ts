// Pure helpers of the Server tab (no React, tested in apps/web/test/server-tab.test.tsx).
import { CONTAINER_GROUP_LABEL, locale, t, type ContainerGroup, type ContainerInfo } from "@nyxos/shared";

export type ContainerTone = "ok" | "wait" | "bad" | "idle";

type StatusInput = Pick<ContainerInfo, "state" | "health"> & { restartLoop?: boolean };

/** Ein Wort für den Zustand + Farbe. Health schlägt „läuft“ (ein laufender, ungesunder Container ist rot).
 * Eine Neustart-Schleife ist immer „startet ständig neu“ — auch in den Sekunden, in denen
 * Docker sie als „running“ meldet (sonst sprang „Gestört“ zwischen 1 und 2). */
export function containerStatus(c: StatusInput): { label: string; tone: ContainerTone } {
  if (c.restartLoop === true || c.state === "restarting") return { label: t("startet ständig neu"), tone: "bad" };
  if (c.state === "running") {
    if (c.health === "unhealthy") return { label: t("ungesund"), tone: "bad" };
    if (c.health === "starting") return { label: t("startet"), tone: "wait" };
    return { label: c.health === "healthy" ? t("gesund") : t("läuft"), tone: "ok" };
  }
  if (c.state === "paused") return { label: t("pausiert"), tone: "wait" };
  if (c.state === "dead") return { label: t("tot"), tone: "bad" };
  if (c.state === "created") return { label: t("angelegt, nie gestartet"), tone: "idle" };
  return { label: t("gestoppt"), tone: "idle" };
}

/** Braucht Aufmerksamkeit: ungesund, Neustart-Schleife, tot. Gestoppte Container zählen nicht. */
export const isTroubled = (c: StatusInput) => containerStatus(c).tone === "bad";

/** Läuft wirklich (nicht nur die paar Sekunden zwischen zwei Abstürzen einer Neustart-Schleife). */
export const isSteadyRunning = (c: Pick<ContainerInfo, "state"> & { restartLoop?: boolean }) => c.state === "running" && c.restartLoop !== true;

export interface ContainerSection {
  group: ContainerGroup;
  label: string;
  containers: ContainerInfo[];
  /** Nur bei „Andere“: Unterteilung nach Compose-Projekt (oder Namens-Anfang ohne Projekt). */
  projects: Array<{ project: string; containers: ContainerInfo[] }>;
  running: number;
  troubled: number;
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const projectKey = (c: ContainerInfo) => c.project ?? c.name.split(/[-_]/)[0] ?? c.name;

/** NyxOS first, other known groups next, „andere“ last. Unknown groups from newer servers still show up. */
const groupRank = (g: string) => (g === "nyxos" ? 0 : g === "andere" ? 2 : 1);

/** Label of a group; groups without a label get their name capitalized. */
export function groupLabel(group: ContainerGroup): string {
  const label = (CONTAINER_GROUP_LABEL as Partial<Record<string, string>>)[group];
  return label ? t(label) : capitalize(group);
}

export function groupContainers(list: ContainerInfo[]): ContainerSection[] {
  const order = [...new Set<ContainerGroup>(list.map((c) => c.group))].sort((a, b) => groupRank(a) - groupRank(b) || a.localeCompare(b));
  return order
    .map((group) => {
      const containers = list.filter((c) => c.group === group).sort((a, b) => Number(isTroubled(b)) - Number(isTroubled(a)) || a.name.localeCompare(b.name));
      const byProject = new Map<string, ContainerInfo[]>();
      for (const c of containers) byProject.set(projectKey(c), [...(byProject.get(projectKey(c)) ?? []), c]);
      return {
        group,
        label: groupLabel(group),
        containers,
        projects: [...byProject.entries()].map(([project, cs]) => ({ project, containers: cs })).sort((a, b) => a.project.localeCompare(b.project)),
        running: containers.filter(isSteadyRunning).length,
        troubled: containers.filter(isTroubled).length,
      };
    })
    .filter((s) => s.containers.length > 0);
}

/** Ampel für die Kompakt-Kachel — grün läuft sauber, gelb läuft mit Problem (ungesund,
 * startet, Neustart-Schleife, pausiert), rot läuft nicht (gestoppt, nie gestartet, tot). */
export type ContainerLight = "green" | "yellow" | "red";

export function containerLight(c: StatusInput): ContainerLight {
  if (c.restartLoop === true || c.state === "restarting" || c.state === "paused") return "yellow";
  if (c.state === "running") return c.health === "unhealthy" || c.health === "starting" ? "yellow" : "green";
  return "red";
}

/** Eine aufklappbare Container-Gruppe: NyxOS und jedes andere Compose-Projekt einzeln. */
export interface ContainerBucket {
  key: string;
  label: string;
  group: ContainerGroup;
  containers: ContainerInfo[];
  running: number;
  troubled: number;
  lights: Record<ContainerLight, number>;
}

export function containerBuckets(list: ContainerInfo[]): ContainerBucket[] {
  const make = (key: string, label: string, group: ContainerGroup, containers: ContainerInfo[]): ContainerBucket => {
    const lights: Record<ContainerLight, number> = { green: 0, yellow: 0, red: 0 };
    for (const c of containers) lights[containerLight(c)] += 1;
    return { key, label, group, containers, running: containers.filter(isSteadyRunning).length, troubled: containers.filter(isTroubled).length, lights };
  };
  const out: ContainerBucket[] = [];
  for (const s of groupContainers(list)) {
    if (s.group !== "andere") out.push(make(s.group, s.label, s.group, s.containers));
    else for (const p of s.projects) out.push(make(`p:${p.project}`, capitalize(p.project), "andere", p.containers));
  }
  return out;
}

/** Summe je Messpunkt über alle Container (rechtsbündig ausgerichtet — jüngster Punkt zuletzt). */
export function sumHistories(histories: number[][]): number[] {
  const len = Math.max(0, ...histories.map((h) => h.length));
  const out = new Array<number>(len).fill(0);
  for (const h of histories) {
    const offset = len - h.length;
    h.forEach((v, i) => {
      out[offset + i] = (out[offset + i] ?? 0) + v;
    });
  }
  return out;
}

/** Decimal number in the current language („1,5“ / „1.5“). */
export const decimal = (n: number, digits = 1) => n.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });

export function formatBytes(n: number | null): string {
  if (n === null) return "–";
  if (n >= 1e9) return `${decimal(n / 1e9, n >= 1e10 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

export function formatCpu(p: number | null): string {
  if (p === null) return "–";
  return `${p < 10 ? decimal(p) : Math.round(p)} %`;
}

/** „3 T 4 Std“ / „5 Std“ / „12 Min“ — Laufzeit seit dem Start. */
export function uptime(startedAt: string | null, now: number = Date.now()): string | null {
  if (!startedAt) return null;
  const ms = now - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.floor(ms / 60_000);
  if (min < 60) return t("{n} Min", { n: min });
  const h = Math.floor(min / 60);
  if (h < 48) return t("{n} Std", { n: h });
  const d = Math.floor(h / 24);
  return d < 60 ? t("{n} T", { n: d }) : t("{n} Wo", { n: Math.round(d / 7) });
}

/** Alter eines Bildes in einfachen Worten. */
export function ageWords(iso: string | null, now: number = Date.now()): string | null {
  if (!iso) return null;
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days)) return null;
  if (days < 1) return t("heute gebaut");
  if (days < 2) return t("gestern gebaut");
  if (days < 60) return t("vor {n} T gebaut", { n: days });
  return t("vor {n} Mon gebaut", { n: Math.round(days / 30) });
}

/** SSH-Host des Servers aus dem Server-Stand (NYXOS_SERVER_SSH_HOST), null = nicht eingerichtet.
 * Tolerant: ältere oder neuere Antworten ohne das Feld bedeuten „nicht eingerichtet“. */
export function sshHostOf(snapshot: unknown): string | null {
  const s = snapshot as { sshHost?: unknown; ssh?: { host?: unknown } | null } | null | undefined;
  const raw = typeof s?.sshHost === "string" ? s.sshHost : typeof s?.ssh?.host === "string" ? s.ssh.host : null;
  return raw && raw.trim() ? raw.trim() : null;
}
