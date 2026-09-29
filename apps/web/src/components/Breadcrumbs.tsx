import { t } from "@nyxos/shared";
import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { BAUSTELLE_NONE, BAUSTELLE_OHNE } from "../hooks/useSessionsRoute";
import { useCategories, useSessionDetail } from "../hooks/useSessionApi";
import { artLabel } from "../lib/arts";
import { cn } from "../lib/cn";
import { sessionLabel } from "../lib/sessionLabel";
import { NYX_SECTIONS } from "../features/settings/sections";
import { useAppInfo } from "../hooks/useAppInfo";
import { LOCAL_SEGMENT_LABELS, NAV_ITEMS } from "../nav";

// Regel: /sessions/:art?/:baustelle?/:id?
const SESSIONS_PATH = /^\/sessions(?:\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?)?\/?$/;

// Ein-Ebenen-Tabs zeigen ihren Namen in der Kopfleiste ("Großansicht" innerhalb dieser Tabs läuft über
// Karten/Anker, nicht über eigene Routen). Abgeleitet aus `nav.ts`, EINE Quelle der Wahrheit.
const TOP_LEVEL_LABELS: Record<string, string> = Object.fromEntries(
  NAV_ITEMS.filter((item): item is Extract<typeof item, { status: "active" }> => item.status === "active" && item.path !== "/sessions").map((item) => [item.path.slice(1), item.label]),
);

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function pretty(segment: string): string {
  if (segment === "_") return "–";
  if (segment === BAUSTELLE_OHNE) return t("Ohne Baustelle");
  return decodeURIComponent(segment);
}

// Seiten außerhalb von /sessions (Briefing, Entscheidungen, Einstellungen/…).
const PAGE_LABELS: Record<string, string> = {
  briefing: t("Briefing"),
  inbox: t("Entscheidungen"),
  einstellungen: t("Einstellungen"),
  haiku: "Nyx",
  "ideen-links": t("Ideen-Links"),
  nyx: "Nyx",
  // Nyx-Unterseiten (`/einstellungen/nyx/<id>`) mit ihrem Titel statt der Kennung.
  ...Object.fromEntries(NYX_SECTIONS.map((s) => [s.id, s.title])),
};

/** `/einstellungen` allein ist keine Seite – der Krümel führt zur Übersicht der Einstellungen. */
const CRUMB_TARGET: Record<string, string> = { "/einstellungen": "/settings" };

interface Crumb {
  label: string;
  to: string;
}

function otherCrumbs(pathname: string): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  return segments.map((seg, i) => {
    const to = `/${segments.slice(0, i + 1).join("/")}`;
    return { label: PAGE_LABELS[seg] ?? pretty(seg), to: CRUMB_TARGET[to] ?? to };
  });
}

/** Im Session-Vollbild zeigt der letzte Krümel den Namen statt der rohen ID — dieselbe
 * Query wie `SessionFullscreen` (`["session", id]`), also aus dem TanStack-Cache, keine eigene
 * zweite Anfrage. Der Name kommt aus `sessionLabel` (nie leer, nie eine UUID); solange er lädt,
 * steht „Session“ – nie die Kennung.
 * Der Titel steht ganz im Text; gekürzt wird sichtbar per Ellipse (CSS), voll im Tooltip. */
function useSessionTitle(id: string | null): string | null {
  const { data } = useSessionDetail(id);
  return data?.session ? sessionLabel(data.session) : null;
}

/**
 * Die Baustelle mit ihrem NAMEN („NyxOS“) statt der Kennung aus der URL („nyxos“).
 * Quelle: die Baustellen-Zeile (`/api/categories`, meist schon im Cache), sonst die Baustelle der offenen
 * Session. Erst wenn beides fehlt, die Kennung.
 */
function useBaustelleLabel(slug: string | null, sessionId: string | null): string | null {
  // Nur bei einer Baustelle in der URL abfragen (sonst keine zusätzliche Anfrage auf Briefing & Co.).
  const categories = useCategories("alle", slug !== null && slug !== BAUSTELLE_OHNE);
  const { data: detail } = useSessionDetail(sessionId);
  if (!slug) return null;
  if (slug === BAUSTELLE_OHNE) return t("Ohne Baustelle");
  for (const category of categories.data ?? []) {
    const hit = category.baustellen.find((b) => b.slug === slug);
    if (hit) return hit.label;
  }
  if (detail?.session.baustelle?.slug === slug) return detail.session.baustelle.label;
  return pretty(slug);
}

/**
 * Brotkrümel aus der URL. Liest bewusst über useLocation() statt useParams():
 * TopBar (und damit Breadcrumbs) liegt außerhalb von <Routes>, useParams() wäre dort immer leer.
 */
export function Breadcrumbs() {
  const location = useLocation();
  const topLevel = location.pathname.slice(1).split("/")[0] ?? "";
  const local = useAppInfo().data?.mode === "local";
  if (topLevel in TOP_LEVEL_LABELS) {
    return (
      <nav aria-label={t("Brotkrümel")} className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-caption text-a-mut">
        <span className="text-a-ink">{(local && LOCAL_SEGMENT_LABELS[topLevel]) || TOP_LEVEL_LABELS[topLevel]}</span>
      </nav>
    );
  }

  return <PathCrumbs pathname={location.pathname} />;
}

function PathCrumbs({ pathname }: { pathname: string }) {
  const match = SESSIONS_PATH.exec(pathname);
  const [, art, baustelle, id] = match ?? [];
  const sessionId = id ? safeDecode(id) : null;
  const baustelleSlug = baustelle && baustelle !== BAUSTELLE_NONE && art ? safeDecode(baustelle) : null;
  const baustelleLabel = useBaustelleLabel(baustelleSlug, sessionId);
  const sessionTitle = useSessionTitle(sessionId);

  const crumbs: Crumb[] = match ? [{ label: "Sessions", to: "/sessions" }] : otherCrumbs(pathname);
  // Leere Stufen („_“ = keine Art/„Alle“ Baustellen) fallen weg statt als „–“ zu stehen;
  // die Art steht mit ihrem Namen („Coding“), nicht als roher Schlüssel („coding“).
  if (art && art !== BAUSTELLE_NONE) crumbs.push({ label: artLabel(safeDecode(art)), to: `/sessions/${art}` });
  if (baustelleSlug && baustelleLabel) crumbs.push({ label: baustelleLabel, to: `/sessions/${art}/${baustelle}` });
  // Titel statt roher ID (`claude:00903b73-…`).
  // `location.pathname` ist URL-kodiert (`claude%3Aabc`, z. B. aus fremden Links) — dekodiert
  // abfragen, sonst kodiert `fetchSessionDetail` ein zweites Mal.
  if (sessionId) crumbs.push({ label: sessionTitle ?? "Session", to: "" });

  if (pathname.startsWith("/gehirn")) crumbs.splice(0, crumbs.length, { label: t("Gehirn"), to: "/gehirn" });
  const lastIndex = crumbs.length - 1;

  // Ab drei Ebenen klappen die vorderen bei wenig Platz in „…“ ein (Menü), damit der letzte
  // Krümel — meist der Session-Titel — lesbar bleibt. Umgeschaltet wird über die Breite der Brotkrümel-Spalte
  // (`@container/crumbs` in der TopBar), ohne JavaScript-Messung: breit = alles ausgeschrieben, schmal = „… / Titel“.
  const collapsible = crumbs.length >= 3;

  // Jeder Krümel kürzt sich selbst mit „…“ (CSS) und trägt den vollen Text als Tooltip —
  // vorher schnitt die Zeile hart ab. Der letzte (Session-Titel) bekommt den meisten Platz.
  return (
    <nav aria-label={t("Brotkrümel")} className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-caption text-a-mut">
      {collapsible && <CollapsedLevels crumbs={crumbs.slice(0, lastIndex)} />}
      <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
        {crumbs.map((crumb, index) => {
          const last = index === lastIndex;
          return (
            // Nur der letzte Krümel (meist der Session-Titel) gibt nach, bis auf ~6 Zeichen. Die vorderen sind fest
            // und höchstens 120 px breit (lange Namen mit „…“) — vorher schrumpften sie anteilig mit und zeigten
            // schon bei 1920 px „Sessio… / Codi…“. 3 × 120 px + Titel-Minimum passen immer unter
            // die Einklapp-Grenze, darunter übernimmt „…“.
            <span
              key={`crumb-${index}`}
              data-crumb-level={last ? undefined : index}
              className={cn("flex items-center gap-1.5", last ? "min-w-[5em] shrink" : "max-w-[120px] shrink-0", !last && collapsible && COLLAPSE_HIDE)}
            >
              {index > 0 && (
                <span aria-hidden="true" className="shrink-0">
                  /
                </span>
              )}
              {last ? (
                <span className="truncate text-a-ink" title={crumb.label} data-testid="crumb-title">
                  {crumb.label}
                </span>
              ) : (
                <Link to={crumb.to} className="truncate text-a-mut hover:text-a-ink pointer-coarse:block pointer-coarse:py-3.5" title={crumb.label}>
                  {crumb.label}
                </Link>
              )}
            </span>
          );
        })}
      </span>
    </nav>
  );
}

/** Unter dieser Breite der Brotkrümel-Spalte klappen die vorderen Ebenen ein (Titel behält ≥ 200 px). */
const COLLAPSE_HIDE = "@max-[480px]/crumbs:hidden";
const COLLAPSE_SHOW = "hidden @max-[480px]/crumbs:flex";

/** „…“ + Menü mit den eingeklappten Ebenen (Sessions → Art → Baustelle), eingerückt nach Tiefe. */
function CollapsedLevels({ crumbs }: { crumbs: Crumb[] }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={wrapRef} data-crumb-more="" className={cn("relative shrink-0 items-center", COLLAPSE_SHOW)}>
      <button
        type="button"
        aria-label={t("Weitere Ebenen")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={crumbs.map((c) => c.label).join(" / ")}
        onClick={() => setOpen((v) => !v)}
        className={cn("rounded px-1 leading-5 text-a-mut pointer-coarse:min-h-11 pointer-coarse:min-w-11 transition-colors duration-150 hover:bg-a-p2 hover:text-a-ink focus-visible:outline-2 focus-visible:outline-a-acc", open && "bg-a-p2 text-a-ink")}
      >
        …
      </button>
      {open && (
        <span id={menuId} role="menu" aria-label={t("Weitere Ebenen")} className="absolute top-full left-0 z-30 mt-1.5 grid min-w-44 gap-0.5 rounded-lg border border-a-line bg-a-p2 p-1.5 shadow-xl shadow-black/40">
          {crumbs.map((crumb, depth) => (
            <Link
              key={crumb.to}
              role="menuitem"
              to={crumb.to}
              onClick={() => setOpen(false)}
              style={{ paddingLeft: `${8 + depth * 12}px` }}
              className="flex items-center gap-1.5 rounded-md py-1.5 pr-2 text-caption text-a-ink hover:bg-a-p3 focus-visible:bg-a-p3 focus-visible:outline-none"
            >
              {depth > 0 && (
                <span aria-hidden="true" className="text-a-mut">
                  └
                </span>
              )}
              {crumb.label}
            </Link>
          ))}
        </span>
      )}
    </span>
  );
}
