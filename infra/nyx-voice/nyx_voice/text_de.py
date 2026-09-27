"""Text sprechbar machen — deutsch ausgeschriebene Zahlen, Uhrzeiten, Daten, Einheiten und ein
Aussprache-Wörterbuch für Fachwörter (NyxOS, Session, Build, Commit, Deploy, Claude, Codex …).

Warum: Die Piper-Stimmen sprechen über espeak-ng mit deutschen Regeln. Englische Fachwörter („Build“ → „Bu-ild“),
Ziffern und Zeichen („14:30“, „25.09.“, „%“) klingen dann falsch oder unverständlich. Pocket TTS profitiert
ebenso von ausgeschriebenen Zahlen. Alles hier ist reines Python (keine Abhängigkeit), getestet in
tests/test_n3b.py. Eigene Umsetzung, kein Fremdcode.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

# ─────────────────────────── Zahlen ───────────────────────────

_ONES = ["null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf",
         "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn"]
_TENS = ["", "", "zwanzig", "dreißig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig", "neunzig"]
_MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"]


def _below_100(n: int, *, prefix: bool) -> str:
    """`prefix` = Teil eines längeren Worts („einhundert“, „einundzwanzig“) → „ein“ statt „eins“."""
    if n < 20:
        if n == 1 and prefix:
            return "ein"
        return _ONES[n]
    tens, ones = divmod(n, 10)
    if ones == 0:
        return _TENS[tens]
    return f"{'ein' if ones == 1 else _ONES[ones]}und{_TENS[tens]}"


def _below_1000(n: int, *, prefix: bool) -> str:
    hundreds, rest = divmod(n, 100)
    out = ""
    if hundreds:
        out = f"{'ein' if hundreds == 1 else _ONES[hundreds]}hundert"
    if rest:
        out += _below_100(rest, prefix=prefix)
    return out


def number_words(n: int) -> str:
    """Grundzahl als deutsches Wort (0 … 999 999 999 999). Größere Zahlen Ziffer für Ziffer."""
    if n < 0:
        return "minus " + number_words(-n)
    if n == 0:
        return "null"
    if n >= 10**12:
        return " ".join(_ONES[int(d)] for d in str(n))
    parts: list[str] = []
    billions, rest = divmod(n, 10**9)
    millions, rest = divmod(rest, 10**6)
    thousands, rest = divmod(rest, 1000)
    if billions:
        parts.append("eine Milliarde" if billions == 1 else f"{_below_1000(billions, prefix=False)} Milliarden")
    if millions:
        parts.append("eine Million" if millions == 1 else f"{_below_1000(millions, prefix=False)} Millionen")
    word = ""
    if thousands:
        word = f"{'ein' if thousands == 1 else _below_1000(thousands, prefix=True)}tausend"
    if rest:
        word += _below_1000(rest, prefix=False)
    if word:
        parts.append(word)
    return " ".join(parts)


def year_words(n: int) -> str:
    """Jahreszahl: 1999 → neunzehnhundertneunundneunzig, 2026 → zweitausendsechsundzwanzig."""
    if 1100 <= n <= 1999:
        hi, lo = divmod(n, 100)
        return f"{_below_100(hi, prefix=False)}hundert{_below_100(lo, prefix=False) if lo else ''}"
    return number_words(n)


def ordinal_words(n: int, ending: str = "te") -> str:
    """Ordnungszahl: 1 → erste, 3 → dritte, 7 → siebte, 25 → fünfundzwanzigste (Endung anhängbar)."""
    special = {1: "ers", 3: "drit", 7: "sieb", 8: "ach"}
    if n in special:
        stem = special[n]
    elif n < 20:
        stem = number_words(n)
    else:
        stem = number_words(n) + "s"
    return stem + ending


# ─────────────────────────── Aussprache-Wörterbuch ───────────────────────────

# Das Wörterbuch liegt als Datei neben dem Code (lexicon_de.json: [{"word", "say"}, …]) — ergänzen ohne
# Code-Änderung. (Wort, Aussprache-Schreibweise), Groß-/Kleinschreibung egal, nur ganze Wörter, längere zuerst.
# Eigene Einträge vom Nutzer kommen je Anfrage dazu (`normalize(extra=…)`, Feld `lexicon` von /speak) und gewinnen.
LEXICON_FILE = Path(__file__).with_name("lexicon_de.json")


def _load_lexicon(path: Path) -> list[tuple[str, str]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return [(str(e["word"]), str(e["say"])) for e in data]


LEXICON: list[tuple[str, str]] = _load_lexicon(LEXICON_FILE)


def _compile_lexicon(entries: list[tuple[str, str]], *, exact_short_caps: bool) -> list[tuple[re.Pattern[str], str]]:
    """Ganze Wörter. Kurze Großbuchstaben-Kürzel („OK“, „UI“) im eingebauten Wörterbuch nur exakt (sonst würde „ui“
    in einem Satz ersetzt); eigene Einträge immer ohne Rücksicht auf Groß/Klein."""
    out = []
    for word, say in sorted(entries, key=lambda e: -len(e[0])):
        flags = re.IGNORECASE if not exact_short_caps or word != word.upper() or len(word) > 3 else 0
        # Ersatz als Funktion: „\1“ o. Ä. in der Aussprache wird nie als Regex-Verweis gelesen.
        out.append((re.compile(rf"(?<!\w){re.escape(word)}(?!\w)", flags), say))
    return out


_LEXICON_RE = _compile_lexicon(LEXICON, exact_short_caps=True)

# ─────────────────────────── Abkürzungen, Zeichen, Einheiten ───────────────────────────

_ABBREV = [
    (re.compile(r"\bz\.\s?B\.", re.IGNORECASE), "zum Beispiel"),
    (re.compile(r"\bu\.\s?a\.", re.IGNORECASE), "unter anderem"),
    (re.compile(r"\bd\.\s?h\.", re.IGNORECASE), "das heißt"),
    (re.compile(r"\bbzw\.", re.IGNORECASE), "beziehungsweise"),
    (re.compile(r"\bca\.", re.IGNORECASE), "zirka"),
    (re.compile(r"\busw\.", re.IGNORECASE), "und so weiter"),
    (re.compile(r"\betc\.", re.IGNORECASE), "et cetera"),
    (re.compile(r"\bNr\.\s?(?=\d)"), "Nummer "),
    (re.compile(r"\bggf\.", re.IGNORECASE), "gegebenenfalls"),
    (re.compile(r"\binkl\.", re.IGNORECASE), "inklusive"),
    (re.compile(r"\bevtl\.", re.IGNORECASE), "eventuell"),
    (re.compile(r"\bmind\.", re.IGNORECASE), "mindestens"),
]

_UNITS = {
    "%": "Prozent", "€": "Euro", "$": "Dollar", "°C": "Grad", "°": "Grad",
    "ms": "Millisekunden", "s": "Sekunden", "Sek.": "Sekunden", "min": "Minuten", "Min.": "Minuten", "h": "Stunden",
    "Std.": "Stunden", "Std": "Stunden", "Mio.": "Millionen", "Mrd.": "Milliarden", "GB": "Gigabyte", "MB": "Megabyte", "KB": "Kilobyte", "TB": "Terabyte", "km": "Kilometer",
    "m": "Meter", "kg": "Kilo", "GHz": "Gigahertz", "kHz": "Kilohertz", "Hz": "Hertz",
}
_UNIT_RE = re.compile(r"(\d)\s?(" + "|".join(re.escape(u) for u in sorted(_UNITS, key=len, reverse=True)) + r")(?![\w])")

_MARKDOWN_RE = [
    (re.compile(r"```[\s\S]*?```"), " "),
    (re.compile(r"`([^`]*)`"), r"\1"),
    (re.compile(r"\[([^\]]+)\]\([^)]+\)"), r"\1"),
    (re.compile(r"https?://\S+"), "ein Link"),
    (re.compile(r"[*_#>|]+"), " "),
]

_EMOJI_RE = re.compile("[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F900-\U0001F9FF️‍]")

# ─────────────────────────── Zahlen im Text ───────────────────────────

_DATE_RE = re.compile(r"(?<![\d.])(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(\d{4}|\d{2})(?![\d.]))?")
# Nyx schreibt jetzt Ziffern – „am 3. Oktober“ → „am dritten Oktober“ (nicht „drei. Oktober“).
_DAY_MONTH_RE = re.compile(r"(?<![\d.])(\d{1,2})\.\s?(?=(?:" + "|".join(_MONTHS) + r")\b)")
_TIME_RE = re.compile(r"(?<![\d:.])([01]?\d|2[0-3]):([0-5]\d)(?:\s?Uhr)?(?![\d:])")
_TIME_DOT_RE = re.compile(r"(?<![\d:.])([01]?\d|2[0-3])\.([0-5]\d)\s?Uhr\b")
_HOUR_RE = re.compile(r"(?<![\d,.])([01]?\d|2[0-4])\s?Uhr\b")
_THOUSANDS_RE = re.compile(r"(?<![\d,.])(\d{1,3}(?:\.\d{3})+)(?![\d,.]|\.\d)")
_DECIMAL_RE = re.compile(r"(?<![\d,.])(\d+),(\d+)(?![\d,])")
# Nur mit „v“ davor oder nach Build/Version/Release/App — sonst wären Daten/Tausender gemeint („Build 1.1.59“).
_VERSION_RE = re.compile(r"(?:\b(Build|Version|Release|App)\s+v?|(?<![\w.])v)(\d+)\.(\d+)(?:\.(\d+))?(?![\d])", re.IGNORECASE)
_ISO_DATE_RE = re.compile(r"(?<![\d.-])(\d{4})-(\d{2})-(\d{2})(?![\d-])")
# Beträge liest die Stimme selbst (das Modell schreibt Ziffern, s. apps/server/src/nyx/personaDefault.ts).
# „$1.809“ → „1.809 $“, „1.810 USD“ → „1.810 $“, englisches Format mit BEIDEN Trennern („$1,882.90“) → deutsches.
_EN_FORMAT_RE = re.compile(r"(?<![\d.,])(\d{1,3}(?:,\d{3})+)\.(\d+)(?!\d|[.,]\d)")
_CURRENCY_BEFORE_RE = re.compile(r"([$€])\s?(\d(?:[\d.,]*\d)?)")
_CURRENCY_CODE_RE = re.compile(r"(\d)\s?(USD|US-Dollar|EUR)\b")
_CURRENCY_CODE = {"USD": "$", "US-Dollar": "$", "EUR": "€"}
_MONEY_RE = re.compile(r"(?<![\d,.])(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?\s?([€$])(?!\w)")
_CURRENCY_NAME = {"€": "Euro", "$": "Dollar"}
_THOUSANDS_DECIMAL_RE = re.compile(r"(?<![\d,.])(\d{1,3}(?:\.\d{3})+),(\d+)(?![\d,])")
_ONE_UNIT_RE = re.compile(r"(?<![\d,.])1\s?(ms|s|Sek\.|min|Min\.|h|Std\.|Std)(?![\w])")
_ONE_UNIT = {"ms": "eine Millisekunde", "s": "eine Sekunde", "Sek.": "eine Sekunde", "min": "eine Minute", "Min.": "eine Minute", "h": "eine Stunde", "Std.": "eine Stunde", "Std": "eine Stunde"}
_FEMININE = re.compile(
    r"\s+(Aufgabe|Minute|Stunde|Sekunde|Session|Säschn|Nachricht|Datei|Frage|Woche|Idee|Sitzung|Zeile|Änderung|Mail|E-Mail|Seite|Stimme|Warnung|Fehlermeldung|Freigabe|Notiz|Liste|Stelle)\b"
)
_YEAR_HINT = re.compile(r"\b(im Jahr|Jahr|seit|bis|von|ab|anno|Sommer|Winter|Frühjahr|Herbst)\s*$", re.IGNORECASE)
_RANGE_RE = re.compile(r"(?<=\d)\s?[–-]\s?(?=\d)")
_INT_RE = re.compile(r"(?<![\w,.])(\d+)(?![\d])")
_DATIVE_BEFORE = re.compile(r"\b(am|vom|zum|bis zum|ab dem|seit dem|dem)\s*$", re.IGNORECASE)


def _date(m: re.Match[str], text: str) -> str:
    day, month = int(m.group(1)), int(m.group(2))
    if not (1 <= day <= 31 and 1 <= month <= 12):
        return m.group(0)
    ending = "ten" if _DATIVE_BEFORE.search(text[: m.start()]) else "te"
    out = f"{ordinal_words(day, ending)} {_MONTHS[month - 1]}"
    if m.group(3):
        y = int(m.group(3))
        out += " " + year_words(2000 + y if len(m.group(3)) == 2 else y)
    return out


def _version(m: re.Match[str], text: str) -> str:
    nums = " Punkt ".join(number_words(int(g)) for g in m.groups()[1:] if g is not None)
    return f"{m.group(1)} {nums}" if m.group(1) else f"Version {nums}"


def _iso_date(m: re.Match[str], text: str) -> str:
    year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not (1 <= day <= 31 and 1 <= month <= 12):
        return m.group(0)
    ending = "ten" if _DATIVE_BEFORE.search(text[: m.start()]) else "te"
    return f"{ordinal_words(day, ending)} {_MONTHS[month - 1]} {year_words(year)}"


def _time(m: re.Match[str]) -> str:
    h, mi = int(m.group(1)), int(m.group(2))
    hour = "ein" if h == 1 else number_words(h)
    return f"{hour} Uhr" + (f" {number_words(mi)}" if mi else "")


def _money(m: re.Match[str], text: str) -> str:
    """„0,98 €“ → „achtundneunzig Cent“, „1,50 €“ → „ein Euro fünfzig“, „1.882,90 $“ → „… Dollar neunzig“."""
    whole = int(m.group(1).replace(".", ""))
    cents = int(m.group(2).ljust(2, "0")) if m.group(2) else 0
    name = _CURRENCY_NAME[m.group(3)]
    if whole == 0 and cents:
        return f"{'ein' if cents == 1 else number_words(cents)} Cent"
    out = f"{'ein' if whole == 1 else number_words(whole)} {name}"
    return out + (f" {number_words(cents)}" if cents else "")


def _decimal_digits(digits: str) -> str:
    return " ".join(_ONES[int(d)] for d in digits)


def _int(m: re.Match[str], text: str) -> str:
    n = int(m.group(1))
    if len(m.group(1)) == 4 and 1100 <= n <= 1999 and _YEAR_HINT.search(text[: m.start()]):
        return year_words(n)
    if n == 1:
        after = text[m.end():]
        # „1 Aufgabe“ → „eine Aufgabe“, „1 Test“ → „ein Test“, „Schritt 1 von 3“ / „Punkt 1.“ → „eins“
        if _FEMININE.match(after):
            return "eine"
        return "ein" if re.match(r"\s+[A-ZÄÖÜ]", after) else "eins"
    if len(m.group(1)) > 1 and m.group(1).startswith("0"):
        return " ".join(_ONES[int(d)] for d in m.group(1))
    return number_words(n)


def _apply(regex: re.Pattern[str], text: str, fn) -> str:
    out: list[str] = []
    last = 0
    for m in regex.finditer(text):
        out.append(text[last:m.start()])
        out.append(fn(m, text))
        last = m.end()
    out.append(text[last:])
    return "".join(out)


# Platzhalter für Wörter aus dem eigenen Wörterbuch (Zeichen aus dem privaten Unicode-Bereich: kein \\w, keine
# Ziffer — keine spätere Regel fasst sie an). Höchstens 300 eigene Einträge → reicht bis U+F8FF bei Weitem.
_SLOT_BASE = 0xE000


def normalize(text: str, *, lexicon: bool = True, extra: list[tuple[str, str]] | None = None) -> str:
    """Text → sprechbarer deutscher Text (Zahlen ausgeschrieben, Fachwörter lautschriftlich).
    `extra` = eigene Einträge (Wort → Aussprache). Sie gelten zuerst und immer (auch mit `lexicon=False`); ihre
    Aussprache bleibt unangetastet (keine Zahlen-/Wörterbuch-Regel läuft mehr darüber)."""
    # Pfeile/Tilde vor dem Markdown-Schritt (der sonst „>“ entfernt)
    t = text.replace("->", " zu ").replace("→", " zu ").replace("≈", " etwa ").replace("~", " etwa ")
    for rx, rep in _MARKDOWN_RE:
        t = rx.sub(rep, t)
    t = _EMOJI_RE.sub("", t)
    slots: list[str] = []
    for rx, say in _compile_lexicon(list(extra or []), exact_short_caps=False):
        def _slot(_m: re.Match[str], say: str = say) -> str:
            slots.append(say)
            return chr(_SLOT_BASE + len(slots) - 1)
        t = rx.sub(_slot, t)
    for rx, rep in _ABBREV:
        t = rx.sub(rep, t)
    t = t.replace("&", " und ")
    t = re.sub(r"(?<=\s)\+(?=\s)", "plus", t)
    t = re.sub(r"(?<=\d)\s?km/h\b", " Kilometer pro Stunde", t)  # vorher in speak.ts, vor dem „/“-Schritt
    t = re.sub(r"(?<=\w)/(?=\w)", " ", t)
    t = _apply(_VERSION_RE, t, _version)
    t = _apply(_ISO_DATE_RE, t, _iso_date)
    t = _apply(_DATE_RE, t, _date)
    t = _apply(_DAY_MONTH_RE, t, lambda m, tx: f"{ordinal_words(int(m.group(1)), 'ten' if _DATIVE_BEFORE.search(tx[: m.start()]) else 'te')} " if 1 <= int(m.group(1)) <= 31 else m.group(0))
    t = _apply(_TIME_RE, t, lambda m, _t: _time(m))
    t = _apply(_TIME_DOT_RE, t, lambda m, _t: _time(m))
    t = _apply(_HOUR_RE, t, lambda m, _t: f"{'ein' if m.group(1) in ('1', '01') else number_words(int(m.group(1)))} Uhr")
    t = _EN_FORMAT_RE.sub(lambda m: f"{m.group(1).replace(',', '.')},{m.group(2)}", t)
    t = _CURRENCY_BEFORE_RE.sub(r"\2 \1", t)
    t = _CURRENCY_CODE_RE.sub(lambda m: f"{m.group(1)} {_CURRENCY_CODE[m.group(2)]}", t)
    t = _apply(_MONEY_RE, t, _money)
    t = _ONE_UNIT_RE.sub(lambda m: _ONE_UNIT[m.group(1)], t)
    t = _UNIT_RE.sub(lambda m: f"{m.group(1)} {_UNITS[m.group(2)]}", t)
    # Tausender direkt als Wort (nie als Jahreszahl: „1.500 Tokens“ → „eintausendfünfhundert“)
    t = _apply(_THOUSANDS_DECIMAL_RE, t, lambda m, _t: f"{number_words(int(m.group(1).replace('.', '')))} Komma {_decimal_digits(m.group(2))}")
    t = _apply(_THOUSANDS_RE, t, lambda m, _t: number_words(int(m.group(1).replace(".", ""))))
    t = _RANGE_RE.sub(" bis ", t)
    t = _apply(_DECIMAL_RE, t, lambda m, _t: f"{number_words(int(m.group(1)))} Komma {_decimal_digits(m.group(2))}")
    t = _apply(_INT_RE, t, _int)
    if lexicon:
        for rx, say in _LEXICON_RE:
            t = rx.sub(lambda _m, say=say: say, t)
    if slots:
        t = re.sub(f"[{chr(_SLOT_BASE)}-{chr(_SLOT_BASE + len(slots) - 1)}]", lambda m: slots[ord(m.group(0)) - _SLOT_BASE], t)
    return re.sub(r"\s+", " ", t).strip()


# ─────────────────────────── Sätze ───────────────────────────

_SENT_RE = re.compile(r"[^.!?…]+(?:[.!?…]+[\"“”»)]*|$)")


def split_sentences(text: str, first_max: int = 90, max_len: int = 240) -> list[str]:
    """In Sätze teilen; der ERSTE Teil möglichst kurz (schneller erster Ton), keiner länger als `max_len`."""
    clean = re.sub(r"\s+", " ", text).strip()
    if not clean:
        return []
    sentences = [s.strip() for s in _SENT_RE.findall(clean) if s.strip()] or [clean]
    out: list[str] = []
    for s in sentences:
        out.extend(_split_long(s, max_len) if len(s) > max_len else [s])
    if out and len(out[0]) > first_max:
        out[0:1] = _split_long(out[0], first_max)
    return out


def _split_long(sentence: str, max_len: int) -> list[str]:
    out: list[str] = []
    rest = sentence
    while len(rest) > max_len:
        window = rest[:max_len]
        cut = max(window.rfind(", "), window.rfind("; "), window.rfind(": "))
        cut = cut + 1 if cut > max_len // 3 else window.rfind(" ")
        if cut <= 0:
            cut = max_len
        out.append(rest[:cut].strip())
        rest = rest[cut:].strip()
    if rest:
        out.append(rest)
    return out
