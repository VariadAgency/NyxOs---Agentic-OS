// Form der NyxOS-Karte (erzeugt von scripts/nyxos-map.mjs → nyxosMap.generated.ts).

export interface NyxosMapNav {
  id: string;
  label: string;
  path: string;
  purpose: string;
  /** Englischer Name (aus dem Wörterbuch), falls vorhanden. */
  en?: string;
}

export interface NyxosMapTab {
  /** Anker auf der Seite (`#<anchor>`). */
  anchor: string;
  title: string;
  advanced?: boolean;
  keywords: string[];
}

export interface NyxosMapPage {
  path: string;
  title: string;
  purpose: string;
  keywords: string[];
  /** Leisten-Eintrag, unter dem die Seite liegt. */
  nav: string | null;
  /** data-nyx-Kennungen, die man der Reihe nach anklickt (ab der Leiste); `<…>` = Wert aus dem Pfad. */
  clickPath: string[];
  /** Abschnitte der Seite (Einstellungen: Panels). */
  tabs?: NyxosMapTab[];
  /** Stellen innerhalb eines Abschnitts (Stichwort → Anker). */
  spots?: { anchor: string; keywords: string[] }[];
  /** Steuerbare Elemente der Seite (data-nyx; `item:<art>` = Listeneinträge). */
  ids: string[];
  /** API-Wege, die die Seite aufruft. */
  api: string[];
  /** Englische Namen/Texte der Seite (aus dem Wörterbuch) – die Karte findet auch auf Englisch. */
  en?: string;
}

export interface NyxosMapTable {
  name: string;
  description: string;
  columns: { name: string; note?: string }[];
}

export interface NyxosMapData {
  nav: NyxosMapNav[];
  pages: NyxosMapPage[];
  /** Kennungen, die auf jeder Seite da sind (Leiste, Handy-Leiste, Kopfzeile). */
  globalIds: string[];
  api: { method: string; path: string; purpose: string }[];
  tables: NyxosMapTable[];
}
