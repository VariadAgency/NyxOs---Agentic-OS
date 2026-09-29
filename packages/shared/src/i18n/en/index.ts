// English dictionaries, one file per area (German source text → English).
import webApp from "./web-app.js";
import webNyx from "./web-nyx.js";
import webSessions from "./web-sessions.js";
import webTasks from "./web-tasks.js";
import webOverview from "./web-overview.js";
import webSettings from "./web-settings.js";
import webSystem from "./web-system.js";
import webBrain from "./web-brain.js";
import webFiles from "./web-files.js";
import onboarding from "./onboarding.js";
import server from "./server.js";
import shared from "./shared.js";
import bridge from "./bridge.js";
import webSupport from "./web-support.js";
import notifications from "./notifications.js";
import webHosting from "./web-hosting.js";
import serverHosting from "./server-hosting.js";
import focus from "./focus.js";

export const EN: Readonly<Record<string, string>> = Object.freeze({
  ...webApp,
  ...webNyx,
  ...webSessions,
  ...webTasks,
  ...webOverview,
  ...webSettings,
  ...webSystem,
  ...webBrain,
  ...webFiles,
  ...onboarding,
  ...server,
  ...shared,
  ...bridge,
  ...webSupport,
  ...notifications,
  ...webHosting,
  ...serverHosting,
  ...focus,
});
