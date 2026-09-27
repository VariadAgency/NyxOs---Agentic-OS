// Wo der Finder seinen Zustand (`root`, `p`, `sel`, `open`, `q`, `smart`) hält.
// - Dateien-Tab: in der Adresse (Browser-Zurück geht, Links lassen sich teilen) — `useUrlNav`.
// - Server-Seite: der Finder ist nur eine Sektion der Seite — eigener Verlauf im Speicher, `useMemoryNav`.
import { useCallback, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { finderHref } from "./api";

export interface FinderNav {
  params: URLSearchParams;
  set: (next: URLSearchParams, opts?: { replace?: boolean; state?: unknown }) => void;
  /** Zusatz zum aktuellen Verlaufseintrag (z. B. „vom Finder geöffnet“). */
  state: unknown;
  back: () => void;
  forward: () => void;
  canBack: boolean | null;
  canForward: boolean | null;
  /** Adresse eines Orts (nur, wenn der Zustand in der Adresse steht). */
  rootHref: ((root: string) => string) | null;
}

export function useUrlNav(): FinderNav {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  return useMemo(
    () => ({
      params,
      set: (next, opts = {}) => setParams(next, { replace: opts.replace, state: opts.state }),
      state: location.state as unknown,
      back: () => void navigate(-1),
      forward: () => void navigate(1),
      canBack: null,
      canForward: null,
      rootHref: (root: string) => finderHref(root, { dir: "" }),
    }),
    [params, setParams, navigate, location.state],
  );
}

interface Stack {
  items: Array<{ params: string; state: unknown }>;
  index: number;
}

export function useMemoryNav(initial: Record<string, string> = {}): FinderNav {
  const [stack, setStack] = useState<Stack>(() => ({ items: [{ params: new URLSearchParams(initial).toString(), state: null }], index: 0 }));
  const current = stack.items[stack.index] ?? { params: "", state: null };
  const params = useMemo(() => new URLSearchParams(current.params), [current.params]);
  const set = useCallback((next: URLSearchParams, opts: { replace?: boolean; state?: unknown } = {}) => {
    setStack((s) => {
      const item = { params: next.toString(), state: opts.state ?? null };
      if (opts.replace) return { items: s.items.map((it, i) => (i === s.index ? item : it)), index: s.index };
      const items = [...s.items.slice(0, s.index + 1), item].slice(-100);
      return { items, index: items.length - 1 };
    });
  }, []);
  const back = useCallback(() => setStack((s) => ({ ...s, index: Math.max(0, s.index - 1) })), []);
  const forward = useCallback(() => setStack((s) => ({ ...s, index: Math.min(s.items.length - 1, s.index + 1) })), []);
  return useMemo(
    () => ({ params, set, state: current.state, back, forward, canBack: stack.index > 0, canForward: stack.index < stack.items.length - 1, rootHref: null }),
    [params, set, current.state, back, forward, stack.index, stack.items.length],
  );
}
