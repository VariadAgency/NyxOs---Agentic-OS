// Fakes für Push/Nachtmodus-Tests. `FakeSessionStarter`/`FakeMacAvailability` erfüllen die
// `@nyxos/shared`-Schnittstellen, die im Betrieb die Brücke (tmux) und die Haiku-Startkette mit echtem
// Verhalten füllen — s. `night/planner.ts` Datei-Kopf.
import type { MacAvailability, NightReadyTask, SessionStarter, StartedSession } from "@nyxos/shared";
import type { NtfyMessage, NtfySender } from "../../src/push/ntfy.js";

export class FakeNtfySender implements NtfySender {
  sent: NtfyMessage[] = [];
  nextOk = true;
  async send(msg: NtfyMessage): Promise<{ ok: boolean; status: number }> {
    this.sent.push(msg);
    return { ok: this.nextOk, status: this.nextOk ? 200 : 500 };
  }
}

export class FakeSessionStarter implements SessionStarter {
  started: NightReadyTask[] = [];
  stopped: Array<{ sessionKey: string; reason: string }> = [];
  private tokens = new Map<string, number>();
  private counter = 0;

  async start(task: NightReadyTask): Promise<StartedSession> {
    this.started.push(task);
    const sessionKey = `fake:${task.taskId}:${++this.counter}`;
    this.tokens.set(sessionKey, 0);
    return { sessionKey, worktreePath: `/tmp/fake-worktree/${task.taskId}`, branch: `auftrag/${task.taskId}` };
  }

  async isRunning(sessionKey: string): Promise<boolean> {
    return this.tokens.has(sessionKey);
  }

  async stop(sessionKey: string, reason: string): Promise<void> {
    this.stopped.push({ sessionKey, reason });
    this.tokens.delete(sessionKey);
  }

  async tokensUsed(sessionKey: string): Promise<number> {
    return this.tokens.get(sessionKey) ?? 0;
  }

  /** Test-Hilfe: simuliert Verbrauch zwischen zwei Ticks. */
  setTokens(sessionKey: string, value: number): void {
    this.tokens.set(sessionKey, value);
  }
}

export class FakeMacAvailability implements MacAvailability {
  available = true;
  async isAwakeAndPowered(): Promise<boolean> {
    return this.available;
  }
}
