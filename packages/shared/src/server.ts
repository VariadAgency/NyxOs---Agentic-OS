// Server-Tab (Container, Logs, Deploys).
// Container-Daten kommen über den Socket-Proxy (nur lesen) im Compose-Projekt „nyxos“
// (`socket-proxy:2375`), Logs zusätzlich über Dozzle (`/dozzle/`, hinter der NyxOS-Anmeldung).

/** Zu welchem Bereich ein Container gehört (Gruppierung im Server-Tab). */
export type ContainerGroup = "nyxos" | "andere";

export const CONTAINER_GROUP_LABEL: Record<ContainerGroup, string> = {
  nyxos: "NyxOS",
  andere: "Andere Projekte",
};

/** Docker-Health: `none` = der Container hat keine Gesundheitsprüfung. */
export type ContainerHealth = "healthy" | "unhealthy" | "starting" | "none";

export interface ContainerInfo {
  /** Kurz-ID (12 Zeichen) — Schlüssel für die Logs (`/api/server/containers/:id/logs`). */
  id: string;
  name: string;
  group: ContainerGroup;
  /** Compose-Projekt (`com.docker.compose.project`), sonst null. */
  project: string | null;
  /** Bildname, wie Docker ihn nennt (z. B. `postgis/postgis:17-3.4-alpine`). */
  image: string;
  /** Tag aus dem Bildnamen (`17-3.4-alpine`), null bei reinen IDs. */
  imageTag: string | null;
  /** `org.opencontainers.image.version`, falls das Bild ihn trägt. */
  imageVersion: string | null;
  /** Wann das Bild gebaut wurde (Alter). */
  imageCreatedAt: string | null;
  /** running | exited | restarting | paused | created | dead */
  state: string;
  health: ContainerHealth;
  /** Wann der Container angelegt wurde (bei Compose: letzter Deploy dieses Dienstes). */
  createdAt: string | null;
  startedAt: string | null;
  restartCount: number;
  /** Neustart-Schleife (s. `isRestartLoop`) — gilt unabhängig davon, ob Docker den Container
   * im Moment der Messung als „running“ oder „restarting“ meldet. */
  restartLoop: boolean;
  /** Nur zur Anzeige, z. B. `127.0.0.1:47800 → 8080/tcp` oder `8080/tcp (intern)`. */
  ports: string[];
  /** CPU in % EINES Kerns (100 = ein ganzer Kern); null = noch kein zweiter Messpunkt. */
  cpuPercent: number | null;
  memBytes: number | null;
  memLimitBytes: number | null;
  /** Messpunkte seit dem Start der API (älteste zuerst), höchstens `CONTAINER_HISTORY_POINTS`. */
  cpuHistory: number[];
  memHistory: number[];
}

/** Wie viele Messpunkte je Container im Speicher bleiben (bei 10 s Takt ≈ 10 Minuten). */
export const CONTAINER_HISTORY_POINTS = 60;

/** so lange nach dem letzten Neustart/Absturz gilt ein oft neu gestarteter Container als „Schleife“. */
export const RESTART_LOOP_WINDOW_MS = 15 * 60_000;
/** Ab so vielen Neustarts (Docker `RestartCount`) zählt ein frischer Neustart als Schleife. */
export const RESTART_LOOP_MIN_COUNT = 3;

/**
 * (Schluss-Kritik K10): Ein Container in einer Neustart-Schleife läuft immer nur wenige
 * Sekunden. Docker meldet ihn dann mal „restarting“, mal „running“ — nur nach dem Zustand gezählt
 * sprang „Gestört“ zwischen 1 und 2. Schleife = Docker sagt „restarting“, ODER er wurde schon oft neu
 * gestartet und ist innerhalb des Fensters neu gestartet/abgestürzt. Gestoppte Container sind keine Schleife.
 */
export function isRestartLoop(c: { state: string; restartCount: number; startedAt: string | null; finishedAt: string | null }, now: number): boolean {
  if (c.state === "restarting") return true;
  if (c.state !== "running") return false;
  if (c.restartCount < RESTART_LOOP_MIN_COUNT) return false;
  const recent = (iso: string | null) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && t > 0 && now - t < RESTART_LOOP_WINDOW_MS;
  };
  return recent(c.startedAt) || recent(c.finishedAt);
}

export interface DockerAccess {
  /** false = der Socket-Proxy ist nicht erreichbar/gibt nichts frei — `reason` + `fix` sagen, was fehlt. */
  available: boolean;
  /** Ein Satz: was los ist (nie eine Rohmeldung). */
  reason: string | null;
  /** Was zu tun ist, in einem Satz. */
  fix: string | null;
  /** Der genaue Befehl dazu (zum Kopieren), null = keiner. */
  command: string | null;
  /** Zeitpunkt der zugrunde liegenden Messung| null;
  /** Zeitpunkt der zugrunde liegenden Messung (Zwischenspeicher ≤ 10 s). */
  checkedAt: string | null;
}

export interface DeployRecord {
  id: number;
  project: string; // Compose-Projekt (Ableitung, kein Eingriff)
  containerName: string;
  imageId: string;
  createdAt: string;
  gitRev: string | null;
  source: "deploy.sh" | "docker-events";
}

export interface ServerBehind {
  /** Commits, die im Repo-Zweig stecken, aber auf dem Server (REVISION-Datei) noch fehlen. */
  commits: number;
  serverRev: string | null;
  repoRev: string | null;
}

/** Etwas fehlt WIRKLICH — mit genauem Schritt. Leere Liste = nichts zu tun. */
export interface PendingStep {
  id: "socket-proxy" | "dozzle" | "revision";
  title: string;
  sentence: string;
  /** Genauer Befehl/Schritt (z. B. `docker compose up -d`). */
  command: string;
}

export type HealthCheckName = "database" | "schema" | "archive";

/** Klartext je Prüfung ("Server-Teil X gestört: <Grund>" statt einer nackten
 * roten Pille) — dieselben drei Prüfungen wie `apps/server/src/health.ts` `checkHealth()`. */
export const HEALTH_CHECK_LABEL: Record<HealthCheckName, string> = {
  database: "Datenbank",
  schema: "Schema/Migrationen",
  archive: "Archiv-Volume",
};

export interface HealthCheckResult {
  ok: boolean;
  ms: number;
  error?: string;
}

/** Aus derselben `/health`-Prüfung wie die Kopf-Pille — die Server-Seite bekommt sie
 * über `GET /api/server` mitgeliefert (ein Aufruf, keine zweite `/health`-Anfrage, die bei einer
 * echten Störung als weiterer Konsolenfehler auffällt). */
export interface HealthSnapshot {
  ok: boolean;
  checks: Record<HealthCheckName, HealthCheckResult>;
}

export interface ServerSnapshot {
  docker: DockerAccess;
  containers: ContainerInfo[];
  deploys: DeployRecord[];
  nyxosHealthy: boolean;
  health: HealthSnapshot;
  /** Welche Revision die laufende API hat (aus dem Abbild), null = unbekannt (lokale Probe). */
  runningRevision: string | null;
  /** Link zu Dozzle (live mitlesen), null = nicht eingerichtet. */
  dozzleUrl: string | null;
  /** SSH-Ziel des Servers (`NYXOS_SERVER_SSH_HOST`), null = nicht eingerichtet (Server-Terminal aus). */
  sshHost: string | null;
  /** nur, was wirklich fehlt — mit genauem Befehl. */
  pending: PendingStep[];
}

/** Eine Log-Zeile (`GET /api/server/containers/:id/logs`). */
export interface ContainerLogLine {
  at: string | null;
  stream: "out" | "err";
  text: string;
}

export interface ContainerLogs {
  id: string;
  name: string | null;
  lines: ContainerLogLine[];
  /** Angefragte Zeilenzahl (Standard 200). */
  tail: number;
}
