// Simulations-Host: dieselbe Logik läuft im Web-Worker (`sim.worker.ts`) oder — wo es keinen Worker
// gibt — im Hauptthread (Rückfall). Nimmt `ToWorker`-Nachrichten an, schickt `FromWorker` zurück.
import type { Simulation } from "d3-force";
import { applyForces, buildSimulation, type FromWorker, type ToWorker, type WLink, type WNode } from "./simulation";

const FRAME_MS = 16;

export function createSimHost(post: (msg: FromWorker, transfer: Transferable[]) => void): (m: ToWorker) => void {
  let sim: Simulation<WNode, WLink> | null = null;
  let nodes: WNode[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ring: (() => number) | null = null;
  let gen = 0;

  const sendPositions = (tickMs: number) => {
    const xs = new Float32Array(nodes.length);
    const ys = new Float32Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      xs[i] = n?.x ?? 0;
      ys[i] = n?.y ?? 0;
    }
    post({ type: "positions", gen, xs, ys, alpha: sim?.alpha() ?? 0, tickMs, ringRadius: ring?.() ?? 0 }, [xs.buffer, ys.buffer]);
  };

  const loop = () => {
    timer = null;
    if (!sim) return;
    const t0 = performance.now();
    sim.tick();
    const tickMs = performance.now() - t0;
    sendPositions(tickMs);
    if (sim.alpha() < sim.alphaMin() && sim.alphaTarget() === 0) {
      post({ type: "settled", gen }, []);
      return;
    }
    timer = setTimeout(loop, Math.max(0, FRAME_MS - tickMs));
  };
  const kick = () => {
    if (!timer) timer = setTimeout(loop, 0);
  };

  return (m) => {
    switch (m.type) {
      case "init": {
        sim?.stop();
        gen = m.gen;
        nodes = Array.from(m.degree, (degree, i) => {
          const x = m.xs[i] ?? Number.NaN;
          const y = m.ys[i] ?? Number.NaN;
          const n: WNode = { index: i, degree, orphan: degree === 0 };
          if (!Number.isNaN(x) && !Number.isNaN(y)) {
            n.x = x;
            n.y = y;
          }
          return n;
        });
        const links: WLink[] = [];
        for (let i = 0; i < m.src.length; i++) {
          const s = nodes[m.src[i] ?? -1];
          const t = nodes[m.dst[i] ?? -1];
          if (s && t) links.push({ source: s, target: t, weight: m.weight[i] ?? 1 });
        }
        sim = buildSimulation(nodes, links, m.forces);
        ring = (sim.force("orphans") as unknown as { radius: () => number }).radius;
        sim.alpha(m.alpha);
        // Vorrechnen ohne Zwischenbilder, bis die grobe Form steht (oder die Zeit um ist).
        const until = performance.now() + m.warmupMs;
        while (m.warmupMs > 0 && performance.now() < until && sim.alpha() > 0.08) sim.tick();
        sendPositions(0);
        kick();
        break;
      }
      case "forces":
        if (!sim) return;
        applyForces(sim, m.forces);
        sim.alpha(Math.max(sim.alpha(), 0.5));
        kick();
        break;
      case "reheat":
        if (!sim) return;
        sim.alpha(Math.max(sim.alpha(), m.alpha));
        kick();
        break;
      case "drag": {
        const n = nodes[m.index];
        if (!sim || !n) return;
        n.fx = m.x;
        n.fy = m.y;
        sim.alphaTarget(0.25);
        kick();
        break;
      }
      case "dragEnd": {
        const n = nodes[m.index];
        if (!sim || !n) return;
        n.fx = null;
        n.fy = null;
        sim.alphaTarget(0);
        kick();
        break;
      }
      case "stop":
        sim?.stop();
        sim = null;
        if (timer) clearTimeout(timer);
        timer = null;
        break;
    }
  };
}
