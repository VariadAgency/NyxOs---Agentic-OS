"""deutsche Aussprache — Wörterbuch als Datei, eigenes Wörterbuch je Anfrage, weitere Pocket-Stimmen.

Aufruf (aus infra/nyx-voice):  python3 -m pytest tests/test_r3b.py -q
"""

from __future__ import annotations

import http.client
import json
import shutil
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

from nyx_voice.catalog import DEFAULT_TTS, TTS_VOICES
from nyx_voice import download as dl
from nyx_voice.engines import POCKET_DECODE_STEPS, FakeStreamingTts, FakeTts, pocket_params
from nyx_voice.server import make_handler
from nyx_voice.service import ServiceError, parse_lexicon
from nyx_voice.text_de import LEXICON, LEXICON_FILE, normalize

from tests.test_n3b import service


class LexiconFileTests(unittest.TestCase):
    def test_lexicon_comes_from_json_file(self) -> None:
        data = json.loads(LEXICON_FILE.read_text(encoding="utf-8"))
        self.assertIsInstance(data, list)
        self.assertEqual([(e["word"], e["say"]) for e in data], LEXICON)
        words = [w.lower() for w, _ in LEXICON]
        self.assertEqual(len(words), len(set(words)), "kein Wort doppelt")

    def test_new_tech_words(self) -> None:
        out = normalize("Das Audit lief im Terminal, die Logs sind im Repo, Haiku und OpenRouter antworten.")
        for raw in ("Audit", "Terminal", "Logs", "Repo", "Haiku", "OpenRouter"):
            self.assertNotIn(raw, out, raw)

    def test_german_words_stay(self) -> None:
        # „Agent“ ist auch ein deutsches Wort — bleibt, wie es ist.
        self.assertIn("Agent", normalize("Der Agent läuft."))

    def test_units_without_dot(self) -> None:
        self.assertEqual(normalize("3 Std Pause"), "drei Stunden Pause")
        self.assertEqual(normalize("5 Mio. Nutzer"), "fünf Millionen Nutzer")
        self.assertEqual(normalize("2 Mrd. Tokens"), "zwei Milliarden Tohkens")
        self.assertEqual(normalize("z. B. 40 % und ca. 2 GB"), "zum Beispiel vierzig Prozent und zirka zwei Gigabyte")


class UserLexiconTests(unittest.TestCase):
    def test_extra_wins_over_builtin(self) -> None:
        self.assertIn("Sässchn", normalize("Die Session", extra=[("Session", "Sässchn")]))

    def test_extra_whole_word_case_insensitive(self) -> None:
        out = normalize("Kubernetes und kubernetes, aber nicht Kuberneteser", extra=[("Kubernetes", "Kuberniitis")])
        self.assertEqual(out.count("Kuberniitis"), 2)
        self.assertIn("Kuberneteser", out)

    def test_extra_without_builtin_lexicon(self) -> None:
        self.assertEqual(normalize("Die Session", lexicon=False, extra=[("Die", "Dii")]), "Dii Session")

    def test_parse_lexicon(self) -> None:
        self.assertEqual(parse_lexicon(None), [])
        self.assertEqual(parse_lexicon([{"word": " Kubectl ", "say": "Kjub Kontroll"}]), [("Kubectl", "Kjub Kontroll")])
        for bad in ("x", [{"word": 1, "say": "a"}], [{"word": "a"}], [{"word": "", "say": "a"}], [{"word": "a" * 61, "say": "b"}],
                    [{"word": "a", "say": "b" * 121}], [{"word": "a", "say": "b"}] * 301, [["a", "b"]]):
            with self.assertRaises(ServiceError) as ctx:
                parse_lexicon(bad)
            self.assertEqual(ctx.exception.code, "bad_lexicon")


class SpeakWithLexiconTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.tts = FakeTts()
        self.svc = service(self.tmp, [DEFAULT_TTS], {DEFAULT_TTS: self.tts})

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_speak_uses_extra(self) -> None:
        self.svc.speak("Kubernetes läuft.", None, None, "wav", lexicon_extra=[("Kubernetes", "Kuberniitis")])
        self.assertIn("Kuberniitis", self.tts.texts[-1])

    def test_stream_uses_extra(self) -> None:
        _, chunks = self.svc.speak_stream("Kubernetes läuft.", None, None, threading.Event(), lexicon_extra=[("Kubernetes", "Kuberniitis")])
        list(chunks)
        self.assertIn("Kuberniitis", self.tts.texts[-1])

    def test_http_lexicon_field(self) -> None:
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.svc))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=5)
            body = {"text": "Kubernetes läuft.", "lexicon": [{"word": "Kubernetes", "say": "Kuberniitis"}]}
            conn.request("POST", "/speak?format=wav", json.dumps(body), {"content-type": "application/json"})
            res = conn.getresponse()
            res.read()
            self.assertEqual(res.status, 200)
            self.assertIn("Kuberniitis", self.tts.texts[-1])
            conn.request("POST", "/speak?format=wav", json.dumps({"text": "Hallo", "lexicon": "kaputt"}), {"content-type": "application/json"})
            res = conn.getresponse()
            data = json.loads(res.read())
            self.assertEqual(res.status, 400)
            self.assertEqual(data["error"], "bad_lexicon")
        finally:
            httpd.shutdown()
            httpd.server_close()


class PocketVoicesTests(unittest.TestCase):
    def test_extra_german_pocket_voices_share_model(self) -> None:
        base = TTS_VOICES["pocket-juergen"]
        extra = [s for s in TTS_VOICES.values() if s.engine == "pocket" and s.language == "de" and s.id != "pocket-juergen"]
        self.assertGreaterEqual(len(extra), 2)
        for spec in extra:
            self.assertEqual(spec.pocket_model, base.id, spec.id)
            self.assertNotEqual(spec.archive_dir, base.archive_dir)
            self.assertEqual([f.path for f in spec.files], [f"embeddings/{spec.pocket_voice}.safetensors"])
            self.assertTrue(any(k in spec.license for k in ("CC0", "CC-BY-4.0")), spec.license)
            self.assertNotIn("NC", spec.license)

    def test_streaming_fake_for_extra_voice(self) -> None:
        tmp = Path(tempfile.mkdtemp())
        try:
            vid = next(s.id for s in TTS_VOICES.values() if s.engine == "pocket" and s.language == "de" and s.id != "pocket-juergen")
            eng = FakeStreamingTts()
            svc = service(tmp, [vid, DEFAULT_TTS], {vid: eng, DEFAULT_TTS: FakeTts()}, preferred=vid)
            self.assertEqual(svc.speak("Hallo Welt.", vid, None, "wav")[2]["voice"], vid)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


    def test_extra_voice_download_brings_shared_model(self) -> None:
        calls: list[str] = []
        real = dl._ensure_one
        try:
            dl._ensure_one = lambda root, spec, progress, opener, attempts: calls.append(spec.id) or root / spec.archive_dir
            dl.ensure_model(Path("/nirgends"), TTS_VOICES["pocket-vera"])
        finally:
            dl._ensure_one = real
        self.assertEqual(calls, ["pocket-juergen", "pocket-vera"])


class PocketParamsTests(unittest.TestCase):
    def test_defaults(self) -> None:
        self.assertEqual(pocket_params({}), {"temp": None, "sampler_decode_steps": POCKET_DECODE_STEPS, "noise_clamp": None})

    def test_env_and_bounds(self) -> None:
        self.assertEqual(pocket_params({"NYX_POCKET_TEMP": "0.2", "NYX_POCKET_DECODE_STEPS": "3", "NYX_POCKET_NOISE_CLAMP": "2.5"}),
                         {"temp": 0.2, "sampler_decode_steps": 3, "noise_clamp": 2.5})
        bad = pocket_params({"NYX_POCKET_TEMP": "9", "NYX_POCKET_DECODE_STEPS": "abc", "NYX_POCKET_NOISE_CLAMP": "-1"})
        self.assertEqual(bad, {"temp": None, "sampler_decode_steps": POCKET_DECODE_STEPS, "noise_clamp": None})


if __name__ == "__main__":
    unittest.main()
