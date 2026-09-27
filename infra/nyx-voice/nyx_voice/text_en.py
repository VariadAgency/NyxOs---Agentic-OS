"""Englischen Text sprechbar machen — Gegenstück zu text_de.py für die englische Stimme.

Zahlen, Uhrzeiten, Daten, Versionen, Einheiten und Abkürzungen werden auf Englisch ausgeschrieben („14:30“ →
„two thirty PM“, „3.5 GB“ → „three point five gigabytes“, „2026-09-26“ → „September twenty-sixth, twenty twenty-six“).
Fachwörter bleiben, wie sie sind: Die englische Stimme spricht „Build, Commit, Deploy“ ohnehin richtig. Nur Namen,
die auch auf Englisch falsch klingen (NyxOS, Nyx), bekommen eine Lautschrift. Reines Python, eigene Umsetzung.
"""

from __future__ import annotations

import re

_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
         "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
           "November", "December"]
_ORD_SPECIAL = {"one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth", "nine": "ninth",
                "twelve": "twelfth"}


def _below_100(n: int) -> str:
    if n < 20:
        return _ONES[n]
    tens, ones = divmod(n, 10)
    return _TENS[tens] + (f"-{_ONES[ones]}" if ones else "")


def _below_1000(n: int) -> str:
    hundreds, rest = divmod(n, 100)
    parts = []
    if hundreds:
        parts.append(f"{_ONES[hundreds]} hundred")
    if rest:
        parts.append(_below_100(rest))
    return " ".join(parts)


def number_words(n: int) -> str:
    """Grundzahl auf Englisch (0 … 999 999 999 999), größere Ziffer für Ziffer."""
    if n < 0:
        return "minus " + number_words(-n)
    if n == 0:
        return "zero"
    if n >= 10**12:
        return " ".join(_ONES[int(d)] for d in str(n))
    parts: list[str] = []
    for value, name in ((10**9, "billion"), (10**6, "million"), (1000, "thousand")):
        big, n = divmod(n, value)
        if big:
            parts.append(f"{_below_1000(big)} {name}")
    if n:
        parts.append(_below_1000(n))
    return " ".join(parts)


def ordinal_words(n: int) -> str:
    """1 → first, 22 → twenty-second, 30 → thirtieth."""
    words = number_words(n)
    head, sep, last = words.rpartition("-") if "-" in words.split(" ")[-1] else words.rpartition(" ")
    if last in _ORD_SPECIAL:
        last = _ORD_SPECIAL[last]
    elif last.endswith("y"):
        last = last[:-1] + "ieth"
    else:
        last += "th"
    return f"{head}{sep}{last}"


def year_words(n: int) -> str:
    """2026 → twenty twenty-six, 2005 → two thousand five, 1999 → nineteen ninety-nine."""
    if 2000 <= n <= 2009:
        return number_words(n)
    if 1100 <= n <= 2099:
        hi, lo = divmod(n, 100)
        if lo == 0:
            return f"{_below_100(hi)} hundred"
        return f"{_below_100(hi)} {'oh ' + _ONES[lo] if lo < 10 else _below_100(lo)}"
    return number_words(n)


# ─────────────────────────── Zeichen, Abkürzungen, Einheiten ───────────────────────────

LEXICON = [
    ("NyxOS", "Nix O S"),
    ("Nyx", "Nix"),
    ("API", "A P I"),
    ("UI", "U I"),
    ("URL", "U R L"),
    ("CPU", "C P U"),
    ("GPU", "G P U"),
    ("SSH", "S S H"),
    ("DB", "D B"),
    ("TTS", "T T S"),
    ("PR", "P R"),
    ("CI", "C I"),
    ("MCP", "M C P"),
]
_LEXICON_RE = [(re.compile(rf"(?<!\w){re.escape(w)}(?!\w)"), say) for w, say in sorted(LEXICON, key=lambda e: -len(e[0]))]

_ABBREV = [
    (re.compile(r"\be\.\s?g\.", re.IGNORECASE), "for example"),
    (re.compile(r"\bi\.\s?e\.", re.IGNORECASE), "that is"),
    (re.compile(r"\betc\.", re.IGNORECASE), "et cetera"),
    (re.compile(r"\bvs\.", re.IGNORECASE), "versus"),
    (re.compile(r"\bapprox\.", re.IGNORECASE), "approximately"),
    (re.compile(r"\bNo\.\s?(?=\d)"), "number "),
    (re.compile(r"\bMr\."), "Mister"),
    (re.compile(r"\bDr\."), "Doctor"),
]

_UNITS = {
    "%": ("percent", "percent"), "€": ("euro", "euros"), "$": ("dollar", "dollars"), "°C": ("degree", "degrees"),
    "°": ("degree", "degrees"), "ms": ("millisecond", "milliseconds"), "s": ("second", "seconds"),
    "sec": ("second", "seconds"), "min": ("minute", "minutes"), "h": ("hour", "hours"), "GB": ("gigabyte", "gigabytes"),
    "MB": ("megabyte", "megabytes"), "KB": ("kilobyte", "kilobytes"), "TB": ("terabyte", "terabytes"),
    "km": ("kilometer", "kilometers"), "m": ("meter", "meters"), "kg": ("kilogram", "kilograms"),
    "GHz": ("gigahertz", "gigahertz"), "Hz": ("hertz", "hertz"),
}
_NUM = r"(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)"
_UNIT_RE = re.compile(r"(?<![\d.,])" + _NUM + r"\s?(" + "|".join(re.escape(u) for u in sorted(_UNITS, key=len, reverse=True)) + r")(?![\w])")
_CURRENCY_BEFORE_RE = re.compile(r"([$€])\s?" + _NUM)
# Betrag mit Zeichen dahinter („1,882.90 $“) wie davor lesen, nicht als „… point nine zero dollars“.
_CURRENCY_AFTER_RE = re.compile(r"(?<![\d.,])" + _NUM + r"\s?([$€])(?!\w)")
_CURRENCY_CODE_RE = re.compile(r"(\d)\s?(USD|EUR)\b")
# Deutsch formatierte Zahlen im englischen Satz – nur eindeutige Fälle: beide Trenner („1.882,90“), Tausender-Punkt
# an einem Betrag („$1.809“, „1.809 $“) und Dezimal-Komma vor %, € oder $ („12,5 %“, „0,98 €“).
_DE_BOTH_RE = re.compile(r"(?<![\d.,])(\d{1,3}(?:\.\d{3})+),(\d+)(?!\d|[.,]\d)")
_DE_MONEY_BEFORE_RE = re.compile(r"([$€])\s?(\d{1,3}(?:\.\d{3})+)(?!\d|[.,]\d)")
_DE_MONEY_AFTER_RE = re.compile(r"(?<![\d.,])(\d{1,3}(?:\.\d{3})+)(?=\s?[$€])")
# auch vor einem Wort/einer Einheit („1,5 GB“, „3,9 billion“) – englische Tausender haben immer 3 Stellen.
_DE_DECIMAL_RE = re.compile(r"(?<![\d.,])(\d+),(\d{1,2})(?![\d.,])(?=\s?(?:[%€$]|[A-Za-z]))")
# Mehrere Tausender-Punkte („1.000.000“) und deutsches Datum („26.09.2026“) sind im Englischen eindeutig deutsch.
_DE_THOUSANDS_MULTI_RE = re.compile(r"(?<![\d.,])(\d{1,3}(?:\.\d{3}){2,})(?![\d]|[.,]\d)")
_DE_DATE_RE = re.compile(r"(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4})(?![\d])")
# Deutsche Größenwörter (die Sprechfassung macht „Mrd.“ → „Milliarden“) nach einer Zahl.
_DE_MAGNITUDE_RE = re.compile(r"(?<=\d)\s?(Milliarden|Mrd\.|Millionen|Mio\.|Tausend|Tsd\.)(?!\w)")
_DE_MAGNITUDE = {"Milliarden": "billion", "Mrd.": "billion", "Millionen": "million", "Mio.": "million", "Tausend": "thousand", "Tsd.": "thousand"}

_MARKDOWN_RE = [
    (re.compile(r"```[\s\S]*?```"), " "),
    (re.compile(r"`([^`]*)`"), r"\1"),
    (re.compile(r"\[([^\]]+)\]\([^)]+\)"), r"\1"),
    (re.compile(r"https?://\S+"), "a link"),
    (re.compile(r"[*_#>|]+"), " "),
]
_EMOJI_RE = re.compile("[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F900-\U0001F9FF️‍]")

# ─────────────────────────── Zahlen im Text ───────────────────────────

_TIME_RE = re.compile(r"(?<![\d:.])([01]?\d|2[0-3]):([0-5]\d)(?:\s?([AaPp])(?:\.[Mm]\.|[Mm])(?!\w))?(?![\d:])")
_HOUR_AMPM_RE = re.compile(r"(?<![\d:.])(1[0-2]|0?[1-9])\s?([AaPp])(?:\.[Mm]\.|[Mm])(?!\w)")
_ISO_DATE_RE = re.compile(r"(?<![\d.-])(\d{4})-(\d{2})-(\d{2})(?![\d-])")
_VERSION_RE = re.compile(r"(?:\b(Build|Version|Release|App)\s+v?|(?<![\w.])v)(\d+)\.(\d+)(?:\.(\d+))?(?![\d])", re.IGNORECASE)
_THOUSANDS_RE = re.compile(r"(?<![\d.,])(\d{1,3}(?:,\d{3})+)(?![\d,]|\.\d)")
_DECIMAL_RE = re.compile(r"(?<![\d.,])(\d+)\.(\d+)(?!\d|\.\d)")
_ORDINAL_RE = re.compile(r"(?<![\w.,])(\d+)(st|nd|rd|th)\b")
_YEAR_RE = re.compile(r"(?<![\w.,:])(1[1-9]\d\d|20\d\d)(?!\d|[.,:]\d|\s?(?:%|ms|s|min|h|GB|MB|KB|TB)\b)")
_RANGE_RE = re.compile(r"(?<=\d)\s?[–-]\s?(?=\d)")
_INT_RE = re.compile(r"(?<![\w.,])(\d+)(?![\d])")


def _time(m: re.Match[str]) -> str:
    h, mi, ampm = int(m.group(1)), int(m.group(2)), m.group(3)
    if ampm:
        suffix = "AM" if ampm.lower() == "a" else "PM"
    else:
        suffix = "AM" if h < 12 else "PM"
        h = h % 12 or 12
    minutes = "o'clock" if mi == 0 else (f"oh {_ONES[mi]}" if mi < 10 else _below_100(mi))
    if mi == 0:
        return f"{number_words(h)} {minutes}" + ("" if ampm is None and suffix == "AM" and h != 12 else f" {suffix}")
    return f"{number_words(h)} {minutes} {suffix}"


def _decimal(m: re.Match[str]) -> str:
    return f"{number_words(int(m.group(1)))} point {' '.join(_ONES[int(d)] for d in m.group(2))}"


def _spoken_number(raw: str) -> str:
    raw = raw.replace(",", "")
    whole, _, frac = raw.partition(".")
    return f"{number_words(int(whole))} point {' '.join(_ONES[int(d)] for d in frac)}" if frac else number_words(int(whole))


def _unit(m: re.Match[str]) -> str:
    singular, plural = _UNITS[m.group(2)]
    return f"{_spoken_number(m.group(1))} {singular if m.group(1) == '1' else plural}"


def _money(symbol: str, amount: str) -> str:
    """„$1,882.90“ → „one thousand … dollars and ninety cents“, „$0.98“ → „ninety-eight cents“."""
    singular, plural = _UNITS[symbol]
    whole, _, cents = amount.replace(",", "").partition(".")
    if len(cents) == 2:
        c = int(cents)
        cent_words = f"{number_words(c)} {'cent' if c == 1 else 'cents'}"
        if int(whole) == 0 and c:
            return cent_words
        name = singular if int(whole) == 1 else plural
        return f"{number_words(int(whole))} {name}" + (f" and {cent_words}" if c else "")
    return f"{_spoken_number(amount)} {singular if amount == '1' else plural}"


def _currency(m: re.Match[str]) -> str:
    return _money(m.group(1), m.group(2))


def normalize_en(text: str, *, lexicon: bool = True) -> str:
    """Text → sprechbarer englischer Text."""
    t = text.replace("->", " to ").replace("→", " to ").replace("≈", " about ").replace("~", " about ")
    for rx, rep in _MARKDOWN_RE:
        t = rx.sub(rep, t)
    t = _EMOJI_RE.sub("", t)
    for rx, rep in _ABBREV:
        t = rx.sub(rep, t)
    t = t.replace("&", " and ")
    t = re.sub(r"(?<=\s)\+(?=\s)", "plus", t)
    t = re.sub(r"(?<=\d)\s?km/h\b", " kilometers per hour", t)  # vorher in speak.ts, vor dem „/“-Schritt
    t = re.sub(r"(?<=\w)/(?=\w)", " ", t)
    t = _VERSION_RE.sub(
        lambda m: f"{m.group(1) or 'version'} " + " point ".join(number_words(int(g)) for g in m.groups()[1:] if g is not None),
        t,
    )
    t = _DE_DATE_RE.sub(
        lambda m: f"{_MONTHS[int(m.group(2)) - 1]} {ordinal_words(int(m.group(1)))}, {year_words(int(m.group(3)))}"
        if 1 <= int(m.group(2)) <= 12 and 1 <= int(m.group(1)) <= 31 else m.group(0),
        t,
    )
    t = _ISO_DATE_RE.sub(
        lambda m: f"{_MONTHS[int(m.group(2)) - 1]} {ordinal_words(int(m.group(3)))}, {year_words(int(m.group(1)))}"
        if 1 <= int(m.group(2)) <= 12 and 1 <= int(m.group(3)) <= 31 else m.group(0),
        t,
    )
    t = _TIME_RE.sub(_time, t)
    t = _HOUR_AMPM_RE.sub(lambda m: f"{number_words(int(m.group(1)))} {'AM' if m.group(2).lower() == 'a' else 'PM'}", t)
    t = _DE_BOTH_RE.sub(lambda m: f"{m.group(1).replace('.', ',')}.{m.group(2)}", t)
    t = _DE_MONEY_BEFORE_RE.sub(lambda m: f"{m.group(1)}{m.group(2).replace('.', ',')}", t)
    t = _DE_MONEY_AFTER_RE.sub(lambda m: m.group(1).replace(".", ","), t)
    t = _DE_DECIMAL_RE.sub(r"\1.\2", t)
    t = _DE_THOUSANDS_MULTI_RE.sub(lambda m: m.group(1).replace(".", ","), t)
    t = _DE_MAGNITUDE_RE.sub(lambda m: f" {_DE_MAGNITUDE[m.group(1)]}", t)
    t = _CURRENCY_CODE_RE.sub(lambda m: f"{m.group(1)} {'$' if m.group(2) == 'USD' else '€'}", t)
    t = _CURRENCY_BEFORE_RE.sub(_currency, t)
    t = _CURRENCY_AFTER_RE.sub(lambda m: _money(m.group(2), m.group(1)), t)
    t = _UNIT_RE.sub(_unit, t)
    t = _THOUSANDS_RE.sub(lambda m: number_words(int(m.group(1).replace(",", ""))), t)
    t = _ORDINAL_RE.sub(lambda m: ordinal_words(int(m.group(1))), t)
    t = _YEAR_RE.sub(lambda m: year_words(int(m.group(1))), t)
    t = _RANGE_RE.sub(" to ", t)
    t = _DECIMAL_RE.sub(_decimal, t)
    t = _INT_RE.sub(lambda m: " ".join(_ONES[int(d)] for d in m.group(1)) if len(m.group(1)) > 1 and m.group(1).startswith("0") else number_words(int(m.group(1))), t)
    if lexicon:
        for rx, say in _LEXICON_RE:
            t = rx.sub(say, t)
    return re.sub(r"\s+", " ", t).strip()
