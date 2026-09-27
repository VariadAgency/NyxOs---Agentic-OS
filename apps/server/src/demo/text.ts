// Demo mode: every invented text exists in German and English. The seeder picks one language once
// (the app language at seed time), so the demo reads like a real workspace in that language.
import type { Lang } from "@nyxos/shared";

/** A text in both app languages. */
export interface L {
  de: string;
  en: string;
}

export const l = (de: string, en: string): L => ({ de, en });

export function pick(text: L, lang: Lang): string {
  return text[lang];
}

/** Minutes/hours/days before `now` as an ISO timestamp. */
export function ago(now: number, minutes: number): string {
  return new Date(now - minutes * 60_000).toISOString();
}

export const MIN = 1;
export const HOUR = 60;
export const DAY = 24 * 60;

/** Calendar day (`YYYY-MM-DD`, UTC) `days` days before `now`. */
export function dayString(now: number, days = 0): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Small deterministic pseudo random generator (mulberry32). The demo must look the same on every
 * run and in tests, so nothing uses `Math.random`.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Stable 32-bit hash of a string (FNV-1a), used to derive ids and seeds. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic hex string of the wanted length derived from `seed`. */
export function hex(seed: string, length: number): string {
  let out = "";
  let i = 0;
  while (out.length < length) out += hash32(`${seed}#${i++}`).toString(16).padStart(8, "0");
  return out.slice(0, length);
}

/** Deterministic UUID (v4 layout) derived from `seed`. */
export function uuid(seed: string): string {
  const h = hex(seed, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
