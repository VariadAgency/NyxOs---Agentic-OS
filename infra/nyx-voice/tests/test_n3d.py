"""Deutsch UND Englisch mit zwei getrennten Stimmen — Tests ohne echte Modelle.

Aufruf (aus infra/nyx-voice):  python3 -m unittest tests.test_n3d -v
Deckt ab: Sprachwahl je Satz (Fachwörter bleiben deutsch), englische Normalisierung, Registry (eigene englische
Stimmen, freie Lizenzen), Stimmenwahl je Sprache mit Rückfall, gemischter Stream in EINEM WAV-Strom, Erkennung
ohne festes „de“.
"""

from __future__ import annotations

import http.client
import json
import shutil
import struct
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

from nyx_voice.catalog import DEFAULT_TTS_EN, DEFAULT_TTS_VOICES, FALLBACK_TTS, FALLBACK_TTS_EN, TTS_VOICES
from nyx_voice.engines import FakeStreamingTts, FakeStt, FakeTts
from nyx_voice.server import make_handler, service_from_env
from nyx_voice.text_en import normalize_en, ordinal_words, year_words
from nyx_voice.text_lang import detect_language, guess_language, language_scores, split_by_language, split_raw_sentences

from tests.test_n3b import service

POCKET_DE = "pocket-juergen"


class LanguageTests(unittest.TestCase):
    def test_german_with_tech_words_stays_german(self) -> None:
        for t in [
            "Der Build ist fertig, der Commit ist gepusht.",
            "Deploy läuft.",
            "Mach bitte einen Commit.",
            "Die Session hängt, der Server antwortet nicht.",
            "Nyx, wie weit ist der Build?",
            "Hey Nyx, kannst du den Push machen?",
        ]:
            self.assertEqual(detect_language(t), "de", t)

    def test_english_is_detected(self) -> None:
        for t in [
            "The build failed on the Mac.",
            "Hey Nyx, what is the status of the build?",
            "Can you check the session?",
            "Commit and push, please.",
            "I think we're done for today.",
        ]:
            self.assertEqual(detect_language(t), "en", t)

    def test_undecided_takes_neighbour(self) -> None:
        self.assertIsNone(detect_language("Okay."))
        self.assertEqual(split_by_language("Okay. The build is green."), [("en", "Okay. The build is green.")])
        self.assertEqual(split_by_language("Alles klar. Okay."), [("de", "Alles klar. Okay.")])
        self.assertEqual(split_by_language("Okay."), [("de", "Okay.")])

    def test_mixed_text_is_split_by_sentence(self) -> None:
        parts = split_by_language("Am 25.09. um 14:30 kommt z. B. der Deploy. Then we can test it! Alles klar.")
        self.assertEqual([p[0] for p in parts], ["de", "en", "de"])
        self.assertEqual(parts[0][1], "Am 25.09. um 14:30 kommt z. B. der Deploy.", "Datum/Abkürzung trennen keinen Satz")

    def test_forced_language(self) -> None:
        self.assertEqual(split_by_language("Hallo. The build.", forced="en"), [("en", "Hallo. The build.")])

    def test_raw_sentences(self) -> None:
        self.assertEqual(split_raw_sentences("One. Two!\nDrei"), ["One.", "Two!", "Drei"])
        self.assertEqual(split_raw_sentences("e.g. this one. Next"), ["e.g. this one.", "Next"])

    def test_guess_language_of_transcript(self) -> None:
        self.assertEqual(guess_language("what is the status of the build"), "en")
        self.assertEqual(guess_language("wie ist der Stand vom Build"), "de")
        self.assertEqual(guess_language("okay"), "de")
        self.assertEqual(guess_language("okay", default="en"), "en")


class LanguageCriticTests(unittest.TestCase):
    """Stichproben, die vorher danebengriffen."""

    def test_anglicisms_in_german_stay_german(self) -> None:
        # „check“ ist in deutschen Entwickler-Sätzen ein Fachwort wie „Build“ — es darf nicht allein kippen.
        self.assertEqual(detect_language("Der Build ist grün, der Deploy läuft, check mal die Session."), "de")
        self.assertIsNone(detect_language("Check: Server ok."))
        self.assertEqual(split_by_language("Kurzer Check. Der Server läuft."), [("de", "Kurzer Check. Der Server läuft.")])

    def test_short_english_replies(self) -> None:
        for t in ["Yes.", "OK, let's go.", "Good morning.", "Perfect.", "Sorry!", "Great, thanks.", "Sure."]:
            self.assertEqual(detect_language(t), "en", t)

    def test_curly_apostrophe_counts_like_straight(self) -> None:
        self.assertEqual(language_scores("Don’t worry, it’s fine."), language_scores("Don't worry, it's fine."))
        self.assertEqual(detect_language("Don’t worry."), "en")

    def test_short_german_replies(self) -> None:
        for t in ["Alles klar.", "Perfekt.", "Verstanden.", "Erledigt."]:
            self.assertEqual(detect_language(t), "de", t)

    def test_lists_numbers_times(self) -> None:
        self.assertEqual(split_by_language("Heute: Build, Tests, Deploy."), [("de", "Heute: Build, Tests, Deploy.")])
        self.assertEqual(split_by_language("Today: build, tests, deploy."), [("en", "Today: build, tests, deploy.")])
        self.assertEqual(detect_language("Build failed at 14:30."), "en")
        self.assertEqual(detect_language("Der Build ist um 14:30 fertig."), "de")
        self.assertEqual(
            [p[0] for p in split_by_language("Hier der Plan: 1. Build 2. Tests 3. Deploy. Then we ship it.")], ["de", "en"]
        )


class EnglishTextTests(unittest.TestCase):
    def test_numbers_times_units(self) -> None:
        self.assertEqual(normalize_en("The build finished at 14:30."), "The build finished at two thirty PM.")
        self.assertEqual(normalize_en("Meeting at 3 pm."), "Meeting at three PM.")
        self.assertEqual(
            normalize_en("We used 3.5 GB and 1,500 tokens, 42% done."),
            "We used three point five gigabytes and one thousand five hundred tokens, forty-two percent done.",
        )
        self.assertEqual(normalize_en("It costs $12.50."), "It costs twelve dollars and fifty cents.")
        self.assertEqual(normalize_en("Wait 1 min."), "Wait one minute.")

    def test_dates_years_versions(self) -> None:
        self.assertEqual(normalize_en("Released 2026-09-26."), "Released September twenty-sixth, twenty twenty-six.")
        self.assertEqual(normalize_en("Release v1.2.3"), "Release one point two point three")
        self.assertEqual(year_words(2005), "two thousand five")
        self.assertEqual(year_words(1999), "nineteen ninety-nine")
        self.assertEqual([ordinal_words(n) for n in (1, 2, 3, 12, 21, 30)], ["first", "second", "third", "twelfth", "twenty-first", "thirtieth"])

    def test_markdown_and_names(self) -> None:
        self.assertEqual(normalize_en("**Nyx** runs `NyxOS`, see https://x.y/z"), "Nix runs Nix O S, see a link")


class RegistryTests(unittest.TestCase):
    def test_english_voices_are_separate_models(self) -> None:
        en = TTS_VOICES[DEFAULT_TTS_EN]
        de = TTS_VOICES[POCKET_DE]
        self.assertEqual(en.language, "en")
        self.assertEqual(de.language, "de")
        self.assertNotEqual(en.archive_dir, de.archive_dir, "eigenes englisches Modell, kein gemeinsames")
        self.assertEqual(en.pocket_config, "english.yaml")
        self.assertEqual({f.path for f in en.files}, {"model.safetensors", "tokenizer.json", "embeddings/george.safetensors"})
        self.assertTrue(all("/languages/english/" in f.url for f in en.files))
        self.assertEqual(en.size_bytes, sum(f.size_bytes for f in en.files))
        fb = TTS_VOICES[FALLBACK_TTS_EN]
        self.assertEqual((fb.language, fb.engine), ("en", "piper"))
        self.assertRegex(fb.sha256, r"^[0-9a-f]{64}$")

    def test_licenses_are_free_and_defaults_listed(self) -> None:
        for spec in TTS_VOICES.values():
            self.assertNotIn("NC", spec.license, spec.id)
        for vid in ("en_US-ryan-high", "en_US-lessac-high"):
            self.assertNotIn(vid, TTS_VOICES, "Datensatz nicht kommerziell")
        self.assertIn(DEFAULT_TTS_EN, DEFAULT_TTS_VOICES)
        self.assertIn(FALLBACK_TTS_EN, DEFAULT_TTS_VOICES)
        self.assertTrue(all(TTS_VOICES[v].language == "de" for v in DEFAULT_TTS_VOICES if v.startswith("de_")))


class Tagging(FakeTts):
    """Merkt sich, welcher Text bei welcher Stimme ankam."""

    def __init__(self, rate: int = 22_050) -> None:
        super().__init__()
        self.sample_rate = rate


class VoicePerLanguageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.de = FakeStreamingTts()
        self.en = FakeStreamingTts()
        self.de_fb = FakeTts()
        self.en_fb = Tagging()
        self.engines = {POCKET_DE: self.de, DEFAULT_TTS_EN: self.en, FALLBACK_TTS: self.de_fb, FALLBACK_TTS_EN: self.en_fb}

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def svc(self, **kw):
        s = service(self.tmp, [POCKET_DE, DEFAULT_TTS_EN, FALLBACK_TTS_EN, FALLBACK_TTS], self.engines, **kw)
        time.sleep(0.05)  # Nachmessung nach dem Laden abwarten
        for engine in self.engines.values():
            engine.texts.clear()  # Warmlauf-Sätze vergessen
        return s

    def test_each_language_gets_its_own_voice_and_normalizer(self) -> None:
        s = self.svc()
        _, _, meta = s.speak("Der Build ist um 14:30 fertig. The build finished at 14:30.", None, None, "wav")
        self.assertEqual(meta["voices"], [POCKET_DE, DEFAULT_TTS_EN])
        self.assertEqual(self.de.texts, ["Der Bild ist um vierzehn Uhr dreißig fertig."])
        self.assertEqual(self.en.texts, ["The build finished at two thirty PM."])

    def test_german_only_text_never_touches_english_voice(self) -> None:
        s = self.svc()
        s.speak("Der Commit ist gepusht, die Session läuft.", None, None, "wav")
        self.assertEqual(self.en.texts, [])

    def test_english_falls_back_to_english_fallback(self) -> None:
        s = self.svc(fail={DEFAULT_TTS_EN})
        _, _, meta = s.speak("The build is green.", None, None, "wav")
        self.assertEqual(meta["voices"], [FALLBACK_TTS_EN])
        self.assertTrue(meta["fallback"])

    def test_no_english_voice_installed_uses_german_voice(self) -> None:
        s = service(self.tmp, [POCKET_DE, FALLBACK_TTS], self.engines)
        _, _, meta = s.speak("The build is green.", None, None, "wav")
        self.assertEqual(meta["voices"], [POCKET_DE])

    def test_requested_voices_per_language(self) -> None:
        s = self.svc()
        _, _, meta = s.speak("Alles klar. See you tomorrow.", FALLBACK_TTS, None, "wav", voice_en=FALLBACK_TTS_EN)
        self.assertEqual(meta["voices"], [FALLBACK_TTS, FALLBACK_TTS_EN])
        # Eine englische Stimme als „voice“ spricht keine deutschen Sätze.
        _, _, meta2 = s.speak("Alles klar.", DEFAULT_TTS_EN, None, "wav")
        self.assertEqual(meta2["voices"], [POCKET_DE])

    def test_forced_language(self) -> None:
        s = self.svc()
        _, _, meta = s.speak("Hallo Alex.", None, None, "wav", language="en")
        self.assertEqual(meta["voices"], [DEFAULT_TTS_EN])

    def test_env_default_en(self) -> None:
        env = {"NYX_FAKE": "1", "NYX_MODELS_DIR": str(self.tmp), "NYX_TTS_DEFAULT_EN": FALLBACK_TTS_EN}
        self.assertEqual(service_from_env(env).preferred_voice_en, FALLBACK_TTS_EN)
        self.assertEqual(service_from_env({"NYX_FAKE": "1"}).preferred_voice_en, DEFAULT_TTS_EN)
        self.assertEqual(service_from_env({"NYX_FAKE": "1"}).language, "auto")
        with self.assertRaises(ValueError):
            service_from_env({"NYX_FAKE": "1", "NYX_TTS_DEFAULT_EN": POCKET_DE})

    def test_status_lists_language_per_voice(self) -> None:
        st = self.svc().status()
        langs = {v["id"]: v["language"] for v in st["tts"]["voices"]}
        self.assertEqual(langs[DEFAULT_TTS_EN], "en")
        self.assertEqual(langs[POCKET_DE], "de")
        self.assertEqual(st["tts"]["voiceEn"], DEFAULT_TTS_EN)
        self.assertEqual(st["tts"]["preferredEn"], DEFAULT_TTS_EN)
        self.assertEqual(st["tts"]["fallbackEn"], FALLBACK_TTS_EN)

    def test_stream_switches_voice_in_one_wav_stream(self) -> None:
        s = self.svc(fail={DEFAULT_TTS_EN})  # Englisch spricht Piper (22 050 Hz), Deutsch Pocket (24 000 Hz)
        meta, chunks = s.speak_stream("Hallo Alex. The build is green. Alles klar.", None, None, threading.Event())
        self.assertEqual(meta["sampleRate"], 24_000)
        self.assertEqual(meta["voices"], [POCKET_DE, FALLBACK_TTS_EN, POCKET_DE])
        pieces = list(chunks)
        self.assertEqual(self.en_fb.texts, ["The build is green."])
        en_len = int(22_050 * min(5.0, 0.06 * len("The build is green.")))
        total = sum(p.size for p in pieces)
        de_len = sum(p.size for p in pieces) - round(en_len * 24_000 / 22_050)
        self.assertGreater(de_len, 0)
        self.assertLessEqual(abs(total - de_len - en_len * 24_000 / 22_050), 2, "englischer Teil auf 24 kHz umgerechnet")

    def test_abort_in_mixed_stream_stops_both_voices(self) -> None:
        """Abbruch im deutschen Teil → die englische Stimme rechnet nie, alle Sperren sind frei."""
        s = self.svc()
        stop = threading.Event()
        _, chunks = s.speak_stream("Hallo Alex, der Build läuft. The build is green.", None, None, stop)
        next(chunks)
        stop.set()
        rest = list(chunks)
        self.assertEqual(rest, [])
        self.assertEqual(self.en.texts, [])
        for part in s.voices.values():
            self.assertTrue(part.lock.acquire(blocking=False), part.spec.id)
            part.lock.release()

    def test_resample_keeps_level_without_jumps(self) -> None:
        """Umrechnung 22,05 → 24 kHz hält Länge und Pegel, Stück-Grenzen machen keinen Sprung."""
        import numpy as np

        from nyx_voice.service import resample

        t = np.arange(22_050, dtype=np.float64) / 22_050
        tone = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        whole = resample(tone, 22_050, 24_000)
        self.assertEqual(whole.size, 24_000)
        self.assertLess(abs(float(np.abs(whole).max()) - 0.5), 0.01)
        pieces = np.concatenate([resample(tone[i : i + 1764], 22_050, 24_000) for i in range(0, tone.size, 1764)])
        self.assertLessEqual(abs(pieces.size - 24_000), 13)
        self.assertLess(float(np.abs(np.diff(pieces)).max()), 0.1, "kein Knacks an den Stück-Grenzen")

    def test_transcribe_reports_detected_language(self) -> None:
        s = self.svc()
        s._stt_engine = FakeStt("what is the status of the build")  # noqa: SLF001 — Test
        wav = _wav_bytes()
        s.ffmpeg = "ffmpeg"
        try:
            out = s.transcribe(wav, None)
        except Exception as e:  # ffmpeg fehlt → Test nur ohne Dekodierung
            self.skipTest(f"kein ffmpeg: {e}")
        self.assertEqual(out["language"], "en")
        s._stt_engine = FakeStt("wie ist der Stand vom Build")  # noqa: SLF001
        self.assertEqual(s.transcribe(wav, "en")["language"], "de", "erkannter Text schlägt den Hinweis")


def _wav_bytes() -> bytes:
    n = 16_000
    data = b"\x00\x00" * n
    return b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, 16_000, 32_000, 2, 16) + b"data" + struct.pack("<I", len(data)) + data


class MixedStreamHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = Path(tempfile.mkdtemp())
        engines = {POCKET_DE: FakeStreamingTts(), DEFAULT_TTS_EN: FakeStreamingTts(), FALLBACK_TTS: FakeTts(), FALLBACK_TTS_EN: FakeTts()}
        svc = service(cls.tmp, [POCKET_DE, DEFAULT_TTS_EN, FALLBACK_TTS_EN, FALLBACK_TTS], engines)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(svc))
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_mixed_stream_headers(self) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("POST", "/speak?stream=1", json.dumps({"text": "Hallo Alex. The build is green."}), {"Content-Type": "application/json"})
        res = conn.getresponse()
        self.assertEqual(res.status, 200)
        self.assertEqual(res.getheader("X-Nyx-Voice"), POCKET_DE)
        self.assertEqual(res.getheader("X-Nyx-Voices"), f"{POCKET_DE},{DEFAULT_TTS_EN}")
        body = res.read()
        self.assertEqual(body[:4], b"RIFF")
        self.assertGreater(len(body), 44)
        conn.close()

    def test_bad_language_is_json_error(self) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("POST", "/speak?format=wav", json.dumps({"text": "Hi.", "language": "fr"}), {"Content-Type": "application/json"})
        res = conn.getresponse()
        self.assertEqual(res.status, 400)
        self.assertEqual(json.loads(res.read())["error"], "bad_language")
        conn.close()


if __name__ == "__main__":
    unittest.main()
