import { t } from "@nyxos/shared";
import { useEffect } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { InboxNavBadge } from "../features/inbox/InboxNavBadge";
import { NyxAura } from "./brand/NyxAura";
import { NAV_GROUPS, navLabel } from "../nav";
import { useAppInfo } from "../hooks/useAppInfo";
import { ConnectionStatus } from "./ConnectionStatus";
import { FocusControl } from "../features/focus/FocusControl";
import { cn } from "../lib/cn";
import { closeNavDrawer, useNavDrawerOpen } from "../lib/navDrawer";
import { NAV_TONE, toneVar } from "../lib/tones";

/** Id der Leiste, damit der Menü-Knopf der Kopfzeile sie per `aria-controls` benennen kann. */
export const SIDEBAR_ID = "app-sidebar";

export function Sidebar() {
  // Unter 768 px ist die Leiste ein Menü, das von links hereingleitet („Mehr“ in der unteren Leiste);
  // der Inhalt nutzt die volle Breite. Ab 768 px steht sie fest wie bisher.
  const open = useNavDrawerOpen();
  const { pathname } = useLocation();
  const local = useAppInfo().data?.mode === "local";
  useEffect(() => closeNavDrawer(), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeNavDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
    {open && <div data-testid="nav-backdrop" aria-hidden="true" onClick={closeNavDrawer} className="fixed inset-0 z-40 bg-black/45 backdrop-blur-[2px] motion-safe:animate-[cc-tab-fade_200ms_ease-out] md:hidden" />}
    <aside
      id={SIDEBAR_ID}
      data-testid="sidebar"
      role="navigation"
      aria-label={t("Hauptmenü")}
      data-open={open ? "true" : "false"}
      className={cn(
        "cc-scroll flex h-full w-[208px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-a-line bg-a-p p-2.5",
        "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:w-[min(280px,86vw)] max-md:shadow-pop",
        // Statusleiste/Notch/Home-Leiste freihalten (viewport-fit=cover).
        "max-md:pt-[max(10px,env(safe-area-inset-top))] max-md:pb-[max(10px,env(safe-area-inset-bottom))] max-md:pl-[max(10px,env(safe-area-inset-left))]",
        "transition-[transform,visibility] duration-250 ease-[cubic-bezier(.2,.8,.2,1)]",
        open ? "max-md:translate-x-0" : "max-md:invisible max-md:-translate-x-full",
      )}
    >
      {/* Das Logo führt zum Überblick (Startseite) — ein echter Link, per Tastatur erreichbar. */}
      <Link
        to="/overview"
        aria-label={t("NyxOS – zum Überblick")}
        title={t("Zum Überblick")}
        className="mb-2.5 flex items-center gap-2.5 rounded-lg px-2.5 pb-1.5 pt-1.5 font-display text-callout font-semibold tracking-[0.2em] text-a-ink transition-colors duration-150 hover:bg-a-p2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-a-acc"
      >
        {/* Wortmarke „NYX OS“ in Großbuchstaben mit etwas Laufweite; die Marke ist die lebendige lila Aura aus dem Nyx-Tab. */}
        <NyxAura size={24} className="-my-1 -ml-1" />
        NYX OS
      </Link>

      {NAV_GROUPS.map((group, groupIndex) => (
        <div
          key={group.map((item) => item.id).join("-")}
          className={cn("grid gap-0.5", groupIndex > 0 && "mt-2.5 border-t border-a-line pt-2.5")}
        >
          {group.map((item) =>
            item.status === "active" ? (
              <NavLink
                key={item.id}
                to={item.path}
                data-nyx={`nav:${item.id}`}
                onClick={closeNavDrawer}
                className={({ isActive }) =>
                  cn(
                    "group/nav flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-callout text-a-ink/80 transition-colors duration-150 hover:bg-a-p2 hover:text-a-ink max-md:py-2.5 max-md:text-headline",
                    // Aktive Zeile neutral hell wie in macOS (Bedienfläche + weißer Text) statt Türkis-Schleier;
                    // die Farbe steckt im Symbol jedes Bereichs (wie iOS-Einstellungen, nur ohne Kästchen).
                    isActive && "bg-a-p3 font-semibold text-a-ink hover:bg-a-p3",
                  )
                }
              >
                {item.id === "nyx" ? (
                  <span aria-hidden="true" className="grid w-4 place-items-center">
                    <NyxAura size={18} />
                  </span>
                ) : (
                  <span aria-hidden="true" data-tone={NAV_TONE[item.id] ?? "mut"} className="w-4 text-center text-callout leading-none" style={{ color: toneVar(NAV_TONE[item.id] ?? "mut") }}>
                    {item.icon}
                  </span>
                )}
                {navLabel(item, local)}
                {item.badge === "inbox" && <InboxNavBadge />}
              </NavLink>
            ) : (
              <div
                key={item.id}
                aria-disabled="true"
                title={`${item.label}: ${item.hint}`}
                className="flex w-full cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-callout text-a-mut opacity-45"
              >
                <span aria-hidden="true" className="w-4 text-center font-mono text-caption opacity-90">
                  {item.icon}
                </span>
                {item.label}
              </div>
            ),
          )}
        </div>
      ))}

      {/* Focus button above the connection status line (on the phone at the bottom of the "More" drawer). The wrapper
          carries `mt-auto` so both sit together at the bottom. */}
      <div className="mt-auto grid gap-1 pt-1">
        <FocusControl />
        <ConnectionStatus />
      </div>
    </aside>
    </>
  );
}
