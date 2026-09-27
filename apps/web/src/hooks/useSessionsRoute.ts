import { useNavigate, useParams, useSearchParams } from "react-router";

export type ToolFilter = "alle" | "claude" | "codex";

export interface SessionsRoute {
  art: string | null;
  baustelle: string | null;
  id: string | null;
  tool: ToolFilter;
  at: number | null;
  goTo: (art: string, baustelle: string | null, id?: string | null, opts?: { at?: number | null }) => void;
  setTool: (tool: ToolFilter) => void;
}

const NONE = "_";
/**
 * Eigenes URL-Segment für „explizit ohne Baustelle": vorher zeigten
 * `baustelle: null` sowohl „Alle" (kein Filter) als auch „Ohne Baustelle" (Filter auf Sessions ohne
 * Baustelle) an — beide BAUSTELLE-Tabs waren dadurch gleichzeitig `aria-selected`. Jetzt ist `null`
 * ausschließlich „Alle"; `route.baustelle === BAUSTELLE_OHNE` ist der explizit gewählte Filter.
 */
const OHNE = "_ohne";

/**
 * Liest/schreibt die Sessions-URL (`/sessions/:art/:baustelle/:id`, `?tool=`, `?at=`) — einzige
 * Quelle der Wahrheit für die drei Tab-Zeilen. `baustelle "_"` = Alle, `"_ohne"` =
 * explizit ohne Baustelle, sonst der Baustelle-Slug.
 */
export function useSessionsRoute(): SessionsRoute {
  const params = useParams<{ art?: string; baustelle?: string; id?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const toolRaw = searchParams.get("tool");
  const tool: ToolFilter = toolRaw === "claude" || toolRaw === "codex" ? toolRaw : "alle";
  const atRaw = searchParams.get("at");
  const at = atRaw !== null && /^\d+$/.test(atRaw) ? Number(atRaw) : null;

  const goTo = (art: string, baustelle: string | null, id?: string | null, opts?: { at?: number | null }) => {
    const parts = [`/sessions`, art, baustelle ?? NONE];
    if (id) parts.push(id);
    let path = parts.join("/");
    const qs = new URLSearchParams();
    if (tool !== "alle") qs.set("tool", tool);
    if (opts?.at !== undefined && opts.at !== null) qs.set("at", String(opts.at));
    const qsStr = qs.toString();
    if (qsStr) path += `?${qsStr}`;
    navigate(path);
  };

  const setTool = (next: ToolFilter) => {
    const qs = new URLSearchParams(searchParams);
    if (next === "alle") qs.delete("tool");
    else qs.set("tool", next);
    setSearchParams(qs, { replace: true });
  };

  return {
    art: params.art ?? null,
    baustelle: params.baustelle && params.baustelle !== NONE ? params.baustelle : null,
    id: params.id ?? null,
    tool,
    at,
    goTo,
    setTool,
  };
}

export { NONE as BAUSTELLE_NONE, OHNE as BAUSTELLE_OHNE };
