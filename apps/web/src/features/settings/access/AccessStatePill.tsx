// Zustand eines Zugangs als Pille (verbunden ✓ / fehlt / Fehler …).
import { t, type AccessState } from "@nyxos/shared";
import { cn } from "../../../lib/cn";

const STATE_LOOK: Record<AccessState, { text: string; cls: string; dot: string }> = {
  ok: { text: t("verbunden ✓"), cls: "border-a-ok/40 bg-a-ok/10 text-a-ok", dot: "bg-a-ok" },
  missing: { text: t("fehlt"), cls: "border-a-line text-a-mut", dot: "bg-a-dim" },
  error: { text: t("Fehler"), cls: "border-a-bad/40 bg-a-bad/10 text-a-bad", dot: "bg-a-bad" },
  unchecked: { text: t("gespeichert · nicht geprüft"), cls: "border-a-wait/40 bg-a-wait/10 text-a-wait", dot: "bg-a-wait" },
  link: { text: t("an anderer Stelle"), cls: "border-a-line text-a-mut", dot: "bg-a-idle" },
};

export function StatePill({ state }: { state: AccessState }) {
  const look = STATE_LOOK[state];
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-label font-medium", look.cls)} data-state={state}>
      <span className={cn("h-1.5 w-1.5 rounded-full", look.dot)} />
      {look.text}
    </span>
  );
}
