// The "SubagentStop" hook reports WHICH sub-agent finished (`agent_id`). The bridge passes the id on as
// `subagentId` (deliberately not `agentId`: that field marks events FROM a sub-agent transcript and would otherwise
// count the hook as the agent's last activity). Same payload on macOS and Linux.
import { describe, expect, it } from "vitest";
import { hookEvent } from "../src/spool.js";
import { ROOT } from "./helpers.js";

describe("SubagentStop with agent id", () => {
  const at = new Date("2026-09-28T10:00:00.000Z");

  it("takes agent_id over as subagentId", () => {
    const e = hookEvent("1-2-SubagentStop-claude.json", { session_id: "s1", cwd: ROOT, agent_id: "a123", agent_type: "Explore" }, at, [ROOT]);
    expect(e?.data).toMatchObject({ event: "SubagentStop", subagentId: "a123", agentType: "Explore" });
    expect(e?.data.agentId).toBeUndefined();
  });

  it("without agent_id no field (older Claude Code versions)", () => {
    const e = hookEvent("1-3-SubagentStop-claude.json", { session_id: "s1", cwd: ROOT }, at, [ROOT]);
    expect(e?.data.subagentId).toBeUndefined();
  });
});
