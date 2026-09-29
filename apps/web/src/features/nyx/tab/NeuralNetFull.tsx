// Nyx' großes Netz (variant="full") — Canvas 2D mit additiver Mischung, langsam drehende Kugel aus
// echten Dingen (s. netModel.ts). Reagiert sichtbar auf alle Zustände:
//   idle      ruhiges Atmen, vereinzelte Funken
//   listening Mikro-Pegel in 5 Bändern lässt Knoten je Sektor aufleuchten, Wellen laufen vom Rand nach innen
//   thinking  Signale laufen über die Kanten (schnell)
//   speaking  Wellen gehen im Takt der Stimme vom Kern aus
//   tool      der Werkzeug-Knoten leuchtet mit Namen, Signale fließen Kern → Werkzeug → gelesene Dinge
// Pegel/Zustand liegen in einem veränderbaren Objekt (kein React-State bei 60 fps, „Drive“-Muster aus
// adewaskar/jarvis `scene/Scene.tsx`, MIT); ohne Audio synthetische Zielwerte je Zustand (elevenlabs/ui `orb.tsx`, MIT).
import { nyxToolDoing, t, type NyxState } from "@nyxos/shared";
import { useEffect, useRef, useState } from "react";
import { STATE_COLOR } from "./net3d/visual";
import { findToolIndex, nodeText, targetsOfTool, type NetModel, type NetNode } from "./netModel";
import type { LevelDrive } from "./voice/level";

export interface NeuralNetFullProps {
  model: NetModel;
  state: NyxState;
  drive: LevelDrive;
  tool: string | null;
  /** Knoten-ID aus dem Gehirn-Graph, der zusätzlich leuchten soll (`nyx.state.node`). */
  highlightNode?: string | null;
  onOpen?: (href: string) => void;
  className?: string;
}

/** Drehgeschwindigkeit (rad/s) und Signal-Tempo je Zustand (Werte angelehnt an adewaskar `spinFor`). */
const SPIN: Record<NyxState, number> = { idle: 0.05, listening: 0.08, thinking: 0.2, tool: 0.13, speaking: 0.1 };
const SIGNAL_SPEED: Record<NyxState, number> = { idle: 0.08, listening: 0.18, thinking: 0.9, tool: 0.7, speaking: 0.3 };
const TILT = 0.38;
const FOCAL = 3.2;

const STATE_LABEL: Record<NyxState, string> = {
  idle: t("Nyx ruht"),
  listening: t("Nyx hört zu"),
  thinking: t("Nyx denkt"),
  speaking: t("Nyx spricht"),
  tool: t("Nyx benutzt ein Werkzeug"),
};

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Weicher Leuchtpunkt je Farbe, einmal vorgerendert (drawImage ist viel billiger als ein Verlauf je Knoten). */
function glowSprite(color: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (!g) return c;
  const [r, gg, b] = hexRgb(color);
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `rgba(${r},${gg},${b},1)`);
  grad.addColorStop(0.22, `rgba(${r},${gg},${b},0.55)`);
  grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function NeuralNetFull({ model, state, drive, tool, highlightNode, onOpen, className }: NeuralNetFullProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const live = useRef({ state, tool, highlightNode, model });
  live.current = { state, tool, highlightNode, model };
  const projected = useRef<{ x: number; y: number; r: number; i: number }[]>([]);
  const [hover, setHover] = useState<{ x: number; y: number; node: NetNode } | null>(null);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const sprites = new Map<string, HTMLCanvasElement>();
    const sprite = (color: string) => {
      let s = sprites.get(color);
      if (!s) {
        s = glowSprite(color);
        sprites.set(color, s);
      }
      return s;
    };

    let w = 0;
    let h = 0;
    let dpr = 1;
    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = Math.max(1, rect.width);
      h = Math.max(1, rect.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    };
    resize();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    ro?.observe(wrap);

    let angle = 0.6;
    let last = performance.now();
    let raf = 0;
    // Geglättete Anzeige-Werte (zeitbasiert, unabhängig von der Bildrate).
    let inLvl = 0;
    let outLvl = 0;
    let toolGlow = 0;
    const waves: { born: number; strength: number; inward: boolean }[] = [];
    let lastWave = 0;

    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (document.visibilityState === "hidden") return;
      const now = performance.now();
      const dt = Math.min(64, now - last);
      last = now;
      const t = now / 1000;
      const { state: st, tool: activeTool, highlightNode: hl, model: m } = live.current;

      // Pegel: echt, sonst synthetisch je Zustand (Netz lebt auch bei Telegram-Gesprächen ohne Ton im Browser).
      let targetIn = drive.input;
      let targetOut = drive.output;
      if (st === "listening" && targetIn < 0.02) targetIn = clamp01(0.18 + Math.sin(t * 3.2) * 0.1);
      // Sprechen: echter Ausgangspegel verstärkt, mit Silben-Takt als Untergrenze (leise Stimmen sollen sichtbar pulsieren).
      if (st === "speaking") targetOut = clamp01(Math.max(targetOut * 1.8, 0.3 + Math.abs(Math.sin(t * 7.1)) * 0.3 + Math.sin(t * 3.3) * 0.1));
      const k = 1 - Math.pow(0.1, dt / 120);
      inLvl += (targetIn - inLvl) * k;
      outLvl += (targetOut - outLvl) * k;
      toolGlow += ((st === "tool" ? 1 : 0) - toolGlow) * (1 - Math.pow(0.1, dt / 250));

      angle += (reduced ? SPIN[st] * 0.2 : SPIN[st]) * (dt / 1000);
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const cosT = Math.cos(TILT);
      const sinT = Math.sin(TILT);
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.4;

      // Wellen: Sprechen → vom Kern nach außen im Takt; Zuhören → vom Rand nach innen mit dem Pegel.
      if (st === "speaking" && outLvl > 0.2 && now - lastWave > 240 - outLvl * 100) {
        waves.push({ born: now, strength: outLvl, inward: false });
        lastWave = now;
      } else if (st === "listening" && inLvl > 0.2 && now - lastWave > 320) {
        waves.push({ born: now, strength: inLvl, inward: true });
        lastWave = now;
      }
      while (waves.length && now - (waves[0]?.born ?? now) > 1600) waves.shift();

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";

      const n = m.nodes.length;
      const px = new Float32Array(n);
      const py = new Float32Array(n);
      const pz = new Float32Array(n);
      const ps = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const node = m.nodes[i] as NetNode;
        const x1 = node.x * cosA + node.z * sinA;
        const z1 = -node.x * sinA + node.z * cosA;
        const y2 = node.y * cosT - z1 * sinT;
        const z2 = node.y * sinT + z1 * cosT;
        const p = FOCAL / (FOCAL + z2);
        px[i] = cx + x1 * R * p;
        py[i] = cy + y2 * R * p;
        pz[i] = z2;
        ps[i] = p;
      }

      const toolIdx = activeTool ? findToolIndex(m, activeTool, { add: true }) : -1;
      const targets = new Set(toolIdx >= 0 ? targetsOfTool(m, toolIdx) : []);
      const hlIdx = hl ? m.nodes.findIndex((nd) => nd.id === hl) : -1;
      if (hlIdx >= 0) targets.add(hlIdx);

      // Kanten
      ctx.lineWidth = 1;
      for (const e of m.edges) {
        const a = m.nodes[e.a] as NetNode;
        const depth = clamp01(0.55 - (pz[e.a] ?? 0) * 0.35);
        const active = toolIdx >= 0 && (e.a === toolIdx || e.b === toolIdx || (e.a === 0 && e.b === toolIdx));
        const [r, g, b] = hexRgb(active ? STATE_COLOR.tool : a.color);
        const base = e.kind === "core" ? 0.24 : e.kind === "spoke" ? 0.2 : e.kind === "tool" ? 0.16 : 0.12;
        const alpha = (base + (st === "thinking" ? 0.05 : 0) + (active ? 0.45 * toolGlow : 0)) * depth;
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(px[e.a] ?? 0, py[e.a] ?? 0);
        ctx.lineTo(px[e.b] ?? 0, py[e.b] ?? 0);
        ctx.stroke();
      }

      // Signale entlang der Kanten
      const speed = SIGNAL_SPEED[st] * (reduced ? 0.3 : 1);
      for (let ei = 0; ei < m.edges.length; ei++) {
        const e = m.edges[ei];
        if (!e) continue;
        const active = toolIdx >= 0 && (e.a === toolIdx || e.b === toolIdx);
        const show = active || (st === "thinking" ? e.phase < 0.7 : st === "tool" ? e.phase < 0.25 : st === "speaking" ? e.phase < 0.2 : e.phase < 0.06);
        if (!show) continue;
        const tt = (t * speed * (active ? 1.8 : 1) + e.phase * 7) % 1;
        const x = (px[e.a] ?? 0) + ((px[e.b] ?? 0) - (px[e.a] ?? 0)) * tt;
        const y = (py[e.a] ?? 0) + ((py[e.b] ?? 0) - (py[e.a] ?? 0)) * tt;
        const color = active ? STATE_COLOR.tool : (m.nodes[e.b] as NetNode).color;
        const size = active ? 13 : st === "thinking" ? 11 : st === "speaking" ? 6 : 5;
        ctx.globalAlpha = active || st === "thinking" ? 0.95 : st === "idle" ? 0.45 : 0.75;
        ctx.drawImage(sprite(color), x - size / 2, y - size / 2, size, size);
      }
      ctx.globalAlpha = 1;

      // Wellen
      for (const wv of waves) {
        const age = (now - wv.born) / 1600;
        const rr = wv.inward ? R * (1.25 - age * 0.9) : R * (0.12 + age * 1.1);
        const [r, g, b] = hexRgb(wv.inward ? STATE_COLOR.listening : STATE_COLOR.speaking);
        ctx.strokeStyle = `rgba(${r},${g},${b},${((1 - age) * 0.35 * wv.strength).toFixed(3)})`;
        ctx.lineWidth = 1.5 + wv.strength * 2;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(2, rr), 0, Math.PI * 2);
        ctx.stroke();
      }

      // Leuchten um den Kern (atmet, wächst beim Sprechen/Zuhören)
      const halo = st === "speaking" ? outLvl : st === "listening" ? inLvl * 0.8 : st === "thinking" || st === "tool" ? 0.35 : 0.18 + 0.04 * Math.sin(t * 1.1);
      const hr = R * (0.5 + halo * 0.35);
      const hg = ctx.createRadialGradient(cx, cy, 0, cx, cy, hr);
      const [hr0, hg0, hb0] = hexRgb(STATE_COLOR[st]);
      hg.addColorStop(0, `rgba(${hr0},${hg0},${hb0},${(0.1 + halo * 0.18).toFixed(3)})`);
      hg.addColorStop(1, `rgba(${hr0},${hg0},${hb0},0)`);
      ctx.fillStyle = hg;
      ctx.fillRect(cx - hr, cy - hr, hr * 2, hr * 2);

      // Knoten
      const proj: { x: number; y: number; r: number; i: number }[] = [];
      for (let i = 0; i < n; i++) {
        const node = m.nodes[i] as NetNode;
        const depth = clamp01(0.6 - (pz[i] ?? 0) * 0.4);
        let bright = 0.45 + depth * 0.5;
        let size = node.size * (ps[i] ?? 1) * 3.4;
        if (node.kind === "core") {
          const pulse = st === "speaking" ? outLvl : st === "listening" ? inLvl : st === "thinking" ? 0.35 + 0.15 * Math.sin(t * 5) : 0.15 + 0.05 * Math.sin(t * 1.3);
          size = 26 + pulse * (st === "speaking" ? 70 : 46);
          bright = 0.8 + pulse * 0.2;
        } else if (st === "listening" && node.kind !== "tool") {
          // Sektor → Mikro-Band: die Seite, deren Frequenzen gerade klingen, leuchtet.
          const sector = Math.floor(((Math.atan2(node.y, node.x) + Math.PI) / (2 * Math.PI)) * drive.bands.length) % drive.bands.length;
          bright += (drive.bands[sector] ?? 0) * 0.9 + inLvl * 0.3;
        } else if (st === "speaking") {
          const dist = Math.hypot((px[i] ?? 0) - cx, (py[i] ?? 0) - cy) / R;
          bright += outLvl * 0.6 * clamp01(1.2 - dist) + 0.15 * Math.sin(t * 6 - dist * 5) * outLvl;
        } else if (st === "idle") {
          bright += 0.08 * Math.sin(t * 0.9 + i);
        }
        if (i === toolIdx) {
          size = 16 + 10 * toolGlow + 3 * Math.sin(t * 8);
          bright = 1;
        } else if (targets.has(i)) {
          size *= 1.8;
          bright = Math.max(bright, 0.9);
        }
        ctx.globalAlpha = clamp01(bright);
        ctx.drawImage(sprite(node.color), (px[i] ?? 0) - size / 2, (py[i] ?? 0) - size / 2, size, size);
        if (node.kind !== "core" && size > 3) {
          ctx.globalAlpha = clamp01(bright * 0.9);
          ctx.fillStyle = node.color;
          ctx.beginPath();
          ctx.arc(px[i] ?? 0, py[i] ?? 0, Math.max(0.8, size * 0.12), 0, Math.PI * 2);
          ctx.fill();
        }
        if (node.kind !== "core" && node.kind !== "neuron" && node.kind !== "synapse") proj.push({ x: px[i] ?? 0, y: py[i] ?? 0, r: Math.max(6, size * 0.35), i });
      }
      ctx.globalAlpha = 1;
      projected.current = proj;

      // Namen: aktives Werkzeug + hervorgehobener Knoten
      ctx.globalCompositeOperation = "source-over";
      const label = (i: number, text: string, color: string) => {
        if (i < 0 || !text) return;
        ctx.font = "600 13px 'IBM Plex Sans', sans-serif";
        const tw = ctx.measureText(text).width;
        const x = Math.min(w - tw - 20, Math.max(8, (px[i] ?? 0) + 14));
        const y = Math.max(20, (py[i] ?? 0) - 14);
        ctx.fillStyle = "rgba(10,10,10,0.88)";
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x - 8, y - 15, tw + 16, 22, 6);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#f3f3ef";
        ctx.fillText(text, x, y);
      };
      if (toolIdx >= 0 && toolGlow > 0.05) label(toolIdx, nodeText(m.nodes[toolIdx]), STATE_COLOR.tool);
      if (hlIdx >= 0) label(hlIdx, nodeText(m.nodes[hlIdx]), m.nodes[hlIdx]?.color ?? STATE_COLOR.speaking);
    };
    frame();

    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [drive]);

  const nodeAt = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: { d: number; i: number } | null = null;
    for (const p of projected.current) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= p.r && (!best || d < best.d)) best = { d, i: p.i };
    }
    return best ? { x, y, node: model.nodes[best.i] as NetNode } : null;
  };

  return (
    <div
      ref={wrapRef}
      data-nyx="nyx-netz"
      data-state={state}
      data-tool={tool ?? ""}
      role="img"
      aria-label={`${STATE_LABEL[state]}${tool ? ` (${nyxToolDoing(tool)})` : ""} – ${t("Netz aus {n} Knoten", { n: model.nodes.length })}`}
      className={`relative h-full w-full overflow-hidden ${className ?? ""}`}
      onMouseMove={(e) => setHover(nodeAt(e.clientX, e.clientY))}
      onMouseLeave={() => setHover(null)}
      onClick={(e) => {
        const hit = nodeAt(e.clientX, e.clientY);
        if (hit?.node.href) onOpen?.(hit.node.href);
      }}
      style={{ cursor: hover?.node.href ? "pointer" : "default" }}
    >
      <canvas ref={canvasRef} className="absolute inset-0" />
      {hover && hover.node.label && (
        <div
          className="pointer-events-none absolute z-10 max-w-[280px] rounded-md border border-a-line bg-a-p2/95 px-2 py-1 text-caption text-a-ink shadow-lg"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: hover.node.color }} />
          {nodeText(hover.node)}
          {hover.node.href && <span className="ml-1.5 text-a-mut">· {t("Klick öffnet")}</span>}
        </div>
      )}
    </div>
  );
}
