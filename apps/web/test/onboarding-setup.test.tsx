// Onboarding · Schritt 4 „Einrichten“: ein Knopf richtet alles ein (empfohlene Ordner + Hooks), erkannte Ordner als
// Zeilen mit Zählern, Ordner-Auswahl statt Pfad tippen, ehrliche Texte (Hintergrunddienst statt „Brücke“ unter
// Linux, tmux-Befehl passend zur Paketverwaltung) und ein ruhiges „Verbinde …“ statt eines Fehlers.
import { emptySetupState, type SetupBrowseResult, type SetupState } from "@nyxos/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crumbs, shortPath } from "../src/features/onboarding/FolderPicker";
import { CONNECT_PATIENCE_MS, folderMeta, StepSetup, tmuxInstallCommand } from "../src/features/onboarding/StepSetup";
import { __primeAuthForTests } from "../src/features/terminal/authClient";
import { jsonResponse, renderWithClient } from "./helpers";

const HOME = "/home/mara";

const STATE: SetupState = {
  bridgeOnline: true,
  os: "linux",
  projectRoots: [],
  vaultDir: null,
  vaultExists: false,
  hooks: { claude: false, codex: false },
  shellIntegration: false,
  tools: { tmux: false, git: true, claude: true, codex: false, node: "v24.0.0", packageManager: "dnf", root: false },
  suggestions: {
    projectRoots: [`${HOME}/code`, `${HOME}/Sites`],
    vaults: [],
    complete: true,
    projectRootDetails: [
      { path: `${HOME}/code`, repos: 12, sessions: 34, lastUsedAt: "2026-09-26T10:00:00Z", tools: ["claude"], recommended: true },
      { path: `${HOME}/Sites`, repos: 2, sessions: 0, lastUsedAt: null, tools: [], recommended: false },
    ],
  },
};

const HOME_LIST: SetupBrowseResult = {
  path: HOME,
  parent: "/home",
  home: HOME,
  isRepo: false,
  truncated: false,
  entries: [
    { name: "code", path: `${HOME}/code`, isRepo: false, repoCount: 12 },
    { name: "notes", path: `${HOME}/notes`, isRepo: false, repoCount: 0 },
  ],
};
const CODE_LIST: SetupBrowseResult = { path: `${HOME}/code`, parent: HOME, home: HOME, isRepo: false, truncated: false, entries: [{ name: "shop", path: `${HOME}/code/shop`, isRepo: true }] };

type Call = { url: string; method: string; body: unknown };

function stub(o: { state?: () => SetupState } = {}) {
  __primeAuthForTests();
  const calls: Call[] = [];
  let current = o.state?.() ?? STATE;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });
      if (url.startsWith("/api/setup/browse")) return jsonResponse(url.includes("code") ? CODE_LIST : HOME_LIST);
      if (url === "/api/setup" && method === "POST") {
        const b = body ?? {};
        current = {
          ...current,
          ...(Array.isArray(b.projectRoots) ? { projectRoots: b.projectRoots as string[] } : {}),
          ...(b.installHooks === true ? { hooks: { claude: true, codex: true } } : {}),
        };
        return jsonResponse(current);
      }
      if (url === "/api/setup") return jsonResponse(o.state ? o.state() : current);
      return Promise.reject(new Error(`keine Antwort für ${url}`));
    }),
  );
  return calls;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Einrichten · Bausteine", () => {
  it("tmux-Befehl passt zur Paketverwaltung, root ohne sudo, ältere Brücke: Schätzung aus dem System", () => {
    expect(tmuxInstallCommand("darwin", "brew")).toBe("brew install tmux");
    expect(tmuxInstallCommand("linux", "apt")).toBe("sudo apt install -y tmux");
    expect(tmuxInstallCommand("linux", "apt", true)).toBe("apt install -y tmux");
    expect(tmuxInstallCommand("linux", "dnf")).toBe("sudo dnf install -y tmux");
    expect(tmuxInstallCommand("linux", "pacman")).toBe("sudo pacman -S --noconfirm tmux");
    expect(tmuxInstallCommand("linux", "zypper")).toBe("sudo zypper install -y tmux");
    expect(tmuxInstallCommand("linux", "apk", true)).toBe("apk add tmux");
    expect(tmuxInstallCommand("darwin", "none")).toBeNull();
    expect(tmuxInstallCommand("darwin")).toBe("brew install tmux");
    expect(tmuxInstallCommand("linux")).toBe("sudo apt install -y tmux");
    expect(tmuxInstallCommand("other")).toBeNull();
  });

  it("Zeilen-Text und Pfad-Anzeige", () => {
    expect(folderMeta(STATE.suggestions.projectRootDetails?.[0])).toBe("12 Projekte · 34 Sessions · zuletzt mit Claude genutzt");
    expect(folderMeta({ path: "/x", repos: 1, sessions: 1, lastUsedAt: null, tools: ["claude", "codex"], recommended: true })).toBe("1 Projekt · 1 Session · zuletzt mit Claude und Codex genutzt");
    expect(folderMeta({ path: "/x", repos: 0, sessions: 0, lastUsedAt: null, tools: [], recommended: false })).toBe("Hier liefen noch keine Sessions");
    expect(folderMeta(undefined)).toBe("Selbst gewählter Ordner");
    expect(shortPath(`${HOME}/code`, HOME)).toBe("~/code");
    expect(shortPath("/srv/www")).toBe("/srv/www");
    expect(crumbs(`${HOME}/code/shop`, HOME).map((c) => c.label)).toEqual(["~", "code", "shop"]);
    expect(crumbs("/srv/www", HOME)).toEqual([
      { label: "/", path: "/" },
      { label: "srv", path: "/srv" },
      { label: "www", path: "/srv/www" },
    ]);
  });
});

describe("Einrichten · Schritt", () => {
  it("„Alles einrichten“ übernimmt die empfohlenen Ordner und die Hooks in einem Schritt", async () => {
    const calls = stub();
    const user = userEvent.setup();
    renderWithClient(<StepSetup />);
    expect(await screen.findByRole("heading", { name: "Mit einem Klick fertig" })).toBeInTheDocument();
    expect(screen.getByText("Projekt-Ordner: ~/code (empfohlen)")).toBeInTheDocument();
    // Erkannte Ordner als Zeilen: empfohlen, mit Zählern; ohne Auswahl: alle Sessions (ist in Ordnung).
    const code = screen.getByRole("checkbox", { name: /~\/code/ });
    expect(code).toHaveAttribute("aria-checked", "false");
    expect(within(code).getByText("12 Projekte · 34 Sessions · zuletzt mit Claude genutzt")).toBeInTheDocument();
    expect(within(code).getByText("empfohlen")).toBeInTheDocument();
    expect(screen.getByText(/Dann zeigt NyxOS einfach alle deine Sessions/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Alles einrichten" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ projectRoots: [`${HOME}/code`], installHooks: true }));
    expect(await screen.findByRole("heading", { name: "Alles eingerichtet" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /~\/code/ })).toHaveAttribute("aria-checked", "true");
  });

  it("Ordner antippen speichert gesammelt; die Zeile bleibt an ihrem Platz", async () => {
    const calls = stub();
    const user = userEvent.setup();
    renderWithClient(<StepSetup />);
    const sites = await screen.findByRole("checkbox", { name: /~\/Sites/ });
    await user.click(sites);
    await user.click(screen.getByRole("checkbox", { name: /~\/code/ }));
    expect(screen.getByRole("checkbox", { name: /~\/Sites/ })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1), { timeout: 3000 });
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ projectRoots: [`${HOME}/Sites`, `${HOME}/code`] });
    const names = screen.getAllByRole("checkbox").map((c) => c.textContent ?? "");
    expect(names[0]).toContain("~/code");
    expect(names[1]).toContain("~/Sites");
  });

  it("Ordner-Auswahl: startet im Home-Ordner, geht hinein, „Diesen Ordner wählen“ speichert", async () => {
    const calls = stub();
    const user = userEvent.setup();
    renderWithClient(<StepSetup />);
    await user.click(await screen.findByRole("button", { name: "Ordner auswählen …" }));
    const dialog = await screen.findByRole("dialog", { name: "Ordner auswählen" });
    expect(await within(dialog).findByText("notes")).toBeInTheDocument();
    expect(within(dialog).getByText("12 Projekte")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /code/ }));
    expect(await within(dialog).findByText("shop")).toBeInTheDocument();
    expect(within(dialog).getByText("Git-Projekt")).toBeInTheDocument();
    expect(calls.some((c) => c.url === `/api/setup/browse?path=${encodeURIComponent(`${HOME}/code`)}`)).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Diesen Ordner wählen" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ projectRoots: [`${HOME}/code`] }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Linux: tmux-Befehl der eigenen Paketverwaltung, ehrliche tmux-Anbindung (Opt-in), nirgends „Brücke“", async () => {
    stub();
    const { container } = renderWithClient(<StepSetup />);
    expect(await screen.findByText("sudo dnf install -y tmux")).toBeInTheDocument();
    expect(screen.getByText(/Ändert, wie „claude“ und „codex“ in deinem Terminal starten/)).toBeInTheDocument();
    // ohne tmux lässt sich die Anbindung nicht einschalten
    expect(screen.getByRole("button", { name: "Einschalten" })).toBeDisabled();
    expect(container.textContent).not.toMatch(/Brücke|Mac-Bridge/);
  });

  it("macOS ohne Homebrew: einfache Erklärung mit Link statt eines Befehls, der nicht klappt", async () => {
    stub({ state: () => ({ ...STATE, os: "darwin", tools: { ...STATE.tools, packageManager: "none" } }) });
    renderWithClient(<StepSetup />);
    expect(await screen.findByRole("link", { name: "brew.sh" })).toHaveAttribute("href", "https://brew.sh");
    expect(screen.queryByText("brew install tmux")).toBeNull();
  });

  it("Hintergrunddienst noch nicht da: ruhig „Verbinde …“, prüft selbst weiter, erst nach einer Weile der Neustart-Hinweis", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let online = false;
    const calls = stub({ state: () => (online ? STATE : emptySetupState("linux")) });
    renderWithClient(<StepSetup />);
    expect(await screen.findByRole("heading", { name: "Verbinde mit deinem Rechner …" })).toBeInTheDocument();
    expect(screen.queryByText("nyxos restart")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONNECT_PATIENCE_MS + 500);
    });
    expect(await screen.findByRole("heading", { name: "Der NyxOS-Hintergrunddienst antwortet nicht" })).toBeInTheDocument();
    expect(screen.getByText("nyxos restart")).toBeInTheDocument();
    expect(calls.filter((c) => c.url === "/api/setup").length).toBeGreaterThan(5);
    online = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_500);
    });
    expect(await screen.findByRole("heading", { name: "Mit einem Klick fertig" })).toBeInTheDocument();
  });
});
