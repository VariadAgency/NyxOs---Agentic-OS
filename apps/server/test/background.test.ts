import { describe, expect, it } from "vitest";
import { BackgroundTasks } from "../src/background.js";

describe("BackgroundTasks", () => {
  it("idle() wartet auf laufende Arbeit, auch auf währenddessen neu gestartete, und schluckt Fehler", async () => {
    const bg = new BackgroundTasks();
    const done: string[] = [];
    const later = (ms: number, name: string) => new Promise<void>((r) => setTimeout(() => (done.push(name), r()), ms));
    bg.run(later(20, "a").then(() => bg.run(later(20, "b"))));
    bg.run(Promise.reject(new Error("egal")));
    expect(bg.size).toBe(2);
    await bg.idle();
    expect(done).toEqual(["a", "b"]);
    expect(bg.size).toBe(0);
  });

  it("idle() ohne Arbeit kehrt sofort zurück", async () => {
    await new BackgroundTasks().idle();
  });
});
