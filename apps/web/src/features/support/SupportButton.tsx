// Entry to "Feedback & Unterstützen": status line (under "Alle Verbindungen ansehen"), the connections page and the
// bottom of the settings. Quiet on purpose — a small heart and one line.
import { t } from "@nyxos/shared";
import { cn } from "../../lib/cn";
import { openSupport, type SupportTab } from "./openSupport";
import { HeartIcon } from "./parts";

export function SupportButton({ className, tab = "bug", variant = "line" }: { className?: string; tab?: SupportTab; variant?: "line" | "card" }) {
  if (variant === "card") {
    return (
      <button
        type="button"
        data-nyx="support-open"
        onClick={() => openSupport(tab)}
        className={cn(
          "flex min-h-11 w-full items-center gap-3 rounded-xl border border-a-line bg-a-p px-4 py-3 text-left transition-colors duration-150 hover:border-a-line-strong hover:bg-a-p2 focus-visible:outline-2 focus-visible:outline-a-acc",
          className,
        )}
      >
        <HeartIcon className="h-4 w-4 text-a-conf" />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="text-callout font-medium text-a-ink">{t("Feedback & Unterstützen")}</span>
          <span className="text-caption text-a-mut">{t("Fehler melden, Idee schicken oder das Projekt mit Tokens unterstützen.")}</span>
        </span>
        <span aria-hidden="true" className="text-a-mut">
          ›
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      data-nyx="support-open"
      onClick={() => openSupport(tab)}
      className={cn("flex min-h-8 items-center gap-1.5 text-left text-a-mut transition-colors hover:text-a-ink max-md:min-h-11", className)}
    >
      <HeartIcon className="text-a-conf" />
      {t("Feedback & Unterstützen")}
    </button>
  );
}
