"""Die Stimme spricht Ziffern, Beträge, Prozent und Uhrzeiten selbst richtig aus.

Aufruf (aus infra/nyx-voice):  python3 -m unittest tests.test_p4b -v
Hintergrund (ABNAHME-LIVE-5 G17/G27): Das Modell schrieb Zahlen selbst in Worte und verzählte sich
(„neunzigundachtzig Cent“, 63 → „sechsundsiebzig“). Jetzt schreibt Nyx Ziffern; text_de/text_en machen die Wörter.
"""

from __future__ import annotations

import unittest

from nyx_voice.text_de import normalize
from nyx_voice.text_en import normalize_en


def de(text: str) -> str:
    return normalize(text, lexicon=False)


def en(text: str) -> str:
    return normalize_en(text, lexicon=False)


class GermanAmountsTests(unittest.TestCase):
    def test_cents_only(self) -> None:
        self.assertEqual(de("Kostet 0,98 €."), "Kostet achtundneunzig Cent.")
        self.assertEqual(de("Heute 98 Cent."), "Heute achtundneunzig Cent.")
        self.assertEqual(de("Nur $0,05."), "Nur fünf Cent.")

    def test_euro_and_cent(self) -> None:
        self.assertEqual(de("Kostet 12,50 €"), "Kostet zwölf Euro fünfzig")
        self.assertEqual(de("Kostet 1,50 €."), "Kostet ein Euro fünfzig.")
        self.assertEqual(de("Kostet 1,00 €."), "Kostet ein Euro.")
        self.assertEqual(de("Kostet 1 €."), "Kostet ein Euro.")

    def test_dollar_with_thousands(self) -> None:
        self.assertEqual(de("Claude kostet 1.809 $."), "Claude kostet eintausendachthundertneun Dollar.")
        self.assertEqual(
            de("Claude kostet $1.809, Codex $333."),
            "Claude kostet eintausendachthundertneun Dollar, Codex dreihundertdreiunddreißig Dollar.",
        )
        # live: „tausendachthundertzweiundachtzig Dollar neunzigundachtzig Cent“
        self.assertEqual(de("Kosten 1.882,90 $."), "Kosten eintausendachthundertzweiundachtzig Dollar neunzig.")
        self.assertEqual(de("Kosten $1.882,90."), "Kosten eintausendachthundertzweiundachtzig Dollar neunzig.")
        # Englisches Zahlformat im deutschen Satz (beide Trenner → eindeutig)
        self.assertEqual(de("Kosten $1,882.90."), "Kosten eintausendachthundertzweiundachtzig Dollar neunzig.")
        self.assertEqual(de("Etwa 1.810 USD."), "Etwa eintausendachthundertzehn Dollar.")

    def test_percent_and_decimals(self) -> None:
        self.assertEqual(de("12,5 % mehr"), "zwölf Komma fünf Prozent mehr")
        self.assertEqual(de("95 % fertig"), "fünfundneunzig Prozent fertig")
        self.assertEqual(de("1.234,5 GB frei"), "eintausendzweihundertvierunddreißig Komma fünf Gigabyte frei")

    def test_counts_and_times(self) -> None:
        self.assertEqual(de("Es gibt 63 Ideen."), "Es gibt dreiundsechzig Ideen.")
        self.assertEqual(de("Um 14:30 Uhr."), "Um vierzehn Uhr dreißig.")
        self.assertEqual(de("Um 9:05."), "Um neun Uhr fünf.")
        self.assertEqual(de("Um 1:00 Uhr."), "Um ein Uhr.")
        self.assertEqual(de("Seit 0:15."), "Seit null Uhr fünfzehn.")


class EnglishAmountsTests(unittest.TestCase):
    def test_cents_only(self) -> None:
        self.assertEqual(en("It costs $0.98."), "It costs ninety-eight cents.")
        self.assertEqual(en("It costs €0.01."), "It costs one cent.")
        self.assertEqual(en("Only 98 cents."), "Only ninety-eight cents.")

    def test_dollars(self) -> None:
        self.assertEqual(en("Claude cost $1,809."), "Claude cost one thousand eight hundred nine dollars.")
        self.assertEqual(en("Claude cost 1,809 $."), "Claude cost one thousand eight hundred nine dollars.")
        self.assertEqual(en("Claude cost $1,882.90."), "Claude cost one thousand eight hundred eighty-two dollars and ninety cents.")
        self.assertEqual(en("Claude cost 1,882.90 $."), "Claude cost one thousand eight hundred eighty-two dollars and ninety cents.")
        self.assertEqual(en("That is $1.01."), "That is one dollar and one cent.")
        self.assertEqual(en("About 1,810 USD."), "About one thousand eight hundred ten dollars.")

    def test_german_number_format_in_english_sentence(self) -> None:
        # Werkzeuge/Modell schreiben manchmal deutsch formatiert – eindeutige Fälle werden richtig gelesen.
        self.assertEqual(en("Claude cost 1.882,90 $."), "Claude cost one thousand eight hundred eighty-two dollars and ninety cents.")
        self.assertEqual(en("Claude cost $1.809."), "Claude cost one thousand eight hundred nine dollars.")
        self.assertEqual(en("It costs 0,98 €."), "It costs ninety-eight cents.")
        self.assertEqual(en("It is 12,5 % more."), "It is twelve point five percent more.")

    def test_percent_counts_times(self) -> None:
        self.assertEqual(en("12.5% more"), "twelve point five percent more")
        self.assertEqual(en("There are 63 ideas."), "There are sixty-three ideas.")
        self.assertEqual(en("Done at 14:30."), "Done at two thirty PM.")
        self.assertEqual(en("Done at 9:05."), "Done at nine oh five AM.")


class NumberSpeechReviewTest(unittest.TestCase):
    """Jetzt schreibt das Modell Ziffern – auch Daten und deutsch formatierte Zahlen im englischen Satz."""

    def test_german_day_with_month_name(self) -> None:
        self.assertEqual(de("Am 3. Oktober ist Deploy."), "Am dritten Oktober ist Deploy.")
        self.assertEqual(de("Der 1. März war gut."), "Der erste März war gut.")
        self.assertEqual(de("Seit dem 26. September läuft es."), "Seit dem sechsundzwanzigsten September läuft es.")

    def test_german_sample_amounts(self) -> None:
        self.assertEqual(de("Kosten 0,98 €."), "Kosten achtundneunzig Cent.")
        self.assertEqual(de("Kosten 1,50 €."), "Kosten ein Euro fünfzig.")
        self.assertEqual(de("Claude kostet $1.809."), "Claude kostet eintausendachthundertneun Dollar.")
        self.assertEqual(de("Es sind $1,882.90."), "Es sind eintausendachthundertzweiundachtzig Dollar neunzig.")
        self.assertEqual(de("101 Sessions, 21 Ideen, 1.000.000 Tokens."), "einhunderteins Sessions, einundzwanzig Ideen, eine Million Tokens.")

    def test_german_format_in_english_sentence(self) -> None:
        self.assertEqual(en("1.000.000 tokens."), "one million tokens.")
        self.assertEqual(en("1,5 GB free."), "one point five gigabytes free.")
        self.assertEqual(en("3,9 Milliarden tokens."), "three point nine billion tokens.")
        self.assertEqual(en("4 Millionen tokens."), "four million tokens.")
        self.assertEqual(en("On 26.09.2026."), "On September twenty-sixth, twenty twenty-six.")
        # Englisches Format bleibt unangetastet.
        self.assertEqual(en("1,500 tokens."), "one thousand five hundred tokens.")
        self.assertEqual(en("3.9 billion tokens."), "three point nine billion tokens.")

    def test_speed_unit_after_speak_ts_change(self) -> None:
        # speak.ts schreibt Einheiten nicht mehr aus – „km/h“ muss die Stimme selbst können.
        self.assertEqual(de("Tempo 50 km/h."), "Tempo fünfzig Kilometer pro Stunde.")
        self.assertEqual(en("Speed 50 km/h."), "Speed fifty kilometers per hour.")


if __name__ == "__main__":
    unittest.main()
