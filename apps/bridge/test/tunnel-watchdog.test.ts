// Tunnel-Wächter: Die Brücke prüft ihren eigenen SSH-Tunnel regelmäßig (`GET /health` mit Zeitlimit).
// Hängt er (ssh lebt, leitet aber nichts mehr weiter), beendet sie NUR ihren eigenen ssh-Prozess und baut
// ihn neu auf (`tunnel-watchdog`). Getestet mit einem Ersatz-ssh, kein echtes SSH.
import { afterEach, describe, expect, it } from "vitest";
import { sshArgs, Tunnel, tunnelFailure } from "../src/tunnel.js";
import { alive, fakeSsh, freePort, until } from "./fake-ssh.js";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.reverse()) s();
  stops.length = 0;
});

async function world() {
  const fake = fakeSsh();
  const port = await freePort();
  const logs: { msg: string; extra: Record<string, unknown> }[] = [];
  let ups = 0;
  const tunnel = new Tunnel(
    { host: fake.dir, localPort: port, remotePort: 1 },
    (msg, extra = {}) => logs.push({ msg, extra }),
    () => void ups++,
    { sshBin: fake.bin, upAfterMs: 300, healthEveryMs: 100, healthTimeoutMs: 200, failuresBeforeRestart: 2, minRestartMs: 100 },
  );
  stops.push(() => tunnel.stop());
  return { fake, port, logs, tunnel, ups: () => ups };
}

describe("Tunnel-Wächter (A1b)", () => {
  it("gesunder Tunnel: prüft regelmäßig, startet nie neu", async () => {
    const w = await world();
    w.tunnel.start();
    await until(() => w.tunnel.up);
    await until(() => w.fake.of("health").length >= 3, 5000);
    expect(w.fake.of("start")).toHaveLength(1);
    expect(w.logs.some((l) => l.msg === "tunnel-watchdog")).toBe(false);
  });

  it("Tunnel hängt (ssh lebt, antwortet nicht) → eigener ssh-Prozess wird beendet und neu gestartet", async () => {
    const w = await world();
    w.tunnel.start();
    await until(() => w.tunnel.up && w.fake.of("start").length === 1);
    const firstPid = w.fake.of("start")[0]?.pid ?? 0;
    expect(firstPid).toBeGreaterThan(0);

    w.fake.set("mode", "hang");
    await until(() => w.logs.some((l) => l.msg === "tunnel-watchdog"), 5000);
    const wd = w.logs.find((l) => l.msg === "tunnel-watchdog");
    expect(wd?.extra.fehlversuche).toBe(2);
    expect(wd?.extra.pid).toBe(firstPid);

    w.fake.set("mode", "ok");
    await until(() => w.fake.of("start").length === 2 && w.tunnel.up, 8000);
    const secondPid = w.fake.of("start")[1]?.pid ?? 0;
    expect(secondPid).not.toBe(firstPid);
    await until(() => !alive(firstPid), 5000); // der alte ssh ist wirklich weg
    expect(alive(secondPid)).toBe(true);
    expect(w.ups()).toBe(2);
  });

  it("nur Zeitüberschreitung und abgewiesene Verbindung zählen als Tunnel-Fehler", () => {
    // Jede HTTP-Antwort (auch 503) beweist, dass der Tunnel trägt. Ein sofort geschlossener Kanal heißt:
    // ssh leitet weiter, aber hinter dem Server-Port lauscht (gerade) niemand — ein ssh-Neustart hilft nicht.
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(tunnelFailure(timeout)).toBe("zeitueberschreitung");
    expect(tunnelFailure(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))).toBe("abgewiesen");
    expect(tunnelFailure(Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" }))).toBe("abgewiesen");
    expect(tunnelFailure(Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }))).toBeNull();
  });

  it("ssh-Argumente unverändert: Keepalive bleibt, nur der eigene Prozess wird verwaltet", () => {
    const a = sshArgs({ host: "prod-server", localPort: 47801, remotePort: 47800 });
    expect(a).toContain("ServerAliveInterval=15");
    expect(a).toContain("ControlMaster=no");
    expect(a.at(-1)).toBe("prod-server");
  });
});
