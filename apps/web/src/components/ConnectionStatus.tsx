import { t } from "@nyxos/shared";
import { Link, useInRouterContext } from "react-router";
import { useAuthStatus } from "../hooks/useAuthStatus";
import { useServerStatus, type ServerTone } from "../hooks/useHealth";
import { cn } from "../lib/cn";
import { openLoginDialog } from "../features/terminal/authClient";
import { BridgeStatusLine } from "./BridgeStatus";
import { SupportButton } from "../features/support/SupportButton";

type DotState = ServerTone;

function Dot({ state }: { state: DotState }) {
  return <span className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", state === "ok" ? "bg-a-ok" : state === "bad" ? "bg-a-bad" : state === "wait" ? "bg-a-wait" : "bg-a-idle")} />;
}

/**
 * Echter Verbindungsstatus: /health alle 10 s; Brücke fertig vom Server (s. BridgeStatus.tsx).
 *
 * "unbekannt ≠ online": solange die erste Antwort noch aussteht, zeigen beide
 * Zeilen einen neutralen "unbekannt"-Zustand statt fälschlich "online" (vorher: `isLoading` ließ
 * `bridgeOnline` einfach auf `false` fallen, was optisch nicht von einer echten Prüfung zu
 * unterscheiden war). Ist der Server erreichbar nicht bestätigt, gilt die Brücke außerdem
 * NIE als "online" — ihr letzter bekannter Stand kam über genau diesen Server und ist damit
 * unbelegt, sobald der nicht mehr antwortet.
 *
 * Ein kurzer Aussetzer (< 90 s, z. B. Brücken-Neustart mit Tunnel-Neuaufbau) ist gelb
 * „Verbindung wird neu aufgebaut …“, nie sofort rot. Erst danach rot, mit Grund (s. `describeServer`).
 */
export function ConnectionStatus() {
  const server = useServerStatus();
  const auth = useAuthStatus();

  return (
    <div className="mt-auto grid gap-1 border-t border-a-line px-2 pb-0.5 pt-2.5 text-caption text-a-mut">
      <div className="flex items-start gap-1.5" data-testid="server-status" data-tone={server.tone}>
        <span className="flex h-[1.5em] shrink-0 items-center">
          <Dot state={server.tone} />
        </span>
        <span className="grid min-w-0 flex-1 leading-[1.5]">
          <span className="break-words">{server.text}</span>
          {server.detail && <span className="break-words text-label text-a-mut">{server.detail}</span>}
        </span>
      </div>
      <BridgeStatusLine serverOk={server.tone === "ok"} serverReconnecting={server.tone === "wait"} />
      {/* `data` ist der letzte BESTÄTIGTE Stand — ein gescheiterter Neuabruf (Tunnel kurz weg)
          lässt ihn stehen, statt „Nicht angemeldet“ zu zeigen (vorher: `isSuccess && …`). */}
      {auth.data?.authenticated ? (
        <div className="flex items-center gap-1.5">
          <Dot state="ok" />
          {t("Angemeldet")}
        </div>
      ) : !auth.data ? (
        <div className="flex items-center gap-1.5">
          <Dot state="unknown" />
          {auth.isError ? t("Anmeldung gerade nicht prüfbar") : t("Anmeldung wird geprüft …")}
        </div>
      ) : (
        <button type="button" className="flex items-center gap-1.5 text-left hover:text-a-ink" onClick={() => openLoginDialog()}>
          <Dot state="unknown" />
          {t("Nicht angemeldet")}
        </button>
      )}
      <ConnectionsLink />
      {/* Feedback & Unterstützen: Fehler melden, Idee schicken, Buy me Tokens (Blatt, alles in NyxOS). */}
      <SupportButton />
    </div>
  );
}

/** Sprung zu Einstellungen → „Verbindungen“ (alle Verbindungen echt geprüft). Außerhalb
 * eines Routers (einzelne Komponenten-Tests) ein normaler Link statt einer Router-Navigation. */
export const CONNECTIONS_HREF = "/settings/verbindungen";

function ConnectionsLink() {
  const inRouter = useInRouterContext();
  const className = "flex items-center gap-1.5 text-left text-a-acc hover:text-a-ink";
  return inRouter ? (
    <Link to={CONNECTIONS_HREF} className={className}>
      {t("Alle Verbindungen ansehen →")}
    </Link>
  ) : (
    <a href={CONNECTIONS_HREF} className={className}>
      {t("Alle Verbindungen ansehen →")}
    </a>
  );
}
