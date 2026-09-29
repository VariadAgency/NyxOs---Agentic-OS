// Push → notifications: the entry point for every occasion (waiting session, context guard, build red, approval,
// usage …). `notify()` sends it through the shared pipeline (`notifications/pipeline.ts`):
// when? → text → Nyx checks/writes → quiet hours/bundling → channels. Every decision lands with a reason in `push_log`.
import type { PushNotifyInput, PushSettings } from "@nyxos/shared";
import type { Db } from "../db/client.js";
import { runPipeline, type NotifyEnv } from "../notifications/pipeline.js";
import type { NtfySender } from "./ntfy.js";
import type { NotifyResult } from "./deliver.js";

export { isQuietNow, type NotifyResult } from "./deliver.js";

export interface NotifyDeps {
  db: Db;
  sender: NtfySender;
  settings: PushSettings;
  now?: Date;
  /**
   * Runtime environment (presence, away digest, Nyx). Without it (tests, older callers) the user counts as present
   * and Nyx is not involved – rules, names and templates apply anyway.
   */
  env?: NotifyEnv;
}

export function notify(input: PushNotifyInput, deps: NotifyDeps): Promise<NotifyResult> {
  return runPipeline(input, deps);
}
