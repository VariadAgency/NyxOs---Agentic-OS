// Bildschirm-Abfrage und Steuerung nur mit Anmeldung.
import { describe, expect, it } from "vitest";
import { needsAuth } from "../src/terminal/auth.js";

describe("Nyx steuert NyxOS: nur angemeldet", () => {
  it("GET /api/nyx/ui/screen braucht immer eine Anmeldung (liest Alex' Bildschirm)", () => {
    expect(needsAuth("GET", "/api/nyx/ui/screen", false)).toBe(true);
  });
});
