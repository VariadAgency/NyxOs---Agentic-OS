// Demo: `POST /api/demo/start` (local instance only: starts or reuses the demo instance, answers with its
// one-time sign-in URL) and `GET /api/demo/questions` (suggested questions for Nyx inside the demo).
import { getLang, t } from "@nyxos/shared";
import type { Hono } from "hono";
import type { Env } from "../app.js";
import type { DemoLauncher } from "../demo/launcher.js";
import { demoQuestions } from "../demo/nyx.js";

export interface DemoRouteDeps {
  /** null in server mode and inside the demo itself (no demo from there). */
  launcher: () => DemoLauncher | null;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export function registerDemoRoutes(app: Hono<Env>, deps: DemoRouteDeps): void {
  app.post("/api/demo/start", async (c) => {
    const launcher = deps.launcher();
    if (!launcher) return c.json({ error: t("Die Demo gibt es nur in NyxOS auf deinem Rechner.") }, 409);
    // The way back: this instance as the browser reached it (its onboarding).
    const homeUrl = `${new URL(c.req.url).origin}/`;
    try {
      return c.json({ url: await launcher.start({ lang: getLang(), homeUrl }) });
    } catch (e) {
      deps.log("demo-start-fehler", { error: String(e) });
      return c.json({ error: t("Die Demo startet gerade nicht. Versuch es gleich noch einmal.") }, 503);
    }
  });

  app.get("/api/demo/questions", (c) => c.json({ questions: demoQuestions() }));
}
