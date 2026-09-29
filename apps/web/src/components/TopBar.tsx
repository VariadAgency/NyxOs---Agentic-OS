import { t } from "@nyxos/shared";
import { useAppInfo } from "../hooks/useAppInfo";
import { Breadcrumbs } from "./Breadcrumbs";
import { TopBarSlotTarget } from "./TopBarSlot";
import { Button } from "./ui/button";
import { HAIKU_SLOT_ID } from "../features/haiku/slot";
import { toggleNavDrawer, useNavDrawerOpen } from "../lib/navDrawer";
import { SIDEBAR_ID } from "./Sidebar";

/**
 * Kopfleiste: Brotkrümel, Nyx-Leiste, seitenbezogene Knöpfe (`TopBarSlot`).
 *
 * Der Knopf „⤢ Vollbild“ ist weg: Er stand auf jeder Seite, machte die
 * Kopfleiste der Sessions übervoll, und Safari auf dem iPhone kann gar kein Vollbild. Vollbild gibt es jetzt
 * über ⌘K („Vollbild“) und die Taste F (`App.tsx`); der Nyx-Tab hat seinen eigenen Fokus-Modus.
 *
 * Doppelte Sucheinstiege: vorher stand hier zusätzlich ein sichtbarer
 * „Suchen ⌘K"-Knopf, der dieselbe Befehlspalette öffnete wie die ART-Zeilen-eigene Suche
 * (`SearchBox.tsx`) — beide gleichzeitig sichtbar. Entscheidung: die ART-Zeile bleibt der EINE
 * sichtbare Such-Einstieg (sie zeigt schon Ergebnisse+Snippet direkt beim Tippen, ohne Dialog, und
 * jeder Screen bekommt ohnehin sein eigenes lokales Suchfeld — Aufgaben/Ideen
 * haben je ein `.tbar`-Suchfeld, kein globales). Die Befehlspalette selbst bleibt per ⌘K/Strg+K
 * erreichbar (Tastenkürzel läuft global in `CommandPalette`, unabhängig von einem sichtbaren Knopf)
 * — der Hinweis „⌘K" steht dafür jetzt in der ART-Zeilen-Suche.
 */
export function TopBar() {
  const navOpen = useNavDrawerOpen();
  const demo = useAppInfo().data?.demo === true;

  // EINE Kopfzeile. Links der Brotkrümel (kürzt sich zuerst), rechts die Knöpfe der Seite
  // (`TopBarActions`, z. B. Suche/Regeln/Filter der Sessions) — alle gleich hoch
  // (`--a-ctl-h`). `@container`: bei schmaler Leiste klappen Beschriftungen zu Symbolen ein;
  // reicht es trotzdem nicht, bricht die rechte Gruppe als Ganzes in eine zweite Zeile um.
  return (
    <div data-testid="topbar" className="@container flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-a-line bg-a-bg py-2 pl-3 pr-4 md:pl-4">
      {/* Unter 768 px ist die Seitenleiste ein Menü – dieser Knopf öffnet es (Esc/Hintergrund schließt). */}
      <Button
        variant="ghost"
        onClick={toggleNavDrawer}
        aria-label={t("Menü öffnen")}
        aria-expanded={navOpen}
        aria-controls={SIDEBAR_ID}
        data-nyx="menue"
        className="h-(--a-ctl-h) w-(--a-ctl-h) shrink-0 p-0 text-title2 text-a-ink md:hidden"
      >
        <span aria-hidden="true">☰</span>
      </Button>
      {/* Der Brotkrümel reserviert 250 px (Session-Titel ≥ 200 px neben „… /“) und ist ein eigener
          Container — darunter klappen Art/Baustelle in „…“ ein (`Breadcrumbs`). */}
      <div className="@container/crumbs flex min-w-0 grow basis-[250px] items-center max-md:basis-[120px]">
        <Breadcrumbs />
        {demo && (
          <span title={t("Demo mit erfundenen Beispieldaten")} className="ml-2 shrink-0 rounded-full border border-a-wait/40 bg-a-wait/10 px-2 py-0.5 font-mono text-label font-medium tracking-wider text-a-wait">
            DEMO
          </span>
        )}
      </div>
      {/* Hier lebt Nyx (Nyx-Leiste: Klick = Zentrum, gedrückt halten = sprechen).
          Platz für Haikus Befehlsleiste (HaikuRoot hängt sie hier ein) – verdeckt so nie Inhalt.
          Die Leiste wächst mit dem freien Platz bis 360 px. Sie beginnt bei
          84 px („H bereit“) und schrumpft nie darunter – bei 1024–1440 px bekam der Brotkrümel sonst nur 160–245 px
          („Codi… / Zentr… / Softw…“). Freier Platz wird gleich verteilt; die Leiste zeigt je Breite mehr
          („Haiku · bereit“, ab 200 px mit ⌘J, ab 230 px „Haiku fragen …“). */}
      <div id={HAIKU_SLOT_ID} data-testid="topbar-haiku" className="flex min-w-0 max-w-[360px] shrink-0 grow basis-[84px] empty:hidden" />
      <TopBarSlotTarget className="ml-auto flex min-w-0 items-center gap-2 empty:hidden" />
    </div>
  );
}
