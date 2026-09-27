// A1b · Ersatz für `/usr/bin/ssh` in Tests: Statt einen Tunnel aufzubauen, ist dieses Programm selbst der
// „Server" hinter dem lokalen Port. Es liest dieselben Argumente wie ssh (`-L 127.0.0.1:<port>:…` und als
// letztes Argument den „Host") und nutzt den Host als Zustandsordner:
//   mode      "ok" (Standard) | "hang": nimmt Verbindungen an, antwortet aber nie (Tunnel hängt)
//   pings     "on" (Standard) | "off": WebSocket-Pings des Servers (aus = halb offene Verbindung)
//   ping-ms   Abstand der Pings (Standard 100)
//   events.jsonl  Protokoll: {t, pid, kind: start|upgrade|ingest|health, items?}
// Kein echtes SSH, kein Netz nach außen.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const args = process.argv.slice(2);
const forward = args[args.indexOf("-L") + 1] ?? "";
const port = Number(forward.split(":")[1]);
const dir = args.at(-1) ?? ".";

const read = (name, fallback) => {
  try {
    return readFileSync(join(dir, name), "utf8").trim() || fallback;
  } catch {
    return fallback;
  }
};
const record = (kind, extra = {}) => appendFileSync(join(dir, "events.jsonl"), JSON.stringify({ t: Date.now(), pid: process.pid, kind, ...extra }) + "\n");

const server = createServer((req, res) => {
  if (read("mode", "ok") === "hang") return; // Anfrage bleibt für immer offen
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.url === "/health") {
      record("health");
      res.end("ok");
      return;
    }
    if (req.method === "POST" && req.url === "/ingest/events") {
      let items = 0;
      try {
        items = JSON.parse(Buffer.concat(chunks).toString("utf8")).items.length;
      } catch {
        // kaputter Körper: zählt als 0
      }
      record("ingest", { items });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ accepted: items, duplicates: 0 }));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
});

// Minimaler WebSocket-Server (RFC 6455): Handschlag + Ping-Rahmen. Eingehende Rahmen werden ignoriert.
server.on("upgrade", (req, socket) => {
  if (read("mode", "ok") === "hang") return;
  const key = String(req.headers["sec-websocket-key"] ?? "");
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  record("upgrade");
  socket.on("error", () => {});
  socket.on("data", () => {});
  const tick = () => {
    if (socket.destroyed) return;
    if (read("pings", "on") === "on") socket.write(Buffer.from([0x89, 0x00]));
    setTimeout(tick, Number(read("ping-ms", "100")));
  };
  tick();
});

server.listen(port, "127.0.0.1", () => record("start", { port }));
process.on("SIGTERM", () => process.exit(0));
