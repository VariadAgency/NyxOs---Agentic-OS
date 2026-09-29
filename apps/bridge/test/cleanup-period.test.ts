import { describe, expect, it } from "vitest";
import { nextCleanupPeriodDays, restoreCleanupPeriod } from "../src/install.js";

describe("cleanupPeriodDays: raised on install, restored on uninstall", () => {
  it("restores the user's own value", () => {
    const raised = { theme: "dark", cleanupPeriodDays: nextCleanupPeriodDays(60) };
    expect(restoreCleanupPeriod(raised, 60)).toEqual({ settings: { theme: "dark", cleanupPeriodDays: 60 }, changed: true });
  });

  it("removes the key again when there was none", () => {
    const raised = { theme: "dark", cleanupPeriodDays: nextCleanupPeriodDays(null) };
    expect(restoreCleanupPeriod(raised, null)).toEqual({ settings: { theme: "dark" }, changed: true });
  });

  it("keeps a value the user changed after the install", () => {
    const changedByUser = { cleanupPeriodDays: 90 };
    expect(restoreCleanupPeriod(changedByUser, null)).toEqual({ settings: changedByUser, changed: false });
  });
});
