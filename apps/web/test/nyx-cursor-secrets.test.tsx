// Der Nyx-Cursor darf alles, was du kannst – außer Schlüssel/Tokens/Zugänge/Anmeldung/Telegram-Kopplung
// (app_api sperrt dieselben Wege) und Konflikt-Entscheidungen (app_api: nur nach „Ausführen“). Vorher konnte Nyx z. B.
// in „telegram-token-input“ ein fremdes Bot-Token tippen und „Speichern & verbinden“ drücken.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeNyxUi, isRiskyElement, type NyxCursorDriver } from "../src/features/nyx/uiExecutor";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function cursor(): NyxCursorDriver {
  return { flyTo: vi.fn(async () => {}), press: vi.fn(async () => {}), glow: vi.fn(() => {}) };
}

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

const deps = (root: ParentNode) => ({ navigate: vi.fn(), cursor: cursor(), root, route: () => "/x", waitMs: 0, typeDelayMs: 0 });
const src = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");

describe("Geheimnisse: Passwort-Felder und ihre Formulare", () => {
  it("tippt nie in ein Passwort-Feld und drückt dessen Speichern-Knopf nicht", async () => {
    const saved = vi.fn();
    const root = mount(`
      <form id="f"><input type="password" aria-label="Bot-Token" data-nyx="telegram-token-input" />
      <button type="submit" data-nyx="telegram-token-save">Speichern &amp; verbinden</button></form>`);
    root.querySelector("form")?.addEventListener("submit", (e) => (e.preventDefault(), saved()));
    const typed = await executeNyxUi({ action: "type", target: "telegram-token-input", text: "999:evil", submit: true }, deps(root));
    expect(typed.ok).toBe(false);
    expect(typed.risky).toBe(true);
    expect((root.querySelector("input") as HTMLInputElement).value).toBe("");
    const clicked = await executeNyxUi({ action: "click", target: "telegram-token-save" }, deps(root));
    expect(clicked.ok).toBe(false);
    expect(clicked.risky).toBe(true);
    expect(saved).not.toHaveBeenCalled();
  });

  it("normale Formulare bleiben bedienbar", () => {
    const root = mount(`<form><input aria-label="Name" /><button type="submit">Speichern</button></form>`);
    expect(isRiskyElement(root.querySelector("input") as Element)).toBe(false);
    expect(isRiskyElement(root.querySelector("button") as Element)).toBe(false);
  });
});

describe("Bereiche mit Zugangsdaten tragen data-nyx-risk", () => {
  it.each([
    "features/telegram/TelegramSettingsPanel.tsx",
    "features/settings/ConnectorsPanel.tsx",
    "features/settings/ModelsPanel.tsx",
    "features/settings/access/AccessPanel.tsx",
    "features/settings/access/AccessWizard.tsx",
    "features/settings/AuthSettingsPanel.tsx",
    "features/settings/PasskeyList.tsx",
    "features/idealink/IdeaLinksPanel.tsx",
    "features/terminal/LoginDialog.tsx",
    "features/settings/nyx/NyxVoiceSettings.tsx",
    "features/conflicts/DecisionBlock.tsx",
  ])("%s", (f) => {
    expect(src(f)).toContain('data-nyx-risk=""');
  });

  it("Telegram: Token UND Kopplung gesperrt", () => {
    expect(src("features/telegram/TelegramSettingsPanel.tsx").match(/data-nyx-risk=""/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
