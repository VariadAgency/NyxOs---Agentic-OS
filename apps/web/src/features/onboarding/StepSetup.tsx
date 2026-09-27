// Schritt 4: Einrichten über den NyxOS-Hintergrunddienst (Brücke) und `/api/setup`. Oben EIN klarer Knopf
// („Alles einrichten“: empfohlene Projekt-Ordner + Hooks), darunter zum Anpassen: Projekt-Ordner (erkannt aus den
// letzten Sessions, Ordner-Auswahl statt Pfad tippen), Hintergrund-Helfer (Hooks, tmux-Anbindung als ehrliches
// Opt-in, tmux-Befehl passend zum System) und optional ein Obsidian-Vault. Ist der Dienst noch nicht verbunden,
// prüft der Schritt alle paar Sekunden von selbst und zeigt erst nach einer Weile, was zu tun ist.
import { t, tc, type ProjectRootInfo, type SetupPackageManager } from "@nyxos/shared";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import { friendlyError } from "../../lib/friendlyError";
import { FIELD, LABEL } from "../settings/fieldStyles";
import { FolderPicker, shortPath } from "./FolderPicker";
import { OnboardingApiError, useApplySetup, useSetupState, type SetupApply, type SetupState } from "./onboardingApi";
import { Block, CommandLine, ErrorLine, StatusPill, StepHeader } from "./ui";
import { VoiceHint } from "./VoiceHint";

/** After this long without the background service, the step explains how to restart it. */
export const CONNECT_PATIENCE_MS = 30_000;
/** Folder changes are saved together after this pause (each save briefly restarts parts of the service). */
const SAVE_DELAY_MS = 900;
const SAVED_HINT_MS = 2_500;

/**
 * tmux install command for this machine. `pm` = package manager reported by the background service (newer
 * versions); without it, a guess from the operating system. `null` = no command to show.
 */
export function tmuxInstallCommand(os: string, pm?: SetupPackageManager, root = false): string | null {
  const sudo = root ? "" : "sudo ";
  switch (pm) {
    case "brew":
      return "brew install tmux";
    case "port":
      return `${sudo}port install tmux`;
    case "apt":
      return `${sudo}apt install -y tmux`;
    case "dnf":
      return `${sudo}dnf install -y tmux`;
    case "yum":
      return `${sudo}yum install -y tmux`;
    case "pacman":
      return `${sudo}pacman -S --noconfirm tmux`;
    case "zypper":
      return `${sudo}zypper install -y tmux`;
    case "apk":
      return `${sudo}apk add tmux`;
    case "none":
      return null;
    case undefined: {
      const o = os.toLowerCase();
      if (o.includes("darwin") || o.includes("mac")) return "brew install tmux";
      if (o.includes("linux")) return `${sudo}apt install -y tmux`;
      return null;
    }
  }
}

/** "12 Projekte · 34 Sessions · zuletzt mit Claude genutzt" */
export function folderMeta(info: ProjectRootInfo | undefined): string {
  if (!info) return t("Selbst gewählter Ordner");
  const parts: string[] = [];
  if (info.repos !== null && info.repos > 0) parts.push(info.repos === 1 ? t("1 Projekt") : t("{n} Projekte", { n: info.repos }));
  if (info.sessions > 0) parts.push(info.sessions === 1 ? t("1 Session") : t("{n} Sessions", { n: info.sessions }));
  const claude = info.tools.includes("claude");
  const codex = info.tools.includes("codex");
  if (claude && codex) parts.push(t("zuletzt mit Claude und Codex genutzt"));
  else if (claude) parts.push(t("zuletzt mit Claude genutzt"));
  else if (codex) parts.push(t("zuletzt mit Codex genutzt"));
  return parts.length > 0 ? parts.join(" · ") : t("Hier liefen noch keine Sessions");
}

/** Keeps rows where they first appeared (a saved folder must not jump to the top of the list). */
function useStableOrder(paths: readonly string[]): string[] {
  const order = useRef<string[]>([]);
  for (const p of paths) if (!order.current.includes(p)) order.current = [...order.current, p];
  return order.current;
}

function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[20px_minmax(0,1fr)] items-start gap-2 text-callout text-a-ink">
      <span aria-hidden className={cn("mt-px grid h-5 w-5 place-items-center rounded-full text-label font-semibold", ok ? "bg-a-ok/15 text-a-ok" : "border border-a-line text-a-mut")}>
        {ok ? "✓" : ""}
      </span>
      <span className="min-w-0 break-words">{children}</span>
    </li>
  );
}

function FolderRow({ path, home, info, checked, recommended, disabled, onToggle }: { path: string; home: string | undefined; info: ProjectRootInfo | undefined; checked: boolean; recommended: boolean; disabled: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex w-full min-w-0 items-start gap-3 rounded-lg border p-3 text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-a-acc disabled:opacity-60",
        checked ? "border-a-ok/45 bg-a-ok/8" : "border-a-line bg-a-p2 hover:border-a-line-strong",
      )}
    >
      <span aria-hidden className={cn("mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border text-label font-bold transition-colors duration-150", checked ? "border-a-ok bg-a-ok text-a-on-primary" : "border-a-line-strong bg-a-bg")}>
        {checked ? "✓" : ""}
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate font-mono text-callout text-a-ink" title={path}>
            {shortPath(path, home)}
          </span>
          {recommended && !checked && <StatusPill tone="mut">{t("empfohlen")}</StatusPill>}
        </span>
        <span className="text-caption text-a-mut">{folderMeta(info)}</span>
      </span>
    </button>
  );
}

type Action = "all" | "folders" | "helpers" | "vault";

function Projects({
  state,
  selected,
  recommended,
  toggle,
  add,
  busy,
  saving,
  savedHint,
  error,
}: {
  state: SetupState;
  selected: string[];
  recommended: string[];
  toggle: (path: string) => void;
  add: (path: string) => void;
  busy: boolean;
  saving: boolean;
  savedHint: boolean;
  error: string | null;
}) {
  const [picker, setPicker] = useState(false);
  const [manual, setManual] = useState(false);
  const [path, setPath] = useState("");
  const details = new Map((state.suggestions.projectRootDetails ?? []).map((d) => [d.path, d]));
  const rows = useStableOrder([...state.projectRoots, ...state.suggestions.projectRoots, ...selected]);
  const searching = state.suggestions.complete === false;
  const closePicker = useCallback(() => setPicker(false), []);

  return (
    <Block
      title={t("Projekt-Ordner")}
      status={selected.length > 0 ? <StatusPill tone="ok">{selected.length === 1 ? t("1 Ordner") : t("{n} Ordner", { n: selected.length })}</StatusPill> : <StatusPill tone="mut">{t("alle Sessions")}</StatusPill>}
    >
      <p className="text-callout text-a-mut">
        {rows.length > 0 ? t("Hier liegen deine Projekte – die obersten hast du zuletzt benutzt. Tipp an, was NyxOS im Blick behalten soll.") : t("Noch keine Projekte gefunden. Wähl einen Ordner aus – oder lass es einfach leer.")}
      </p>
      {searching && <p className="text-caption text-a-mut">{t("Dein Rechner fragt vielleicht gleich, ob NyxOS die Ordner „Dokumente“ und „Schreibtisch“ lesen darf. Mit „Erlauben“ findet NyxOS auch Projekte dort.")}</p>}
      {rows.length > 0 && (
        <div role="group" aria-label={t("Projekt-Ordner")} className="grid gap-2">
          {rows.map((p) => (
            <FolderRow key={p} path={p} home={state.home} info={details.get(p)} checked={selected.includes(p)} recommended={recommended.includes(p)} disabled={busy} onToggle={() => toggle(p)} />
          ))}
        </div>
      )}
      {selected.length === 0 && <p className="text-callout text-a-ink">{t("Nichts gewählt? Kein Problem: Dann zeigt NyxOS einfach alle deine Sessions.")}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button onClick={() => setPicker(true)} disabled={busy}>
          {t("Ordner auswählen …")}
        </Button>
        <button type="button" className="text-caption text-a-mut underline decoration-a-line-strong underline-offset-2 hover:text-a-ink" aria-expanded={manual} onClick={() => setManual((m) => !m)}>
          {t("Pfad eintippen")}
        </button>
        <span aria-live="polite" className="ml-auto text-caption text-a-mut">
          {saving ? t("Speichere …") : savedHint ? <span className="text-a-ok">{t("Gespeichert")}</span> : null}
        </span>
      </div>
      {manual && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = path.trim();
            if (!v) return;
            add(v);
            setPath("");
          }}
        >
          <input aria-label={t("Ordner-Pfad")} value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/code" autoFocus spellCheck={false} autoCapitalize="off" className={cn(FIELD, "min-w-0 flex-1 basis-48 font-mono")} />
          <Button type="submit" disabled={busy || !path.trim()}>
            {t("Hinzufügen")}
          </Button>
        </form>
      )}
      <ErrorLine text={error} />
      <FolderPicker
        open={picker}
        busy={busy}
        onClose={closePicker}
        onPick={(p) => {
          setPicker(false);
          add(p);
        }}
      />
    </Block>
  );
}

function Row({ title, text, status, action, extra, badge }: { title: string; text: ReactNode; status: ReactNode; action?: ReactNode; extra?: ReactNode; badge?: ReactNode }) {
  return (
    <div className="grid gap-1.5 rounded-lg border border-a-line bg-a-p2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-callout font-medium text-a-ink">{title}</span>
        {badge}
        {status}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      <p className="text-caption text-a-mut">{text}</p>
      {extra}
    </div>
  );
}

function TmuxHint({ state }: { state: SetupState }) {
  const cmd = tmuxInstallCommand(state.os, state.tools.packageManager, state.tools.root ?? false);
  if (cmd) return <CommandLine command={cmd} />;
  if (state.os === "darwin")
    return (
      <p className="text-caption text-a-ink">
        {t("Dafür brauchst du Homebrew – ein kleines Programm, mit dem man auf dem Rechner Werkzeuge installiert. Die Anleitung steht auf")}{" "}
        <a href="https://brew.sh" target="_blank" rel="noreferrer" className="text-a-acc underline">
          brew.sh
        </a>
        {t(", danach im Terminal: „brew install tmux“.")}
      </p>
    );
  if (state.os === "linux") return <p className="text-caption text-a-ink">{t("Installiere „tmux“ mit der Paketverwaltung deines Systems.")}</p>;
  return <p className="text-caption text-a-mut">{t("Unter Windows läuft tmux in WSL: dort „sudo apt install tmux“.")}</p>;
}

function Helpers({ state, apply, busy, recheck, checking, error }: { state: SetupState; apply: (a: SetupApply) => void; busy: boolean; recheck: () => void; checking: boolean; error: string | null }) {
  const hooksOk = state.hooks.claude && (state.hooks.codex || !state.tools.codex);
  return (
    <Block title={t("Hintergrund-Helfer")}>
      <p className="text-callout text-a-mut">{t("Damit NyxOS sofort sieht, was in deinen Sessions passiert. An deinen Projekten ändern sie nichts.")}</p>
      <div className="grid gap-2">
        <Row
          title={state.tools.codex ? t("Hooks für Claude Code und Codex") : t("Hooks für Claude Code")}
          text={t("Melden NyxOS, wenn eine Session startet, auf dich wartet oder fertig ist. Sie kommen in die Einstellungen des jeweiligen Programms – vorher wird eine Sicherungskopie angelegt.")}
          status={hooksOk ? <StatusPill tone="ok">{t("eingerichtet")}</StatusPill> : <StatusPill tone="wait">{t("fehlt noch")}</StatusPill>}
          action={
            hooksOk ? null : (
              <Button onClick={() => apply({ installHooks: true })} disabled={busy}>
                {t("Einrichten")}
              </Button>
            )
          }
        />
        <Row
          title={t("Sessions übernehmbar machen")}
          badge={<StatusPill tone="mut">{t("optional")}</StatusPill>}
          text={t("Ändert, wie „claude“ und „codex“ in deinem Terminal starten: Sie laufen dann unsichtbar in tmux, und du kannst eine laufende Session in NyxOS übernehmen. Dafür kommen drei Zeilen in deine Shell-Startdatei (~/.zshrc bzw. ~/.bashrc). Ausschalten geht jederzeit hier.")}
          status={state.shellIntegration ? <StatusPill tone="ok">{t("an")}</StatusPill> : <StatusPill tone="mut">{t("aus")}</StatusPill>}
          action={
            state.shellIntegration ? (
              <Button variant="ghost" onClick={() => apply({ shellIntegration: false })} disabled={busy}>
                {t("Ausschalten")}
              </Button>
            ) : (
              <Button onClick={() => apply({ shellIntegration: true })} disabled={busy || !state.tools.tmux}>
                {t("Einschalten")}
              </Button>
            )
          }
          extra={
            state.shellIntegration ? (
              <p className="text-caption text-a-mut">{t("Gilt ab dem nächsten neuen Terminal-Fenster.")}</p>
            ) : !state.tools.tmux ? (
              <p className="text-caption text-a-mut">{t("Braucht tmux (siehe unten).")}</p>
            ) : null
          }
        />
        <Row
          title="tmux"
          badge={<StatusPill tone="mut">{t("optional")}</StatusPill>}
          text={t("Ein kleines Terminal-Werkzeug. Es hält Sessions am Leben, damit du sie aus NyxOS heraus übernehmen kannst.")}
          status={state.tools.tmux ? <StatusPill tone="ok">{t("installiert")}</StatusPill> : <StatusPill tone="mut">{t("nicht installiert")}</StatusPill>}
          action={
            state.tools.tmux ? null : (
              <Button variant="ghost" onClick={recheck} disabled={checking}>
                {checking ? t("Prüfe …") : t("Erneut prüfen")}
              </Button>
            )
          }
          extra={state.tools.tmux ? null : <TmuxHint state={state} />}
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {(["git", "node", "claude", "codex"] as const).map((tool) => (
          <StatusPill key={tool} tone={state.tools[tool] ? "ok" : "mut"}>
            {tool} {state.tools[tool] ? tc("onboarding", "da") : t("fehlt")}
          </StatusPill>
        ))}
      </div>
      <ErrorLine text={error} />
    </Block>
  );
}

function Vault({ state, apply, busy, error }: { state: SetupState; apply: (a: SetupApply) => void; busy: boolean; error: string | null }) {
  const [path, setPath] = useState("~/Documents/NyxOS");
  const connected = !!state.vaultDir && state.vaultExists;
  return (
    <Block title={t("Obsidian-Vault")} badge={<StatusPill tone="mut">{t("optional")}</StatusPill>} status={connected ? <StatusPill tone="ok">{t("verbunden")}</StatusPill> : null}>
      <p className="text-callout text-a-mut">{t("Obsidian ist eine Notiz-App. Verbindest du einen Vault (Notiz-Ordner), kann NyxOS Aufgaben, Ideen und Entscheidungen dort ablegen und im „Gehirn“ zeigen.")}</p>
      {connected && state.vaultDir && (
        <p className="text-callout text-a-ink">
          {t("Verbunden:")} <span className="font-mono text-caption">{shortPath(state.vaultDir, state.home)}</span>
        </p>
      )}
      {!connected && state.suggestions.vaults.length > 0 && (
        <div className="grid gap-1.5">
          <span className={LABEL}>{t("Gefundene Vaults")}</span>
          <div className="flex flex-wrap gap-1.5">
            {state.suggestions.vaults.map((v) => (
              <button
                key={v}
                type="button"
                title={v}
                disabled={busy}
                onClick={() => apply({ vaultDir: v })}
                className="max-w-full truncate rounded-full border border-a-line bg-a-p2 px-3 py-1 font-mono text-caption text-a-mut transition-colors duration-150 hover:text-a-ink disabled:opacity-60"
              >
                + {shortPath(v, state.home)}
              </button>
            ))}
          </div>
        </div>
      )}
      {!connected && (
        <form
          className="grid gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) apply({ vaultDir: path.trim(), createVault: true });
          }}
        >
          <label htmlFor="onboarding-vault" className={LABEL}>
            {t("Neuen Vault anlegen")}
          </label>
          <div className="flex flex-wrap gap-2">
            <input id="onboarding-vault" value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} autoCapitalize="off" className={cn(FIELD, "min-w-0 flex-1 basis-48 font-mono")} />
            <Button type="submit" disabled={busy || !path.trim()}>
              {t("Anlegen")}
            </Button>
          </div>
          <p className="text-caption text-a-mut">{t("Kein Obsidian? Einfach überspringen – das geht auch später.")}</p>
        </form>
      )}
      <ErrorLine text={error} />
    </Block>
  );
}

function Connecting({ slow, recheck, checking }: { slow: boolean; recheck: () => void; checking: boolean }) {
  if (!slow)
    return (
      <Block title={t("Verbinde mit deinem Rechner …")} status={<StatusPill tone="wait">{t("verbindet")}</StatusPill>}>
        <p className="text-callout text-a-mut">{t("Der NyxOS-Hintergrunddienst startet gerade. Das dauert meist nur ein paar Sekunden – diese Seite prüft von selbst weiter.")}</p>
        <div aria-hidden className="h-1 overflow-hidden rounded-full bg-a-p3">
          <div className="h-full w-1/3 rounded-full bg-a-acc motion-safe:animate-pulse" />
        </div>
      </Block>
    );
  return (
    <Block title={t("Der NyxOS-Hintergrunddienst antwortet nicht")} status={<StatusPill tone="wait">{t("offline")}</StatusPill>}>
      <p className="text-callout text-a-mut">{t("Das ist ein kleines Programm auf deinem Rechner. Es liest deine Sessions und richtet alles ein. Starte es im Terminal neu:")}</p>
      <CommandLine command="nyxos restart" />
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={recheck} disabled={checking}>
          {checking ? t("Prüfe …") : t("Erneut prüfen")}
        </Button>
        <span className="text-caption text-a-mut">{t("Diese Seite prüft auch von selbst weiter. Du kannst den Schritt auch überspringen und später nachholen.")}</span>
      </div>
    </Block>
  );
}

function Hero({ state, selected, recommended, touched, busy, onSetupAll, error }: { state: SetupState; selected: string[]; recommended: string[]; touched: boolean; busy: boolean; onSetupAll: () => void; error: string | null }) {
  const hooksOk = state.hooks.claude && (state.hooks.codex || !state.tools.codex);
  const needsRoots = selected.length === 0 && recommended.length > 0 && !touched;
  const done = hooksOk && !needsRoots && state.projectRoots.length === selected.length;
  const list = (paths: string[]) => paths.map((p) => shortPath(p, state.home)).join(", ");
  return (
    <section aria-labelledby="setup-hero-title" className={cn("grid gap-3 rounded-xl border bg-a-p p-4 transition-colors duration-300 sm:p-5", done ? "border-a-ok/40" : "border-a-line-strong")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 id="setup-hero-title" className="text-headline font-semibold text-a-ink">
          {done ? t("Alles eingerichtet") : t("Mit einem Klick fertig")}
        </h2>
        {done && (
          <span className="ml-auto motion-safe:animate-[cc-tab-fade_200ms_ease-out]">
            <StatusPill tone="ok">{t("fertig")}</StatusPill>
          </span>
        )}
      </div>
      <ul className="grid gap-1.5">
        <Check ok={selected.length > 0 ? state.projectRoots.length > 0 : !needsRoots}>
          {selected.length > 0
            ? t("Projekt-Ordner: {list}", { list: list(selected) })
            : needsRoots
              ? t("Projekt-Ordner: {list} (empfohlen)", { list: list(recommended) })
              : t("Alle Sessions anzeigen – dafür braucht es keinen Projekt-Ordner")}
        </Check>
        <Check ok={hooksOk}>{state.tools.codex ? t("Hooks für Claude Code und Codex") : t("Hooks für Claude Code")}</Check>
      </ul>
      {done ? (
        <p className="text-callout text-a-mut">{t("Unten kannst du noch alles anpassen – oder einfach auf „Weiter“.")}</p>
      ) : (
        <Button variant="primary" className="w-full px-5 py-2 text-headline sm:w-fit" onClick={onSetupAll} disabled={busy}>
          {busy ? t("Richte ein …") : t("Alles einrichten")}
        </Button>
      )}
      <ErrorLine text={error} />
    </section>
  );
}

export function StepSetup() {
  const setup = useSetupState(true, true);
  const { mutate, isPending, error } = useApplySetup();
  const live = setup.data;
  const missing = setup.error instanceof OnboardingApiError && setup.error.status === 404;

  // A save briefly restarts the background service: keep showing the last state meanwhile instead of "offline".
  const [lastOnline, setLastOnline] = useState<SetupState | null>(null);
  useEffect(() => {
    if (live?.bridgeOnline) setLastOnline(live);
  }, [live]);
  const state = live?.bridgeOnline ? live : lastOnline;
  const disconnected = !!live && !live.bridgeOnline;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!disconnected) {
      setSlow(false);
      return;
    }
    const id = setTimeout(() => setSlow(true), CONNECT_PATIENCE_MS);
    return () => clearTimeout(id);
  }, [disconnected]);

  // Folder choice: shown at once, saved together after a short pause (and when leaving the step).
  const [draft, setDraft] = useState<string[] | null>(null);
  const [touched, setTouched] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [savedHint, setSavedHint] = useState(false);
  const pending = useRef<string[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saved = state?.projectRoots ?? [];
  const selected = draft ?? saved;

  const run = useCallback(
    (a: SetupApply, kind: Action) => {
      setAction(kind);
      mutate(a, {
        onSuccess: () => {
          if (a.projectRoots) setSavedHint(true);
        },
        onSettled: () => {
          // Only follow the saved state again when no newer choice waits.
          if (pending.current === null) setDraft(null);
        },
      });
    },
    [mutate],
  );
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const roots = pending.current;
    pending.current = null;
    if (roots) run({ projectRoots: roots }, "folders");
  }, [run]);
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);
  useEffect(() => () => flushRef.current(), []);
  useEffect(() => {
    if (!savedHint) return;
    const id = setTimeout(() => setSavedHint(false), SAVED_HINT_MS);
    return () => clearTimeout(id);
  }, [savedHint]);

  const choose = (next: string[], now = false) => {
    setDraft(next);
    setTouched(true);
    setSavedHint(false);
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    if (now) flush();
    else timer.current = setTimeout(flush, SAVE_DELAY_MS);
  };
  const toggle = (p: string) => choose(selected.includes(p) ? selected.filter((r) => r !== p) : [...selected, p]);
  const add = (p: string) => choose(selected.includes(p) ? selected : [...selected, p], true);

  const details = state?.suggestions.projectRootDetails ?? [];
  const recommended = details.filter((d) => d.recommended && !saved.includes(d.path)).map((d) => d.path);
  const setupAll = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    const roots = selected.length > 0 || touched ? selected : recommended;
    if (roots !== selected) setDraft(roots);
    run({ projectRoots: roots, installHooks: true }, "all");
  };
  const errorText = error ? friendlyError(error) : null;
  const errorFor = (kind: Action) => (action === kind ? errorText : null);
  const busy = isPending || disconnected;
  const recheck = () => void setup.refetch();

  return (
    <div className="grid gap-5">
      <StepHeader title={t("Einrichten")} lead={t("Fast geschafft. Ein Klick richtet alles ein – anpassen kannst du es jederzeit.")} />
      {setup.isLoading && (
        <Block title={t("Schaue auf deinem Rechner nach …")} status={<StatusPill tone="mut">{t("Prüfe …")}</StatusPill>}>
          <div aria-hidden className="grid gap-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-lg bg-a-p2" />
            ))}
          </div>
        </Block>
      )}
      {missing && <p className="text-callout text-a-mut">{t("Die Einrichtung ist in dieser Version noch nicht verfügbar. Überspring den Schritt einfach.")}</p>}
      {setup.error && !missing && (
        <div className="grid justify-items-start gap-2">
          <ErrorLine text={friendlyError(setup.error)} />
          <Button onClick={recheck}>{t("Erneut prüfen")}</Button>
        </div>
      )}
      {disconnected && !state && <Connecting slow={slow} recheck={recheck} checking={setup.isFetching} />}
      {state && (
        <>
          {disconnected && (
            <div aria-live="polite" className="flex flex-wrap items-center gap-2">
              <StatusPill tone="wait">{t("Verbinde neu …")}</StatusPill>
              {slow && <span className="text-caption text-a-mut">{t("Dauert ungewöhnlich lange. Im Terminal hilft „nyxos restart“.")}</span>}
            </div>
          )}
          <Hero state={state} selected={selected} recommended={recommended} touched={touched} busy={busy} onSetupAll={setupAll} error={errorFor("all")} />
          <Projects
            state={state}
            selected={selected}
            recommended={recommended}
            toggle={toggle}
            add={add}
            busy={busy}
            saving={draft !== null && (isPending || pending.current !== null)}
            savedHint={savedHint && draft === null}
            error={errorFor("folders")}
          />
          <Helpers state={state} apply={(a) => run(a, "helpers")} busy={busy} recheck={recheck} checking={setup.isFetching} error={errorFor("helpers")} />
          <Vault state={state} apply={(a) => run(a, "vault")} busy={busy} error={errorFor("vault")} />
          <VoiceHint />
        </>
      )}
    </div>
  );
}
