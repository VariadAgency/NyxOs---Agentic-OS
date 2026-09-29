// Browser-Terminal: xterm.js + WebSocket `/terminal/:id`. Wiederverbinden ohne Datenverlust:
// jede (Neu-)Verbindung beginnt mit einem vollständigen Bildschirm-Abzug inkl. Verlauf aus tmux, danach
// live — der Bildschirm ist also nach jeder Unterbrechung wieder exakt der von tmux.
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import { t } from "@nyxos/shared";
import { useEffect, useRef, useState } from "react";
import { fetchAuthStatus, onSignedIn, requireLogin } from "./authClient";
import { ctrlChar } from "./TerminalKeys";

export type TermState = "connecting" | "connected" | "reconnecting" | "offline" | "ended" | "not_attachable" | "login";

/** Farben aus den Tokens (app.css), ANSI-Palette daraus abgeleitet. */
export const TERM_THEME: ITheme = {
  background: "#050505",
  foreground: "#f3f3ef",
  cursor: "#3cc6c0",
  cursorAccent: "#050505",
  selectionBackground: "#3cc6c044",
  black: "#242424",
  red: "#ff5a4e",
  green: "#2fd27a",
  yellow: "#ffb020",
  blue: "#4da3ff",
  magenta: "#ff6b8a",
  cyan: "#3cc6c0",
  white: "#d4d4d0",
  brightBlack: "#6b6b6b",
  brightRed: "#ff8a80",
  brightGreen: "#5fe39a",
  brightYellow: "#ffc85c",
  brightBlue: "#8fc4ff",
  brightMagenta: "#ff9ab0",
  brightCyan: "#6fdcd6",
  brightWhite: "#ffffff",
};

interface ServerMsg {
  t: "snapshot" | "out" | "size" | "status" | "pong";
  d?: string;
  cols?: number;
  rows?: number;
  s?: string;
  msg?: string;
  id?: number;
}

const RETRY_MS = [300, 800, 1500, 3000, 5000];

/** Statt „nicht in tmux“ — was los ist und was du tun kannst. */
export const NOT_IN_NYXOS_TEXT = t("Diese Session läuft in einem eigenen Fenster auf deinem Rechner. Damit du hier tippen kannst, übernimm sie in NyxOS.");
/** Läuft gar kein Programm mehr, wäre „eigenes Fenster“ gelogen. */
export const NOT_RUNNING_TEXT = t("Diese Session läuft gerade nicht. Übernimm sie in NyxOS, dann geht es hier weiter.");

/** Läuft an der Session gerade ein Programm (außerhalb der NyxOS)? Nur dann gibt es ein „eigenes Fenster“. */
export const runsOutside = (state: string | null | undefined) => state === "running" || state === "waiting" || state === "idle";

export function useTerminal(opts: {
  sessionId: string;
  readOnly: boolean;
  bridgeOnline: boolean;
  /** false = Session läuft (noch) nicht in der NyxOS → gar nicht erst verbinden. */
  enabled?: boolean;
  /** Ändert sich nach „In der NyxOS übernehmen“ → verbindet von selbst neu. */
  attachKey?: string | null;
  /** Server-SSH: eigener Kanal-Weg (z. B. `/terminal/ssh/zc-ssh-…`) statt `/terminal/<sessionId>`. */
  wsPath?: string;
  /** Schriftgröße in px (Handy kleiner, per A−/A+ und Zwei-Finger-Zoom einstellbar). Standard 13. */
  fontSize?: number;
}) {
  const enabled = opts.enabled ?? true;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [state, setState] = useState<TermState>("connecting");
  const [message, setMessage] = useState<string | null>(null);
  const [authTick, setAuthTick] = useState(0);
  /** true, solange eine vom Server gemeldete Feldgröße übernommen wird (nicht zurückschicken). */
  const applyingServerSize = useRef(false);
  const readOnlyRef = useRef(opts.readOnly);
  readOnlyRef.current = opts.readOnly;
  /** Eingaben von außen (Tastenzeile, Einfügen) – zeigt auf den Sender der aktuellen Verbindung. */
  const sendRef = useRef<((d: string) => void) | null>(null);
  /** „Strg“ der Tastenzeile ist eingerastet → das nächste Zeichen wird zum Steuerzeichen. */
  const ctrlRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const fontSize = opts.fontSize ?? 13;
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  /** Strg anwenden (einmalig) – für Tastatur-Eingaben und Knöpfe der Tastenzeile gleich. */
  const applyCtrl = (d: string): string => {
    if (!ctrlRef.current) return d;
    ctrlRef.current = false;
    setCtrlArmed(false);
    return ctrlChar(d) ?? d;
  };

  // Nur nach erfolgreicher Anmeldung neu verbinden (nicht bei jeder Änderung, s. `onSignedIn`).
  useEffect(() => onSignedIn(() => setAuthTick((n) => n + 1)), []);

  // xterm einmal je Session anlegen.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
      fontSize: fontSizeRef.current,
      lineHeight: 1.15,
      scrollback: 50_000,
      cursorBlink: true,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: TERM_THEME,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.open(host);
    performance.mark("zc-terminal-open");
    // WebGL erst NACH dem ersten Bild laden: das Anlegen des GL-Kontexts kostet ohne Grafikkarte (Software-GL,
    // z. B. headless) über 1 s Haupt-Thread — so ist der Verlauf sofort sichtbar (DOM-Renderer), WebGL übernimmt danach.
    let webglTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      webglTimer = undefined;
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose()); // zurück auf den DOM-Renderer, statt einzufrieren
        term.loadAddon(webgl);
      } catch {
        // kein WebGL → DOM-Renderer bleibt
      }
      performance.mark("zc-terminal-webgl");
    }, 400);
    termRef.current = term;
    searchRef.current = search;
    fitRef.current = fit;
    (window as unknown as { __zcTerm?: Terminal }).__zcTerm = term; // für Messungen (Playwright)
    try {
      fit.fit();
    } catch {
      // Container noch ohne Größe
    }
    const ro = new ResizeObserver(() => {
      if (readOnlyRef.current) return;
      try {
        fit.fit();
      } catch {
        // unsichtbar
      }
    });
    ro.observe(host);
    return () => {
      clearTimeout(webglTimer);
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [opts.sessionId]);

  // Verbindung: neu bei Session-/Modus-Wechsel, nach Anmeldung und wenn die Brücke zurück ist.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (!opts.bridgeOnline) {
      setState("offline");
      setMessage(t("Brücke offline"));
      return;
    }
    if (!enabled) {
      setState("not_attachable");
      setMessage(NOT_IN_NYXOS_TEXT);
      return;
    }
    let ws: WebSocket | null = null;
    let closedByUs = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disposers: { dispose(): void }[] = [];
    term.options.disableStdin = opts.readOnly;
    setState("connecting"); // sofort, nicht erst nach der Anmelde-Prüfung
    if (!opts.readOnly) {
      try {
        fitRef.current?.fit(); // nach „Nur ansehen" wieder auf die Fenstergröße
      } catch {
        // unsichtbar
      }
    }

    const send = (m: object) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    };
    /** Mehrere Zuschauer: tmux folgt dem, der zuletzt getippt hat. Tippt man hier, wieder auf die eigene Fenstergröße gehen. */
    const refitIfNeeded = () => {
      const dims = fitRef.current?.proposeDimensions();
      if (dims && (dims.cols !== term.cols || dims.rows !== term.rows)) {
        try {
          fitRef.current?.fit();
        } catch {
          // unsichtbar
        }
      }
    };
    const applyServerSize = (cols: number, rows: number) => {
      if (cols === term.cols && rows === term.rows) return;
      applyingServerSize.current = true;
      term.resize(cols, rows);
      applyingServerSize.current = false;
    };
    const input = (d: string) => {
      if (readOnlyRef.current) return;
      refitIfNeeded();
      send({ t: "in", d: applyCtrl(d) });
    };
    sendRef.current = input;
    disposers.push(term.onData(input));
    disposers.push(term.onBinary((d) => !readOnlyRef.current && send({ t: "in", d })));
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    disposers.push(
      term.onResize(({ cols, rows }) => {
        if (readOnlyRef.current || applyingServerSize.current) return;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => send({ t: "resize", cols, rows }), 60);
      }),
    );

    const retryLater = () => {
      setState("reconnecting");
      const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] ?? 5000;
      attempt++;
      timer = setTimeout(() => void connect(), wait);
    };
    const connect = async () => {
      let auth: Awaited<ReturnType<typeof fetchAuthStatus>>;
      try {
        auth = await fetchAuthStatus(true);
      } catch {
        // Server/Tunnel kurz weg heißt NICHT „nicht angemeldet" — gleich noch einmal versuchen.
        if (!closedByUs) retryLater();
        return;
      }
      if (closedByUs) return;
      if (!auth.authenticated) {
        setState("login");
        setMessage(t("Bitte anmelden"));
        requireLogin();
        return;
      }
      setState(attempt === 0 ? "connecting" : "reconnecting");
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const q = new URLSearchParams({ mode: opts.readOnly ? "ro" : "rw", cols: String(term.cols), rows: String(term.rows) });
      const path = opts.wsPath ?? `/terminal/${encodeURIComponent(opts.sessionId)}`;
      const sock = new WebSocket(`${proto}://${location.host}${path}?${q}`);
      ws = sock;
      let final = false;
      sock.onmessage = (ev) => {
        let m: ServerMsg;
        try {
          m = JSON.parse(String(ev.data)) as ServerMsg;
        } catch {
          return;
        }
        if (m.t === "out" && m.d) term.write(m.d);
        else if (m.t === "snapshot" && m.d !== undefined) {
          performance.mark("zc-terminal-snapshot"); // Messpunkt
          attempt = 0;
          term.reset();
          // Der Abzug passt nur zur Feldgröße, in der er entstand (andere Zuschauer können sie bestimmen).
          if (m.cols && m.rows) applyServerSize(m.cols, m.rows);
          term.write(m.d, () => performance.mark("zc-terminal-snapshot-written"));
          setState("connected");
          setMessage(null);
        } else if (m.t === "size" && m.cols && m.rows) applyServerSize(m.cols, m.rows);
        else if (m.t === "status") {
          if (m.s === "connected") setState((s) => (s === "connected" ? s : "connecting"));
          else if (m.s === "bridge_offline") {
            final = true;
            setState("offline");
            setMessage(m.msg ?? t("Brücke offline"));
          } else if (m.s === "ended" || m.s === "not_attachable") {
            final = true;
            setState(m.s);
            setMessage(m.s === "ended" ? t("Die Session ist beendet.") : NOT_IN_NYXOS_TEXT);
          }
        }
      };
      sock.onclose = () => {
        ws = null;
        if (closedByUs || final) return;
        retryLater();
      };
    };
    void connect();
    return () => {
      closedByUs = true;
      if (sendRef.current === input) sendRef.current = null;
      clearTimeout(timer);
      clearTimeout(resizeTimer);
      for (const d of disposers) d.dispose();
      ws?.close();
    };
  }, [opts.sessionId, opts.wsPath, opts.readOnly, opts.bridgeOnline, enabled, opts.attachKey, authTick]);

  // Schriftgröße live ändern; die neue Spaltenzahl geht über `onResize` an tmux.
  useEffect(() => {
    const term = termRef.current;
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    // „Nur ansehen“ behält die Feldgröße des Programms (sonst bräche die Anzeige um) – dann scrollt das Feld in sich.
    if (readOnlyRef.current) return;
    try {
      fitRef.current?.fit();
    } catch {
      // unsichtbar
    }
  }, [fontSize]);

  return {
    hostRef,
    state,
    message,
    /** Zeichen senden wie getippt (Tastenzeile). Nur mit offener Verbindung und nicht bei „Nur ansehen“. */
    sendInput: (d: string) => sendRef.current?.(d),
    /** Text einfügen wie ⌘V (xterm beachtet den „Einfügen-Modus“ des Programms). */
    paste: (text: string) => termRef.current?.paste(text),
    /** Markierter Text – oder, ohne Markierung (auf dem Handy der Normalfall), der sichtbare Bildschirm. */
    copyText: (): { text: string; what: "selection" | "screen" } => {
      const term = termRef.current;
      if (!term) return { text: "", what: "screen" };
      const sel = term.getSelection();
      if (sel) return { text: sel, what: "selection" };
      const b = term.buffer.active;
      const lines: string[] = [];
      for (let i = b.viewportY; i < b.viewportY + term.rows; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "");
      return { text: lines.join("\n").replace(/\s+$/, ""), what: "screen" };
    },
    appCursor: () => termRef.current?.modes.applicationCursorKeysMode ?? false,
    ctrlArmed,
    toggleCtrl: () => {
      ctrlRef.current = !ctrlRef.current;
      setCtrlArmed(ctrlRef.current);
    },
    focus: () => termRef.current?.focus(),
    findNext: (q: string) => searchRef.current?.findNext(q) ?? false,
    findPrevious: (q: string) => searchRef.current?.findPrevious(q) ?? false,
    retry: () => setAuthTick((n) => n + 1),
  };
}
