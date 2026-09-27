// Hervorgehobene Kanten der Auswahl (bzw. des Knotens unter der Maus) im 3D-Gehirn.
// Früher: Bei einem Knoten mit ~300 Verbindungen bildeten
// alle hervorgehobenen Kanten einen hellen gelb-weißen Strahlenfächer über den halben Bildschirm – die Enden am
// gewählten Knoten trugen seine (zur Hervorhebung aufgehellte) Farbe. Jetzt:
//   • höchstens HI_MAX_EDGES Kanten hervorgehoben – die nächsten Nachbarn; die übrigen Kanten des Knotens
//     zeichnet die normale Kanten-Ebene (nicht hervorgehoben),
//   • Deckkraft sinkt bei vielen Kanten mit 1/√n (n = alle sichtbaren Kanten des Knotens),
//   • jede hervorgehobene Kante trägt an BEIDEN Enden die Farbe ihres Nachbarn, nie Weiß/Gelb.
// Die Nachbar-Knoten selbst bleiben voll hervorgehoben (scene3d.ts, applyLook).

/** Höchstens so viele hervorgehobene Kanten je Knoten. */
export const HI_MAX_EDGES = 60;
/** Bis so viele Kanten volle Deckkraft, darüber 1/√n … */
export const HI_CROWD_REF = 24;
/** … aber nie unter diesem Anteil (sonst ist die Auswahl nicht mehr zu sehen). */
export const HI_CROWD_MIN = 0.3;

export interface HighlightPlan {
  /** Fokus-Knoten je Kante (immer derselbe) und der Nachbar am anderen Ende. */
  from: Uint32Array;
  to: Uint32Array;
  /** Alle sichtbaren Kanten des Knotens (auch die nicht hervorgehobenen) – Grundlage für die Deckkraft. */
  total: number;
}

/** Die (höchstens `max`) nächsten sichtbaren Kanten des Knotens `focus`, nächste zuerst. */
export function planHighlight(o: {
  adj: number[][];
  linkS: Uint32Array;
  linkT: Uint32Array;
  hidden: Uint8Array;
  focus: number;
  /** Quadrat des Abstands zweier Knoten (kleiner = wichtiger). */
  dist2: (a: number, b: number) => number;
  max?: number;
}): HighlightPlan {
  const max = o.max ?? HI_MAX_EDGES;
  const cand: { b: number; d: number }[] = [];
  if (o.focus >= 0 && !o.hidden[o.focus]) {
    for (const e of o.adj[o.focus] ?? []) {
      const s = o.linkS[e] ?? 0;
      const t = o.linkT[e] ?? 0;
      const b = s === o.focus ? t : s;
      if (b === o.focus || o.hidden[b]) continue;
      cand.push({ b, d: 0 });
    }
  }
  const total = cand.length;
  if (total > max) {
    for (const c of cand) c.d = o.dist2(o.focus, c.b);
    cand.sort((x, y) => x.d - y.d);
    cand.length = max;
  }
  return { from: new Uint32Array(cand.length).fill(Math.max(0, o.focus)), to: Uint32Array.from(cand, (c) => c.b), total };
}

/** Anteil der vollen Hervorhebungs-Deckkraft bei `total` Kanten: 1 bis HI_CROWD_REF, dann 1/√n, nie unter HI_CROWD_MIN. */
export function highlightCrowdFactor(total: number): number {
  return Math.max(HI_CROWD_MIN, Math.min(1, Math.sqrt(HI_CROWD_REF / Math.max(1, total))));
}

/** Farben je Kanten-Ende (Linien-Segmente, 2 Ecken je Kante): beide Enden in der Farbe des Nachbarn. */
export function highlightColors(nodeRgb: Float32Array, to: Uint32Array, out: Float32Array = new Float32Array(to.length * 6)): Float32Array {
  for (let k = 0; k < to.length; k++) {
    const b = to[k] ?? 0;
    for (let c = 0; c < 3; c++) {
      const v = nodeRgb[b * 3 + c] ?? 1;
      out[k * 6 + c] = v;
      out[k * 6 + 3 + c] = v;
    }
  }
  return out;
}
