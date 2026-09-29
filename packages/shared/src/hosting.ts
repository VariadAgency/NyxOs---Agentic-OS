// Settings → „Betrieb & Zugriff“ (operation & access): how NyxOS runs right now (reported by the server), which way
// the user chose and the form values for it. Secrets (tunnel token, Tailscale key) are NEVER part of the profile –
// only in the server's encrypted secret store; the profile only shows „set“ + the last 4 characters.
import { z } from "zod";

/** How the server was started: `local` = one process on this computer (`local.ts`), `server` = Docker Compose on a
 * server (`main.ts`), `probe` = development server on this computer (`dev.ts`). */
export const HostingModeSchema = z.enum(["local", "server", "probe"]);
export type HostingMode = z.infer<typeof HostingModeSchema>;

/** Where NyxOS should run. */
export const HostingWaySchema = z.enum(["local", "server", "provider"]);
export type HostingWay = z.infer<typeof HostingWaySchema>;
export const HOSTING_WAYS = HostingWaySchema.options;

/** How the phone reaches NyxOS. */
export const PhoneWaySchema = z.enum(["tailscale", "cloudflare", "domain"]);
export type PhoneWay = z.infer<typeof PhoneWaySchema>;
export const PHONE_WAYS = PhoneWaySchema.options;

export const HostingCheckTargetSchema = z.enum(["local", "server", "provider", "tailscale", "cloudflare", "domain"]);
export type HostingCheckTarget = z.infer<typeof HostingCheckTargetSchema>;

export const HOSTING_PROVIDERS = [
  { id: "digitalocean", label: "DigitalOcean" },
  { id: "netcup", label: "netcup" },
  { id: "ionos", label: "IONOS" },
  { id: "aws-lightsail", label: "AWS Lightsail" },
  { id: "other", label: "anderer" },
] as const;
export const HostingProviderSchema = z.enum(["digitalocean", "netcup", "ionos", "aws-lightsail", "other"]);
export type HostingProvider = z.infer<typeof HostingProviderSchema>;

// ── Field rules: strict, so only harmless characters are stored. The commands still quote every value (second
//    safeguard, see web/features/hosting/recipes.ts). Empty ("") means „not filled in yet“.
//    The messages are German source texts; the web app translates them with t() (English in i18n/en/web-hosting.ts).
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
/** Host name (with dots) or IPv4. */
export const HOST_RE = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);
/** Name with at least one dot (domain, Tailscale name). */
export const DOMAIN_RE = new RegExp(`^(?=.{3,253}$)${LABEL}(?:\\.${LABEL})+$`);
export const SSH_USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
export const SSH_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Path of an SSH key: `~/…` or absolute, harmless characters only. */
export const KEY_PATH_RE = /^(~\/|\/)[A-Za-z0-9._/-]{1,200}$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

const opt = (re: RegExp, msg: string) => z.union([z.literal(""), z.string().trim().regex(re, msg)]);
const hostField = opt(HOST_RE, "Nur ein Rechnername oder eine IP-Adresse (ohne http://, ohne Pfad).");
const domainField = opt(DOMAIN_RE, "Nur der Name, z. B. nyxos.example.com (ohne https://, ohne Pfad).");
const userField = opt(SSH_USER_RE, "Nur Buchstaben, Ziffern, _ . - (z. B. root oder ubuntu).");
const aliasField = opt(SSH_ALIAS_RE, "Nur Buchstaben, Ziffern, _ . - (z. B. nyxos-server).");
const port = z.number().int().min(1).max(65535);

export const LocalFormSchema = z.object({ autostart: z.boolean() }).strict();
export const ServerFormSchema = z
  .object({ address: hostField, sshUser: userField, sshPort: port, sshAlias: aliasField, domain: domainField })
  .strict();
export const ProviderFormSchema = z
  .object({
    provider: HostingProviderSchema,
    address: hostField,
    sshUser: userField,
    sshPort: port,
    sshAlias: aliasField,
    keyFile: opt(KEY_PATH_RE, "Pfad zum Schlüssel, z. B. ~/.ssh/id_ed25519."),
  })
  .strict();
export const TailscaleFormSchema = z.object({ name: domainField, httpsPort: port }).strict();
export const CloudflareFormSchema = z.object({ hostname: domainField }).strict();
export const DomainFormSchema = z.object({ domain: domainField, email: opt(EMAIL_RE, "Bitte eine gültige E-Mail-Adresse.") }).strict();

export const HostingFormsSchema = z
  .object({
    local: LocalFormSchema,
    server: ServerFormSchema,
    provider: ProviderFormSchema,
    tailscale: TailscaleFormSchema,
    cloudflare: CloudflareFormSchema,
    domain: DomainFormSchema,
  })
  .strict();
export type HostingForms = z.infer<typeof HostingFormsSchema>;

/** What `PUT /api/hosting/profile` accepts. `.strict()`: unknown fields (e.g. a token) → 400. */
export const HostingProfileInputSchema = z
  .object({
    way: HostingWaySchema.nullable(),
    phoneWay: PhoneWaySchema.nullable(),
    forms: HostingFormsSchema,
  })
  .strict();
export type HostingProfileInput = z.infer<typeof HostingProfileInputSchema>;

export const DEFAULT_HOSTING_FORMS: HostingForms = {
  local: { autostart: true },
  server: { address: "", sshUser: "", sshPort: 22, sshAlias: "nyxos-server", domain: "" },
  provider: { provider: "digitalocean", address: "", sshUser: "root", sshPort: 22, sshAlias: "nyxos-server", keyFile: "~/.ssh/id_ed25519" },
  tailscale: { name: "", httpsPort: 443 },
  cloudflare: { hostname: "" },
  domain: { domain: "", email: "" },
};

export const DEFAULT_HOSTING_PROFILE: HostingProfileInput = { way: null, phoneWay: null, forms: DEFAULT_HOSTING_FORMS };

/** Secrets of „Betrieb & Zugriff“ (name in the secret store = `hosting.<id>`). */
export const HostingSecretIdSchema = z.enum(["cloudflare-tunnel-token", "tailscale-auth-key"]);
export type HostingSecretId = z.infer<typeof HostingSecretIdSchema>;
export const HOSTING_SECRET_IDS = HostingSecretIdSchema.options;
export const hostingSecretName = (id: HostingSecretId) => `hosting.${id}`;

export const HostingSecretInputSchema = z.object({ value: z.string().trim().min(8).max(4096) }).strict();

export interface HostingSecretView {
  id: HostingSecretId;
  set: boolean;
  last4: string | null;
  updatedAt: string | null;
}

/** Result of a check. A `code` instead of a sentence, so the interface picks (and translates) the words. */
export const HostingCheckCodeSchema = z.enum([
  "ok", // NyxOS answers healthy, the address is accepted
  "host_not_allowed", // /health answers, but NyxOS does not accept this address (yet)
  "no_https", // answers, but without HTTPS – sign-in on the phone does not work like that
  "nyx_unhealthy", // NyxOS answers but reports a problem (503)
  "not_nyx", // something else answers at this address
  "http_error", // another answer (404, 502 …)
  "timeout", // no answer within the time limit
  "dns", // name not found (Tailscale names are often only known inside the tailnet)
  "blocked", // address points into the internal network – not called for safety
  "invalid_url", // not a valid http(s) address
  "network", // connection refused / other network error
  "self_ok", // „Auf diesem Rechner“: NyxOS runs right here (local/probe) and is healthy
  "self_elsewhere", // „Auf diesem Rechner“: NyxOS runs on a server – cannot be checked from here
]);
export type HostingCheckCode = z.infer<typeof HostingCheckCodeSchema>;

export const HostingCheckRequestSchema = z.object({ target: HostingCheckTargetSchema, url: z.string().trim().max(500).optional() }).strict();
export type HostingCheckRequest = z.infer<typeof HostingCheckRequestSchema>;

export interface HostingCheckResult {
  target: HostingCheckTarget;
  /** Checked address (origin, without path), null for the self check. */
  url: string | null;
  verdict: "ok" | "warn" | "fail";
  code: HostingCheckCode;
  /** /health answered (any HTTP status). */
  reachable: boolean;
  /** The answer looks like NyxOS' /health answer. */
  isNyx: boolean;
  /** Does NyxOS accept this address as host (NYXOS_ALLOWED_HOSTS)? null = not applicable. */
  hostAccepted: boolean | null;
  https: boolean | null;
  status: number | null;
  ms: number;
  /** Short technical addition (names of failing NyxOS checks) – never content of the other side. */
  detail: string | null;
  at: string;
}

export interface HostingRemoteSeen {
  host: string;
  at: string;
  /** Did the request come from a phone/tablet (user agent)? */
  mobile: boolean;
}

export interface HostingProfileView extends HostingProfileInput {
  checks: Partial<Record<HostingCheckTarget, HostingCheckResult>>;
  secrets: HostingSecretView[];
  /** Whether the secret store accepts values (otherwise: „not set up yet“). */
  secretsReady: boolean;
  updatedAt: string | null;
}

export type PhoneReachState = "reachable" | "unreachable" | "not_checked" | "not_setup";

export interface HostingStatus {
  mode: HostingMode;
  /** Name of the computer or server (null = unknown – in a container without a mounted /etc/hostname). */
  hostName: string | null;
  /** Extra allowed addresses (NYXOS_ALLOWED_HOSTS), without 127.0.0.1/localhost. */
  allowedHosts: string[];
  /** Reading also requires sign-in (NYXOS_AUTH_READS=1). */
  authReads: boolean;
  /** How THIS request arrived (Host header, HTTPS, from outside 127.0.0.1/localhost?). */
  request: { host: string | null; https: boolean; remote: boolean };
  bridge: { state: "online" | "reconnecting" | "offline"; machine: string | null; since: string; reason: string | null };
  phone: {
    state: PhoneReachState;
    way: PhoneWay | null;
    url: string | null;
    /** Last check of the chosen phone way (only if it matches today's address). */
    check: HostingCheckResult | null;
    /** Last opened through an outside address (real proof, remembered). */
    lastRemote: HostingRemoteSeen | null;
  };
  /**
   * Port NyxOS listens on as seen from this computer or server: local mode = the local server's port (`PORT`),
   * server mode = the published port on the server (`NYXOS_PORT`, default 47800). Used in the commands.
   */
  port: number;
  serverNow: string;
}

/** Address to open on the phone – from the chosen phone way (null = not filled in yet). */
export function phoneUrlOf(profile: Pick<HostingProfileInput, "phoneWay" | "forms">): string | null {
  const f = profile.forms;
  switch (profile.phoneWay) {
    case "tailscale":
      return f.tailscale.name ? `https://${f.tailscale.name.toLowerCase()}${f.tailscale.httpsPort === 443 ? "" : `:${f.tailscale.httpsPort}`}` : null;
    case "cloudflare":
      return f.cloudflare.hostname ? `https://${f.cloudflare.hostname.toLowerCase()}` : null;
    case "domain":
      return f.domain.domain ? `https://${f.domain.domain.toLowerCase()}` : null;
    default:
      return null;
  }
}

/** Check address per target (null = this target has no address, e.g. a server without a domain). */
export function checkUrlOf(target: HostingCheckTarget, forms: HostingForms): string | null {
  switch (target) {
    case "local":
      return null;
    case "server":
      return forms.server.domain ? `https://${forms.server.domain.toLowerCase()}` : null;
    case "provider":
      return null;
    default:
      return phoneUrlOf({ phoneWay: target, forms });
  }
}

/** Fills missing/broken parts of a stored profile with defaults (old rows, new fields). */
export function normalizeHostingProfile(raw: unknown): HostingProfileInput {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const forms = (r.forms && typeof r.forms === "object" ? r.forms : {}) as Record<string, unknown>;
  const pick = <K extends keyof HostingForms>(k: K): HostingForms[K] => {
    const merged = { ...DEFAULT_HOSTING_FORMS[k], ...((forms[k] as object | undefined) ?? {}) };
    const parsed = HostingFormsSchema.shape[k].safeParse(merged);
    return (parsed.success ? parsed.data : DEFAULT_HOSTING_FORMS[k]) as HostingForms[K];
  };
  const way = HostingWaySchema.safeParse(r.way);
  const phoneWay = PhoneWaySchema.safeParse(r.phoneWay);
  return {
    way: way.success ? way.data : null,
    phoneWay: phoneWay.success ? phoneWay.data : null,
    forms: { local: pick("local"), server: pick("server"), provider: pick("provider"), tailscale: pick("tailscale"), cloudflare: pick("cloudflare"), domain: pick("domain") },
  };
}
