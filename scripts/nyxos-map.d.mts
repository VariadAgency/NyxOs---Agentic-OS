// Typen für scripts/nyxos-map.mjs (Tests importieren den Generator direkt).
import type { NyxosMapData } from "../apps/server/src/nyx/map/types.js";

export declare const REPO_ROOT: string;
export declare const MAP_OUT: string;
export declare function buildNyxosMap(root?: string): NyxosMapData & { problems: string[] };
export declare function renderNyxosMap(map: NyxosMapData & { problems: string[] }): string;
