// Mitgeschicktes Bild im Chat: Es stand früher im Chat nur als „[Image #1]“. Jetzt: Vorschau (angemeldet
// über den Server), und wenn die nicht lädt, ein klarer Datei-Chip mit Art und Größe.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatItem } from "../src/components/sessions/ChatItem";

const item = {
  id: "claude:s1:u-img",
  ts: "2026-09-25T12:48:42.000Z",
  role: "user" as const,
  text: "[Image #1] Welche Farbe hat dieses Bild?",
  images: [{ n: 1, mediaType: "image/png", bytes: 2048 }],
  thinking: false as const,
};

describe("Chat · mitgeschicktes Bild", () => {
  it("zeigt eine Vorschau vom Server (nur diese Session, dieser Eintrag)", () => {
    render(<ChatItem item={item} sessionId="claude:s1" />);
    const img = screen.getByRole("img", { name: "Bild 1 – von dir gesendet" });
    expect(img.getAttribute("src")).toBe("/api/sessions/claude%3As1/attachments/claude%3As1%3Au-img/1");
  });

  it("lädt die Vorschau nicht (z. B. abgemeldet), steht ein Datei-Chip mit Art und Größe da", () => {
    render(<ChatItem item={item} sessionId="claude:s1" />);
    fireEvent.error(screen.getByRole("img", { name: "Bild 1 – von dir gesendet" }));
    expect(screen.getByTestId("chat-image-chip")).toHaveTextContent("Bild 1 · PNG · 2 KB");
  });
});
