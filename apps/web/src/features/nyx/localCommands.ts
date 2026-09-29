// Schneller lokaler Pfad für einfache Sprachbefehle („öffne …“, „zeig …“, „zurück“ bzw. „open …“, „show …“, „back“).
// Nur eindeutige, kurze Befehle – alles andere geht ans Modell (die echte Intelligenz kommt von dort).
// Die Schritte laufen über denselben Ausführer wie `nyx.ui` vom Server, also mit sichtbarem Nyx-Cursor.
// Auch mehrstufig ohne Modell – „öffne die neueste Session/Entscheidung“, „öffne Aufgabe X“ (unscharf per Text),
// „such nach X“: erst der Eintrag in der Leiste, dann wartet der Ausführer auf die Liste und klickt `item:<art>…`.
// Erkannt werden deutsche UND englische Befehle (man spricht nicht immer in der Sprache der Oberfläche);
// die Antwort (`say`) folgt der eingestellten Sprache.
import { t, type NyxUiCommand } from "@nyxos/shared";

export interface LocalNavItem {
  id: string;
  label: string;
  path: string;
}

export type LocalPlan = { say: string; steps: NyxUiCommand[]; back?: false } | { say: string; steps: []; back: true };

/** Zusätzliche Namen, die man für einen Tab sagen könnte (Diktat, Umgangssprache; Deutsch und Englisch). */
const ALIASES: Record<string, string[]> = {
  dash: ["überblick", "übersicht", "start", "startseite", "dashboard", "overview", "home", "home page"],
  ses: ["sessions", "session", "sitzungen"],
  brain: ["gehirn", "graph", "brain"],
  task: ["aufgaben", "tasks", "to dos", "todos"],
  agent: ["agenten", "agenten und skills", "agents", "agents and skills"],
  // Skills haben einen eigenen Tab (vorher landete „öffne Skills“ bei den Agenten).
  skills: ["skills", "skill", "skill bibliothek", "skill-bibliothek", "skill library"],
  conf: ["konflikte", "conflicts"],
  use: ["nutzung", "verbrauch", "kosten", "usage", "costs"],
  idea: ["ideen", "ideas"],
  dateien: ["dateien", "files"],
  settings: ["einstellungen", "settings", "preferences"],
  inbox: ["entscheidungen", "inbox", "freigaben", "decisions", "approvals"],
  brief: ["briefing", "bericht", "report"],
  srv: ["server"],
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const VERB =
  /^(?:nyx )?(?:bitte |please )?(?:öffne|oeffne|zeig|zeige|geh zu|gehe zu|wechsel zu|wechsle zu|spring zu|mach|mache|open|show|go to|switch to|jump to|take me to) (?:mir |me )?(?:bitte |please )?/u;
const FILLER = /^(?:die|den|das|dem|der|zu|zum|zur|in|ins|auf|mal|bitte|tab|seite|mir|the|to|my|me|please|page)\s+/u;

const READ_ALOUD =
  /^(?:nyx )?(?:bitte |please )?(?:(?:lies|lese|lies du)(?: mir| uns)?(?: bitte)?(?: mal)? (?:das |den |mein |meinen )?(briefing|bericht|recap)(?: bitte)? vor|(briefing|recap) vorlesen|read(?: me| us)?(?: out)? (?:the |my )?(briefing|report|recap)(?: aloud| out loud| out)?|read (?:out|aloud) (?:the |my )?(briefing|report|recap))(?: bitte| please)?$/u;

function stripFillers(s: string): string {
  let r = s;
  for (let i = 0; i < 4; i++) r = r.replace(FILLER, "");
  return r.replace(/\s+(?:tab|seite|auf|bitte|page|please)$/u, "").trim();
}

/** Plant einen Befehl lokal – oder `null`, wenn er ans Modell gehen soll. */
export function parseLocalCommand(text: string, ctx: { path: string; nav: LocalNavItem[] }): LocalPlan | null {
  const said = norm(text);
  if (!said) return null;
  if (/^(?:nyx )?(?:(?:geh |gehe )?zurück(?: bitte)?|(?:please )?go back(?: please)?|back)$/u.test(said)) return { say: t("Zurück."), steps: [], back: true };

  // „Lies mir das Briefing vor“ / „Briefing vorlesen“ / „Read me the briefing“ → Briefing öffnen, Vorlesen startet von selbst.
  const read = READ_ALOUD.exec(said);
  if (read) {
    const recap = read.slice(1).includes("recap");
    return { say: recap ? t("Ich lese dir den Recap vor.") : t("Ich lese dir das Briefing vor."), steps: [{ action: "navigate", route: `/briefing?vorlesen=1${recap ? "&art=recap" : ""}` }] };
  }

  // „Such (mal) nach Heatmap“ / „Search for heatmap“ → Suche anklicken, Begriff tippen (Schreibweise wie gesagt).
  const search = SEARCH.exec(text.trim().replace(/[.!?]+$/u, ""));
  if (search?.[1]?.trim() && !/^(?:nach|for)$/iu.test(search[1].trim())) {
    const q = search[1].trim();
    return { say: t("Ich suche nach „{q}“.", { q }), steps: [{ action: "click", target: "suche" }, { action: "type", target: "suche", text: q }] };
  }

  const m = VERB.exec(said);
  if (!m) return null;
  const rest = stripFillers(said.slice(m[0].length));

  // „die zuletzt geöffnete Session“, „die vorige Sitzung“, „the last opened session“ → Liste „Zuletzt geöffnet“
  if (/^(?:zuletzt|vorige|vorigen|vorherige|vorherigen|last opened|recently opened|previous)\b.*\b(?:session|sitzung)$/u.test(rest)) {
    const onSessions = ctx.path.startsWith("/sessions");
    return {
      say: t("Ich öffne die zuletzt geöffnete Session."),
      steps: [...(onSessions ? [] : [{ action: "click", target: "nav:ses" } as const]), { action: "click", target: "recent" }, { action: "click", target: "recent-item:*" }],
    };
  }

  for (const item of ctx.nav) {
    const names = [norm(item.label), ...(ALIASES[item.id] ?? [])];
    if (names.includes(rest)) return { say: t("Ich öffne {name}.", { name: item.label }), steps: [{ action: "click", target: `nav:${item.id}` }] };
  }

  // „die neueste Session/Entscheidung/…“ → Seite über die Leiste, dann den neuesten Eintrag anklicken.
  const newest = NEWEST.exec(rest);
  const newestKind = newest?.[1] ? kindOf(newest[1], true) : null;
  if (newestKind) {
    const k = ITEM_KINDS[newestKind];
    return { say: k.newest(), steps: [...goTo(k.nav, ctx), { action: "click", target: `item:${newestKind}` }] };
  }

  // „die Aufgabe Heatmap“, „Session zu Login“ → Eintrag per Text (unscharf) finden.
  const named = NAMED.exec(rest);
  const namedKind = named?.[1] ? kindOf(named[1], false) : null;
  const query = named?.[2]?.replace(NAMED_FILLER, "").trim();
  // Mehr als ein kurzer Name („… und fass sie zusammen“) → das ist eine Aufgabe fürs Modell.
  if (namedKind && query && !/\b(?:und|dann|danach|and|then)\b/u.test(query) && query.split(" ").length <= 6) {
    const k = ITEM_KINDS[namedKind];
    return { say: k.named(query), steps: [...goTo(k.nav, ctx), { action: "click", target: `item:${namedKind}:${query}` }] };
  }
  return null;
}

// ───────────── Listeneinträge ─────────────

type ItemKind = "session" | "task" | "decision" | "idea" | "audit" | "repo";

interface ItemKindInfo {
  nav: string;
  singular: string[];
  plural: string[];
  /** Antwort auf „öffne die neueste …“. */
  newest: () => string;
  /** Antwort auf „öffne die … <Name>“. */
  named: (q: string) => string;
}

const ITEM_KINDS: Record<ItemKind, ItemKindInfo> = {
  session: {
    nav: "ses",
    singular: ["session", "sitzung"],
    plural: ["sessions", "sitzungen"],
    newest: () => t("Ich öffne die neueste Session."),
    named: (q) => t("Ich öffne die Session „{q}“.", { q }),
  },
  task: {
    nav: "task",
    singular: ["aufgabe", "task", "paket", "auftrag", "package"],
    plural: ["aufgaben", "tasks", "pakete", "aufträge", "packages"],
    newest: () => t("Ich öffne die neueste Aufgabe."),
    named: (q) => t("Ich öffne die Aufgabe „{q}“.", { q }),
  },
  decision: {
    nav: "inbox",
    singular: ["entscheidung", "freigabe", "decision", "approval"],
    plural: ["entscheidungen", "freigaben", "decisions", "approvals"],
    newest: () => t("Ich öffne die neueste Entscheidung."),
    named: (q) => t("Ich öffne die Entscheidung „{q}“.", { q }),
  },
  idea: {
    nav: "idea",
    singular: ["idee", "idea"],
    plural: ["ideen", "ideas"],
    newest: () => t("Ich öffne die neueste Idee."),
    named: (q) => t("Ich öffne die Idee „{q}“.", { q }),
  },
  audit: {
    nav: "audits",
    singular: ["audit", "befund", "finding"],
    plural: ["audits", "befunde", "findings"],
    newest: () => t("Ich öffne das neueste Audit."),
    named: (q) => t("Ich öffne das Audit „{q}“.", { q }),
  },
  repo: {
    nav: "git",
    singular: ["repo", "repository", "worktree"],
    plural: ["repos", "repositories", "worktrees"],
    newest: () => t("Ich öffne das neueste Repo."),
    named: (q) => t("Ich öffne das Repo „{q}“.", { q }),
  },
};

function kindOf(word: string, allowPlural: boolean): ItemKind | null {
  for (const [kind, k] of Object.entries(ITEM_KINDS) as [ItemKind, (typeof ITEM_KINDS)[ItemKind]][]) {
    if (k.singular.includes(word) || (allowPlural && k.plural.includes(word))) return kind;
  }
  return null;
}

/** Erst über die Leiste auf die Seite – außer Nyx ist schon dort. */
function goTo(navId: string, ctx: { path: string; nav: LocalNavItem[] }): NyxUiCommand[] {
  const path = ctx.nav.find((n) => n.id === navId)?.path;
  const here = path ? ctx.path === path || ctx.path.startsWith(`${path}/`) : false;
  return here ? [] : [{ action: "click", target: `nav:${navId}` }];
}

const NEWEST =
  /^(?:neueste|neuesten|neuester|neuestes|neuste|neusten|letzte|letzten|letztes|aktuellste|aktuellsten|aktuellstes|jüngste|jüngsten|juengste|newest|latest|last|most recent)\s+(\p{L}+)$/u;
const NAMED = /^(\p{L}+)\s+(.+)$/u;
const NAMED_FILLER = /^(?:(?:zu|zum|zur|über|namens|mit dem namen|mit|von|thema|dem|der|den|about|named|called|on|for|with|the)\s+)+/u;
const SEARCH = /^(?:nyx[,]?\s+)?(?:bitte\s+|please\s+)?(?:such|suche|search|look(?=\s+(?:for|up)\b))\s+(?:(?:mal|bitte|doch|please)\s+)*(?:nach\s+|for\s+|up\s+)?(.+)$/iu;
