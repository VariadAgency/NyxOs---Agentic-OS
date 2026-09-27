// Fake-MCP-Server über stdio (für den Konnektor-Test): ein Werkzeug `echo`, verlangt FAKE_TOKEN=geheim.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.id === undefined) return;
  if (req.method === "initialize") send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-stdio", version: "1" } } });
  else if (req.method === "tools/list") {
    if (process.env.FAKE_TOKEN !== "geheim") send({ jsonrpc: "2.0", id: req.id, error: { code: -32001, message: "Token fehlt" } });
    else send({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "echo", description: "gibt Text zurück", inputSchema: { type: "object" } }] } });
  } else if (req.method === "tools/call") send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: `echo:${JSON.stringify(req.params.arguments)}` }] } });
  else send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "unbekannt" } });
});
