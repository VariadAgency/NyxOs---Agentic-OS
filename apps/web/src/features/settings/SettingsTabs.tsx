// Reiter über den Einstellungen – „Allgemein“ (die bisherige Seite) und „Nyx“ (Persönlichkeit + Profil).
import { t } from "@nyxos/shared";
import { NavLink } from "react-router";
import { cn } from "../../lib/cn";

const TABS = [
  { to: "/settings", label: t("Allgemein") },
  { to: "/einstellungen/nyx", label: "Nyx" },
  // Info & Hilfe: Version, Updates, Sprache, Hilfe, Onboarding erneut starten (features/settings/info/).
  { to: "/einstellungen/info", label: t("Info & Hilfe") },
] as const;

export function SettingsTabs() {
  return (
    <nav aria-label={t("Einstellungen")} className="flex w-fit gap-1 rounded-xl border border-a-line bg-a-p p-1">
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end
          className={({ isActive }) =>
            cn("flex items-center rounded-lg px-3.5 py-1.5 text-callout transition-colors duration-150 max-md:min-h-11 max-md:px-5 pointer-coarse:min-h-11", isActive ? "bg-a-p3 font-medium text-a-ink shadow-card" : "text-a-mut hover:text-a-ink")
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
