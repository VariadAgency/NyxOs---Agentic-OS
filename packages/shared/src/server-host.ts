// Server-Finder (nur lesen) und Host-Daten (Temperatur, Platten, Netz, Ports …) für den Server-Tab.

/** Höchstgröße für Vorschau/Download einer Server-Datei (Text wie Bild). */
export const HOSTFS_MAX_BYTES = 2 * 1024 * 1024;
/** Größere Textdateien (Logs): nur Anfang oder Ende in dieser Größe (`?part=head|tail`). */
export const HOSTFS_PART_BYTES = 256 * 1024;
/** Höchstzahl Treffer der rekursiven Namenssuche. */
export const HOSTFS_SEARCH_MAX = 200;

/** Eine Wurzel des Server-Finders (Host-Ordner, nur lesend in den API-Container eingehängt). */
export interface HostFsRoot {
  id: string;
  label: string;
  /** Pfad auf dem Host (nur zur Anzeige). */
  hostPath: string;
  exists: boolean;
}

export interface HostFsEntry {
  name: string;
  /** Pfad relativ zur Wurzel. */
  rel: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  /** Gesperrt (Zugangsdaten, Schlüssel, Datenbank-Daten): kein Öffnen, keine Vorschau. */
  locked: boolean;
  link: boolean;
  /** Unix-Rechte (nur die unteren 9 Bits, z. B. 0o644) — fehlt bei gesperrten Einträgen. */
  mode?: number;
}

export interface HostFsRootsResponse {
  roots: HostFsRoot[];
}

export interface HostFsListResult {
  root: string;
  rel: string;
  entries: HostFsEntry[];
  truncated: boolean;
}

export interface HostFsTextResponse {
  root: string;
  rel: string;
  name: string;
  content: string;
  size: number;
  mtimeMs: number;
  /** Nur ein Teil der Datei (Datei größer als HOSTFS_MAX_BYTES): Anfang oder Ende. */
  partial?: "head" | "tail";
  /** Ganze Dateigröße (bei `partial` größer als `size`). */
  totalSize?: number;
}

/** Rekursive Namenssuche unterhalb eines Ordners (gesperrte Ordner werden nie betreten, Links nie verfolgt). */
export interface HostFsSearchResult {
  root: string;
  rel: string;
  q: string;
  entries: HostFsEntry[];
  /** Grenze erreicht (Treffer, Ordner oder Zeit) — es kann mehr geben. */
  truncated: boolean;
}

/** Verlauf im Server: alle 10 s, 360 Punkte = 60 Minuten. */
export const HOST_HISTORY_POINTS = 360;
export const HOST_SAMPLE_MS = 10_000;

/** Auslastung eines CPU-Kerns in % seit der letzten Messung (null = erste Messung). */
export interface HostCpuCore {
  id: number;
  percent: number | null;
}

/** Wofür die CPU ihre Zeit brauchte (in % der Gesamtzeit seit der letzten Messung). */
export interface HostCpuSplit {
  user: number;
  system: number;
  /** Wartet auf die Platte. */
  iowait: number;
  /** Von der virtuellen Maschine „gestohlen“ (anderer Gast auf demselben Rechner). */
  steal: number;
}

/** Durchsatz einer ganzen Platte (aus /proc/diskstats, Differenz zweier Messungen). */
export interface HostDiskIo {
  device: string;
  /** Bytes/Sekunde. */
  readRate: number | null;
  writeRate: number | null;
  /** Vorgänge/Sekunde. */
  readIops: number | null;
  writeIops: number | null;
  /** Anteil der Zeit, in der die Platte beschäftigt war (%). */
  busyPercent: number | null;
}

/** Druck (PSI) — Anteil der Zeit, in der Aufgaben auf CPU/Speicher/Platte warten mussten (%). */
export interface HostPressure {
  some10: number;
  some60: number;
  /** „full“: alle Aufgaben mussten warten (bei der CPU nicht immer gemeldet). */
  full10: number | null;
}

/** Arbeitsspeicher im Detail (Bytes). */
export interface HostMemDetail {
  free: number;
  buffers: number;
  cached: number;
  /** Rückholbarer Kernel-Speicher (SReclaimable). */
  reclaimable: number;
  /** Geteilter Speicher (tmpfs usw.). */
  shmem: number;
  /** Noch nicht auf die Platte geschrieben. */
  dirty: number;
}

/** Ein Punkt im Verlauf (alle 10 s, bis 60 Min im Server). */
export interface HostHistoryPoint {
  at: string;
  cpu: number | null;
  memUsed: number | null;
  load1: number | null;
  /** Summe aller Platten, Bytes/Sekunde. */
  diskRead: number | null;
  diskWrite: number | null;
}

export interface HostVirtualization {
  isVirtual: boolean;
  /** z. B. „virtuelle Maschine (KVM/QEMU)“ oder „eigene Hardware“. */
  label: string;
  vendor: string | null;
  product: string | null;
}

/** Docker-Angaben aus `/info` des Lese-Proxys. */
export interface HostDockerInfo {
  version: string | null;
  images: number | null;
  storageDriver: string | null;
  rootDir: string | null;
  architecture: string | null;
}

/** Erreichbarkeit eines eigenen Dienstes (`NYXOS_HOST_PROBE_HOST`, nur TLS-Handshake, es wird nichts gesendet). */
export interface HostProbe {
  host: string;
  checkedAt: string;
  ok: boolean;
  /** Dauer bis zur fertigen TLS-Verbindung in ms. */
  ms: number | null;
  certValidTo: string | null;
  certDaysLeft: number | null;
  issuer: string | null;
  error: string | null;
}

/** Eine Temperatur (Sensor), in °C. */
export interface HostTemperature {
  label: string;
  celsius: number;
}

export interface HostDisk {
  /** Wo es eingehängt ist (Anzeige-Name). */
  label: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  inodesTotal: number | null;
  inodesUsed: number | null;
}

export interface HostNetwork {
  iface: string;
  rxBytes: number;
  txBytes: number;
  /** Bytes/Sekunde seit der letzten Messung, null = erste Messung. */
  rxRate: number | null;
  txRate: number | null;
}

/** Ein von Docker veröffentlichter Port eines laufenden Containers (aus der Container-Liste des Socket-Proxys). */
export interface HostListenPort {
  /** Port auf dem Server. */
  port: number;
  /** "alle" (0.0.0.0 / ::), "lokal" (127.0.0.1 / ::1) oder die Adresse. */
  bind: string;
  proto: string;
  /** Port im Container. */
  target: number;
  container: string;
}

/** `GET /api/server/host`: alles, was sich lesen ließ; fehlt etwas, steht dort null und ein Satz in `missing`. */
export interface HostInfo {
  checkedAt: string;
  hostname: string | null;
  os: string | null;
  kernel: string | null;
  cpuModel: string | null;
  cores: number | null;
  /** CPU-Auslastung des ganzen Hosts in %, null = erste Messung. */
  cpuPercent: number | null;
  load: [number, number, number] | null;
  uptimeSeconds: number | null;
  bootedAt: string | null;
  memTotal: number | null;
  memAvailable: number | null;
  swapTotal: number | null;
  swapFree: number | null;
  temperatures: HostTemperature[];
  disks: HostDisk[];
  /** Nur die Schnittstellen des NyxOS-Containers (eigener Netz-Namensraum), nicht die des Hosts. */
  network: HostNetwork[];
  /** Veröffentlichte Ports laufender Container. Lauschende Ports des Hosts selbst sieht der Container nicht
   * (eigener Netz-Namensraum; /proc des Hosts wird bewusst NICHT eingehängt). */
  ports: HostListenPort[];
  containersRunning: number | null;
  containersTotal: number | null;
  dockerVersion: string | null;
  /** null = unbekannt (der Container sieht die Netz-Schnittstellen des Hosts nicht). */
  tailscale: boolean | null;
  // ── umfangreichere Daten (fehlt etwas: null bzw. leere Liste + Satz in `missing`) ──
  cpuCores: HostCpuCore[];
  cpuSplit: HostCpuSplit | null;
  cpuMHz: number | null;
  virtualization: HostVirtualization | null;
  processes: { running: number | null; blocked: number | null; threads: number | null; forkRate: number | null };
  contextSwitchRate: number | null;
  interruptRate: number | null;
  memDetail: HostMemDetail | null;
  /** Bytes/Sekunde, die aus dem Swap gelesen bzw. dorthin geschrieben werden. */
  swapInRate: number | null;
  swapOutRate: number | null;
  majorFaultRate: number | null;
  /** Vom Kernel beendete Prozesse wegen Speichermangel seit dem Start. */
  oomKills: number | null;
  diskIo: HostDiskIo[];
  pressure: { cpu: HostPressure | null; memory: HostPressure | null; io: HostPressure | null };
  openFiles: { used: number; max: number } | null;
  history: HostHistoryPoint[];
  docker: HostDockerInfo | null;
  probe: HostProbe | null;
  /** Klartext je fehlender Angabe (z. B. „Temperatur: keine Sensoren (virtuelle Maschine)“). */
  missing: string[];
}
