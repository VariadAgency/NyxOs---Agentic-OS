"""Welche Sprache hat ein Satz — Deutsch oder Englisch?

Leichte, robuste Heuristik ohne Modell: typische Funktionswörter beider Sprachen zählen (der/die/und/ist gegen
the/and/is/you), Umlaute und ß zählen für Deutsch. Fachwörter („Build, Commit, Deploy, Session, Push, Server …“)
stehen in KEINER Liste: Sie kommen in deutschen Sätzen ständig vor und dürfen einen deutschen Satz nie auf Englisch
kippen. Wörter, die es in beiden Sprachen gibt („in, an, was, will, war, also, so“), zählen ebenfalls nicht.

Unentschiedene Sätze („Okay.“, „Build fertig?“ ohne Funktionswort) übernehmen die Sprache des Satzes davor
(sonst den Standard). Eigene Umsetzung, kein Fremdcode; Spiegel in TypeScript: packages/shared/src/nyx-voice.ts
(`guessVoiceLanguage`), damit Erkennung und Ausgabe gleich entscheiden.
"""

from __future__ import annotations

import re

Language = str  # "de" | "en"

DE_WORDS = frozenset("""
der die das den dem des ein eine einen einem einer eines kein keine keinen keinem keiner und oder aber doch denn
ist sind bin bist seid war waren wird werden wurde wurden hat habe hast haben hatte hatten kann kannst können könnte
soll sollte sollen muss musst müssen darf dürfen möchte möchtest mag magst will willst
ich du er sie wir ihr mir mich dir dich ihm ihn uns euch sich mein meine meinen dein deine unser unsere euer ihre
nicht nichts noch schon auch nur mal jetzt gerade heute morgen gestern bitte danke ja nein genau gut sehr ganz
mit für von zu zum zur im ins vom beim am um bis nach über unter vor seit ohne gegen durch aus bei
was wer wie wo wann warum wieso weshalb welche welcher welches dass wenn weil ob als dann damit also
hier dort da dies diese dieser dieses alle alles viel viele mehr weniger etwas einfach wieder immer
läuft fertig gemacht machen mach mache macht gibt geht gehen sag sagen zeig zeige schau prüf prüfe fehlt hallo tschüss
klar perfekt verstanden erledigt prima gleich
""".split())

EN_WORDS = frozenset("""
the a and or but is are was were be been being am do does did done have has had having can could should would
shall may might must i you he she it we they me him her us them my your his its our their mine yours
this that these those there here not no yes please thanks thank just now today tomorrow yesterday
with of to for from on at by about into over under after before without through
what who how where when why which whose if because so then than also
all some any every more less very really again always still already
it's i'm you're we're they're that's there's what's let's don't doesn't didn't can't won't isn't aren't wasn't
i've you've we've i'll you'll we'll i'd you'd
hi hello hey ready running works working failed fixed looks look let tell show give make go
good great nice perfect sure sorry fine morning evening night
""".split()) - {"so", "also"}  # „so“/„also“ gibt es in beiden Sprachen
# „check“ steht bewusst in KEINER Liste — in deutschen Entwickler-Sätzen („check mal die Session“) ist es
# ein Fachwort wie „Build“.

# Wörter aus beiden Listen, die in beiden Sprachen echte Wörter sind: zählen nie.
_SHARED = {"okay", "ok", "hey", "in", "an", "was", "will", "war", "also", "so", "man", "hand", "rest", "top", "name", "art", "fast"}
_DE = DE_WORDS - _SHARED
_EN = EN_WORDS - _SHARED - {"a"}  # „a“ allein zählt schwach (s. unten)

_WORD_RE = re.compile(r"[A-Za-zÄÖÜäöüß'’]+")  # ’ wie ' (don’t = don't), wie im TS-Spiegel
_UMLAUT_RE = re.compile(r"[äöüÄÖÜß]")


def language_scores(text: str) -> tuple[float, float]:
    """(Punkte Deutsch, Punkte Englisch) für einen Text."""
    de = 2.0 * len(_UMLAUT_RE.findall(text))
    en = 0.0
    for raw in _WORD_RE.findall(text):
        w = raw.lower().replace("’", "'").strip("'")
        if w in _DE:
            de += 1.0
        elif w in _EN:
            en += 1.0
        elif w == "a":
            en += 0.5
    return de, en


def detect_language(text: str) -> Language | None:
    """„de“, „en“ oder None (unentschieden). Englisch braucht einen klaren Vorsprung — im Zweifel Deutsch."""
    de, en = language_scores(text)
    if de == 0 and en == 0:
        return None
    if en > de:
        return "en"
    if de > en:
        return "de"
    return None


def guess_language(text: str, default: Language = "de") -> Language:
    """Sprache eines ganzen Textes (z. B. einer Erkennung): Mehrheit der Sätze, sonst `default`."""
    de_total = en_total = 0.0
    for sentence in split_raw_sentences(text):
        lang = detect_language(sentence)
        if lang == "de":
            de_total += 1
        elif lang == "en":
            en_total += 1
    if en_total > de_total:
        return "en"
    if de_total > en_total:
        return "de"
    return detect_language(text) or default


# ─────────────────────────── Sätze im Rohtext ───────────────────────────

# Satzende = Satzzeichen + Leerraum. KEIN Ende nach Abkürzungen („z. B.“, „e.g.“, „Nr.“) und nach Ziffern mit Punkt
# („am 25.09. um“, „Punkt 3. und“) — sonst würde ein Datum mitten im Satz die Stimme wechseln lassen.
_END_RE = re.compile(r"[.!?…]+[\"“”»)']*\s+|\n+")
_ABBREV_BEFORE = re.compile(
    r"(?:\b(?:z|B|u|a|d|h|bzw|ca|usw|etc|Nr|ggf|inkl|evtl|mind|vgl|Dr|Mr|Mrs|Ms|St|e\.g|i\.e|vs|approx)|\d)\.$",
    re.IGNORECASE,
)


def split_raw_sentences(text: str) -> list[str]:
    """Rohtext (noch nicht normalisiert) in Sätze — nur für die Sprachwahl, Ton-Stücke teilt text_de weiter."""
    out: list[str] = []
    start = 0
    for m in _END_RE.finditer(text):
        end_mark = m.group(0)
        if end_mark.startswith(".") and _ABBREV_BEFORE.search(text[max(start, m.start() - 8):m.start() + 1]):
            continue  # Abkürzung oder Ziffer mit Punkt: kein Satzende
        sentence = text[start:m.end()].strip()
        if sentence:
            out.append(sentence)
        start = m.end()
    rest = text[start:].strip()
    if rest:
        out.append(rest)
    return out


def split_by_language(text: str, default: Language = "de", forced: Language | None = None) -> list[tuple[Language, str]]:
    """Text → [(Sprache, Abschnitt), …]; benachbarte Sätze gleicher Sprache bleiben EIN Abschnitt (weniger
    Stimmwechsel, natürlicherer Fluss). `forced` = ganze Nachricht in einer Sprache (Einstellung/Probe)."""
    clean = text.strip()
    if not clean:
        return []
    if forced in ("de", "en"):
        return [(forced, clean)]
    sentences = split_raw_sentences(clean) or [clean]
    langs: list[Language | None] = [detect_language(s) for s in sentences]
    # Unentschiedene Sätze: Sprache davor, sonst danach, sonst Standard.
    current: Language | None = None
    for i, lang in enumerate(langs):
        if lang is None:
            langs[i] = current
        else:
            current = lang
    nxt: Language | None = None
    for i in range(len(langs) - 1, -1, -1):
        if langs[i] is None:
            langs[i] = nxt
        else:
            nxt = langs[i]
    out: list[tuple[Language, str]] = []
    for sentence, lang in zip(sentences, langs):
        lang = lang or default
        if out and out[-1][0] == lang:
            out[-1] = (lang, f"{out[-1][1]} {sentence}")
        else:
            out.append((lang, sentence))
    return out
