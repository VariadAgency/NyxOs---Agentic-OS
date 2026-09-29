// Die Komprimierung steht im Chat als ruhige Zeile mit Uhrzeit („Kontext komprimiert · 16:01“).
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatItem } from "../src/components/sessions/ChatItem";

describe("Chat · Kontext komprimiert", () => {
  it("zeigt eine ruhige Zeile mit Uhrzeit, ohne Blase", () => {
    const ts = "2026-09-25T14:01:28.721Z";
    const hhmm = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" }).format(new Date(ts));
    render(<ChatItem item={{ id: "claude:s1:c-0004", ts, role: "system", text: "Kontext komprimiert", thinking: false }} sessionId="claude:s1" />);
    const line = screen.getByTestId("chat-system-line");
    expect(line).toHaveTextContent(`Kontext komprimiert · ${hhmm}`);
    expect(line.getAttribute("data-item-id")).toBe("claude:s1:c-0004");
  });

  it("interne Zeilen bleiben schlicht (ohne Uhrzeit)", () => {
    render(<ChatItem item={{ id: "claude:s1:x", ts: "2026-09-25T14:01:28.721Z", role: "system", text: "Interner Hinweis", internal: true, thinking: false }} sessionId="claude:s1" />);
    expect(screen.queryByTestId("chat-system-line")).toBeNull();
    expect(screen.getByText("Interner Hinweis")).toBeInTheDocument();
  });
});
