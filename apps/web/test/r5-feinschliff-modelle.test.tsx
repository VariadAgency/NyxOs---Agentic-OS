// Model ids appear in the interface as readable names ("Haiku 4.5"), the exact id only in the tooltip.
import { render, screen } from "@testing-library/react";
import { DEFAULT_ROLE_LABEL, SKILLS_CREATE_LABEL } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { readableModel, splitModelLabel } from "../src/lib/modelName";
import { ActiveModelChip } from "../src/features/settings/ModelsPanel";

describe("readable model names", () => {
  it.each([
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-sonnet-5-5", "Sonnet 5.5"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5"],
    ["haiku", "Haiku 4.5"],
    ["gpt-5.6-terra", "GPT-5.6 Terra"],
    ["mistral-large-2", "mistral-large-2"],
  ])("%s → %s", (id, want) => {
    expect(readableModel(id)).toBe(want);
  });

  it("splits the server text: name, additions without the id, brackets separate", () => {
    expect(splitModelLabel(DEFAULT_ROLE_LABEL, "claude-haiku-4-5-20251001")).toEqual({ name: "Haiku 4.5", extras: [], note: "Standard, Claude-Programm" });
    // Default route: id "haiku", the text names the exact version.
    expect(splitModelLabel(DEFAULT_ROLE_LABEL, "haiku")).toEqual({ name: "Haiku 4.5", extras: [], note: "Standard, Claude-Programm" });
    expect(splitModelLabel(SKILLS_CREATE_LABEL, "claude-opus-5-5")).toEqual({ name: "Opus 5.5", extras: [], note: "Claude Code" });
    expect(splitModelLabel("Claude Sonnet 5 · claude-sonnet-5 · Reasoning hoch (Claude-Programm)", "claude-sonnet-5")).toEqual({ name: "Sonnet 5", extras: ["denkt gründlich"], note: "Claude-Programm" });
    expect(splitModelLabel("gpt-5.6-terra · My provider", "gpt-5.6-terra")).toEqual({ name: "GPT-5.6 Terra", extras: ["My provider"], note: null });
  });

  it("models & connectors: the chip shows the name, the id only in the tooltip", () => {
    render(<ActiveModelChip role="nyx.chat" label={DEFAULT_ROLE_LABEL} model="claude-haiku-4-5-20251001" pill="" />);
    const chip = screen.getByTestId("active-nyx.chat");
    expect(chip).toHaveTextContent("Haiku 4.5");
    expect(chip).toHaveTextContent("Standard, Claude-Programm");
    expect(chip.textContent).not.toContain("claude-haiku-4-5-20251001");
    expect(chip).toHaveAttribute("title", expect.stringContaining("claude-haiku-4-5-20251001"));
  });
});
