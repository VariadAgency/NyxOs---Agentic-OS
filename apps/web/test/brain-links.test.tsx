// Die 2D-Kanten zeichnet das Gehirn jetzt selbst. Welche Kanten normal, ausgegraut oder
// gar nicht gezeichnet werden, muss den Filtern folgen (zeigen · grau · aus) — sonst hängen an
// ausgeblendeten Punkten plötzlich Striche ins Leere.
import type { GraphLink, GraphNode } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { computeView, splitLinks } from "../src/features/brain/filter";
import { defaultSettings } from "../src/features/brain/settings";

const n = (id: string, type: GraphNode["type"]): GraphNode => ({ id, type, label: id, group: "", degree: 1, ref: { kind: "session", sessionKey: id, tool: "claude", art: "coding" } as GraphNode["ref"] });
const l = (source: string, target: string): GraphLink => ({ source, target, kind: "parent", weight: 1 });

describe("splitLinks (selbst gezeichnete 2D-Kanten)", () => {
  const nodes = [n("s1", "session"), n("s2", "session"), n("c1", "commit"), n("a1", "subagent")];
  const links = [l("s1", "s2"), l("s1", "c1"), l("s2", "a1"), l("c1", "a1")];

  it("alles zeigen: alle Kanten normal", () => {
    const view = computeView(nodes, links, defaultSettings());
    const { base, dim } = splitLinks(view, links);
    expect(base).toHaveLength(4);
    expect(dim).toHaveLength(0);
  });

  it("grau: Kanten an ausgegrauten Punkten ausgegraut; aus: Kanten an ausgeblendeten Punkten weg", () => {
    const s = defaultSettings();
    const view = computeView(nodes, links, { ...s, groups: { ...s.groups, commit: "dim", subagent: "hide" } });
    const { base, dim } = splitLinks(view, links);
    expect(base.map((x) => `${String(x.source)}-${String(x.target)}`)).toEqual(["s1-s2"]);
    expect(dim.map((x) => `${String(x.source)}-${String(x.target)}`)).toEqual(["s1-c1"]);
  });
});
