import { t } from "@nyxos/shared";
import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router";
import { useOpenQuestions } from "../features/inbox/useInbox";
import { cn } from "../lib/cn";
import { toggleNavDrawer, useNavDrawerOpen } from "../lib/navDrawer";
import { NAV_TONE, toneVar } from "../lib/tones";
import { NyxAura } from "./brand/NyxAura";
import { SIDEBAR_ID } from "./Sidebar";

/**
 * Untere Leiste auf dem Handy (unter 768 px) wie in iOS-Apps – die vier Wege, die man unterwegs am häufigsten
 * braucht, plus „Mehr“ (öffnet die bestehende Schublade mit allen Bereichen). Ab 768 px (iPad, Rechner)
 * steht die Seitenleiste fest; die Leiste ist dort ausgeblendet. Beim Tippen (Handy-Tastatur offen) blendet sie
 * sich aus (`cc-kb-hide`), damit Eingabe und Terminal den Platz bekommen.
 */
interface TabItem {
  id: string;
  to: string;
  label: string;
  icon: ReactNode;
}

const TABS: TabItem[] = [
  { id: "nyx", to: "/nyx", label: "Nyx", icon: <NyxAura size={22} /> },
  { id: "ses", to: "/sessions", label: t("Sessions"), icon: "▣" },
  { id: "inbox", to: "/inbox", label: t("Entscheidungen"), icon: "⚖" },
  { id: "dash", to: "/overview", label: t("Überblick"), icon: "◉" },
];

const ITEM =
  "relative flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-0.5 pt-1.5 pb-1 text-label font-medium transition-colors duration-150 [-webkit-tap-highlight-color:transparent] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-a-acc";

function InboxCount() {
  const total = useOpenQuestions().data?.total ?? 0;
  if (total <= 0) return null;
  return (
    <span
      data-testid="tabbar-badge"
      aria-label={t("{n} offen", { n: total })}
      className="absolute top-0.5 left-[calc(50%+6px)] min-w-[18px] rounded-full bg-a-wait px-1 text-center font-mono text-label leading-[18px] font-semibold tabular-nums text-a-on-primary"
    >
      {total > 99 ? "99+" : total}
    </span>
  );
}

export function MobileTabBar() {
  const { pathname } = useLocation();
  const drawerOpen = useNavDrawerOpen();
  const elsewhere = !TABS.some((tab) => pathname === tab.to || pathname.startsWith(`${tab.to}/`));

  return (
    <nav
      aria-label={t("Schnellzugriff")}
      data-testid="mobile-tabbar"
      className="cc-kb-hide flex shrink-0 items-stretch gap-0.5 border-t border-a-line bg-a-p px-1.5 pt-1 pb-[max(4px,env(safe-area-inset-bottom))] md:hidden"
    >
      {TABS.map((tab) => (
        <NavLink
          key={tab.id}
          to={tab.to}
          data-nyx={`tabbar:${tab.id}`}
          // „Entscheidungen“ ist das längste Wort – etwas mehr Breite, damit es nicht abgeschnitten wird.
          className={({ isActive }) => cn(ITEM, tab.id === "inbox" && "flex-[1.45]", isActive ? "text-a-ink" : "text-a-mut active:bg-a-p2")}
        >
          {({ isActive }) => (
            <>
              <span aria-hidden="true" className={cn("grid h-6 place-items-center text-title2 leading-none", !isActive && tab.id !== "nyx" && "opacity-80")} style={tab.id === "nyx" ? undefined : { color: isActive ? toneVar(NAV_TONE[tab.id] ?? "mut") : undefined }}>
                {tab.icon}
              </span>
              <span className={cn("max-w-full truncate", isActive && "font-semibold")}>{tab.label}</span>
              {tab.id === "inbox" && <InboxCount />}
            </>
          )}
        </NavLink>
      ))}
      <button
        type="button"
        onClick={toggleNavDrawer}
        aria-expanded={drawerOpen}
        aria-controls={SIDEBAR_ID}
        data-active={elsewhere ? "true" : undefined}
        data-nyx="tabbar:mehr"
        className={cn(ITEM, elsewhere || drawerOpen ? "text-a-ink" : "text-a-mut active:bg-a-p2")}
      >
        <span aria-hidden="true" className="grid h-6 place-items-center text-title2 leading-none">
          ☰
        </span>
        <span className={cn(elsewhere && "font-semibold")}>{t("Mehr")}</span>
      </button>
    </nav>
  );
}
