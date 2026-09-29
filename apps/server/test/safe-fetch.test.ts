// safeFetch: keine Aufrufe ins interne Netz (SSRF) – Adress-Prüfung, DNS, Weiterleitungen.
import { describe, expect, it } from "vitest";
import { assertPublicUrl, isBlockedAddress, safeFetch, UnsafeUrlError } from "../src/net/safeFetch.js";

const pub = { allowPrivate: false, resolve: async () => ["93.184.216.34"] };

describe("isBlockedAddress", () => {
  it("sperrt Loopback, privat, Link-Local, Docker-Netz, IPv6-Varianten; lässt öffentliche und Tailscale zu", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.18.0.3", "192.168.1.10", "169.254.169.254", "0.0.0.0", "224.0.0.1", "::1", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "fd00::1", "fe80::1"]) expect(isBlockedAddress(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "1.1.1.1", "100.101.102.103", "2606:4700::1111"]) expect(isBlockedAddress(ip), ip).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  it("Docker-Dienstnamen, IP-Literale, localhost und private DNS-Antworten → abgelehnt", async () => {
    for (const u of ["http://shop-postgres:5432/v1", "http://socket-proxy:2375/containers/json", "http://169.254.169.254/latest/meta-data", "http://[::1]:8080/", "http://localhost:1234/v1", "http://2130706433/", "http://db.internal/x"]) {
      await expect(assertPublicUrl(u, pub), u).rejects.toBeInstanceOf(UnsafeUrlError);
    }
    await expect(assertPublicUrl("https://evil.example.com/v1", { allowPrivate: false, resolve: async () => ["93.184.216.34", "172.18.0.3"] })).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicUrl("file:///etc/passwd", pub)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("öffentliche Adresse ok; mit Freigabe (Probe/Tests) auch 127.0.0.1", async () => {
    await expect(assertPublicUrl("https://api.openai.com/v1", pub)).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl("http://127.0.0.1:1234/v1", { allowPrivate: true })).resolves.toBeInstanceOf(URL);
  });
});

describe("safeFetch", () => {
  type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
  function fakeBase(responses: Response[]) {
    const calls: Call[] = [];
    const base = (async (url: string, init?: RequestInit) => {
      const h: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (h[k] = v));
      calls.push({ url, method: init?.method ?? "GET", headers: h, body: init?.body });
      expect(init?.redirect).toBe("manual");
      return responses.shift() ?? new Response("ok");
    }) as typeof fetch;
    return { base, calls };
  }
  const redirect = (status: number, location: string) => new Response(null, { status, headers: { location } });

  it("Weiterleitung ins interne Netz wird nicht verfolgt", async () => {
    const { base, calls } = fakeBase([redirect(302, "http://169.254.169.254/latest/meta-data")]);
    await expect(safeFetch(base, pub)("https://api.example.com/v1/models", { headers: { authorization: "Bearer x" } })).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(calls).toHaveLength(1);
  });

  it("Weiterleitung auf fremden Ursprung wirft Schlüssel und eigene Kopfzeilen ab; gleicher Ursprung behält sie", async () => {
    const { base, calls } = fakeBase([redirect(307, "/v2/models"), redirect(307, "https://other.example.org/x"), new Response("ok")]);
    const res = await safeFetch(base, pub)("https://api.example.com/v1/models", { method: "POST", body: "{}", headers: { authorization: "Bearer geheim", "x-api-key": "sk-geheim", "x-eigen": "1", "content-type": "application/json" } });
    expect(await res.text()).toBe("ok");
    expect(calls.map((c) => c.url)).toEqual(["https://api.example.com/v1/models", "https://api.example.com/v2/models", "https://other.example.org/x"]);
    expect(calls[1]?.headers).toMatchObject({ authorization: "Bearer geheim", "x-api-key": "sk-geheim" });
    expect(calls[2]?.headers).toEqual({ "content-type": "application/json" });
    expect(calls[2]?.method).toBe("POST");
  });

  it("303 nach POST → GET ohne Inhalt; zu viele Weiterleitungen → Abbruch", async () => {
    const a = fakeBase([redirect(303, "/done"), new Response("ok")]);
    await safeFetch(a.base, pub)("https://api.example.com/start", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(a.calls[1]).toMatchObject({ method: "GET", body: undefined });
    const loop = fakeBase(Array.from({ length: 10 }, () => redirect(302, "/again")));
    await expect(safeFetch(loop.base, pub)("https://api.example.com/start")).rejects.toThrow(/Weiterleitungen/);
  });
});
