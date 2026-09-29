// Minimale Typen für d3-force-3d (MIT, ohne eigene Typen) — nur, was `sim3d.ts` nutzt.
declare module "d3-force-3d" {
  export interface Node3 {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }
  export interface Link3<N extends Node3> {
    source: N | number | string;
    target: N | number | string;
  }
  type Acc<N, T> = number | ((d: N, i: number, all: N[]) => T);
  export interface Force<N extends Node3> {
    (alpha: number): void;
    initialize?(nodes: N[], ...args: unknown[]): void;
  }
  export interface Simulation<N extends Node3> {
    tick(iterations?: number): this;
    stop(): this;
    alpha(): number;
    alpha(a: number): this;
    alphaMin(): number;
    alphaMin(a: number): this;
    alphaDecay(a: number): this;
    alphaTarget(): number;
    alphaTarget(a: number): this;
    velocityDecay(a: number): this;
    force(name: string): Force<N> | undefined;
    force(name: string, f: Force<N> | null): this;
    nodes(): N[];
  }
  export function forceSimulation<N extends Node3>(nodes?: N[], numDimensions?: 1 | 2 | 3): Simulation<N>;
  export interface ManyBody<N extends Node3> extends Force<N> {
    strength(s: Acc<N, number>): this;
    theta(t: number): this;
    distanceMax(d: number): this;
  }
  export function forceManyBody<N extends Node3>(): ManyBody<N>;
  export interface LinkForce<N extends Node3, L extends Link3<N>> extends Force<N> {
    links(): L[];
    distance(d: number | ((l: L) => number)): this;
    strength(s: number | ((l: L) => number)): this;
  }
  export function forceLink<N extends Node3, L extends Link3<N>>(links?: L[]): LinkForce<N, L>;
  export interface PositionForce<N extends Node3> extends Force<N> {
    strength(s: Acc<N, number>): this;
  }
  export function forceX<N extends Node3>(x?: number): PositionForce<N>;
  export function forceY<N extends Node3>(y?: number): PositionForce<N>;
  export function forceZ<N extends Node3>(z?: number): PositionForce<N>;
  export interface RadialForce<N extends Node3> extends PositionForce<N> {
    radius(r: Acc<N, number>): this;
  }
  export function forceRadial<N extends Node3>(radius: Acc<N, number>, x?: number, y?: number, z?: number): RadialForce<N>;
}
