"""R3b · Stimmen importieren: nur Katalog-Stimmen mit geprüfter freier Lizenz, per Kennung oder sherpa-onnx-Adresse;
die Stimme lädt im Hintergrund, steht danach zur Wahl und ist nach einem Neustart wieder da (Liste im Volume)."""

from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path

from nyx_voice.catalog import DEFAULT_TTS, DEFAULT_TTS_VOICES, TTS_VOICES
from nyx_voice.engines import FakeTts
from nyx_voice.service import IMPORTED_FILE, ServiceError, read_imported
from tests.test_n3b import service

URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-de_DE-thorsten-low.tar.bz2"


def wait_ready(svc, voice_id: str) -> None:
    deadline = time.time() + 5
    while time.time() < deadline and svc.voices[voice_id].state != "ready":
        time.sleep(0.01)


class ImportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())

    def make(self):
        return service(self.tmp, [DEFAULT_TTS], {DEFAULT_TTS: FakeTts(), "de_DE-thorsten-low": FakeTts()})

    def test_thorsten_is_a_real_german_voice_and_low_is_importable_not_default(self) -> None:
        self.assertIn("echte deutsche Stimme", TTS_VOICES["de_DE-thorsten-high"].label)
        self.assertIn("de_DE-thorsten-high", DEFAULT_TTS_VOICES)
        self.assertNotIn("de_DE-thorsten-low", DEFAULT_TTS_VOICES)
        self.assertEqual(TTS_VOICES["de_DE-thorsten-low"].license, "Datensatz CC0 (Thorsten-Voice)")
        # Pocket-Stimmen englischer Sprecher nur noch auf Wunsch (importierbar), nicht mehr standardmäßig geladen.
        for v in ("pocket-vera", "pocket-michael", "pocket-marius"):
            self.assertNotIn(v, DEFAULT_TTS_VOICES)

    def test_import_by_url_loads_lists_and_persists(self) -> None:
        svc = self.make()
        listed = {v["id"]: v for v in svc.status()["tts"]["importable"]}
        self.assertFalse(listed["de_DE-thorsten-low"]["installed"])
        out = svc.import_voice(url=URL)
        self.assertEqual(out["id"], "de_DE-thorsten-low")
        self.assertTrue(out["added"])
        wait_ready(svc, "de_DE-thorsten-low")
        self.assertEqual(svc.voices["de_DE-thorsten-low"].state, "ready")
        self.assertIn("de_DE-thorsten-low", [v["id"] for v in svc.status()["tts"]["voices"]])
        _, _, meta = svc.speak("Hallo.", "de_DE-thorsten-low", 1.0, "wav")
        self.assertEqual(meta["voice"], "de_DE-thorsten-low")
        self.assertEqual(read_imported(self.tmp / IMPORTED_FILE), ["de_DE-thorsten-low"])
        # zweites Mal: nichts doppelt
        self.assertFalse(svc.import_voice(voice_id="de_DE-thorsten-low")["added"])
        # Neustart: Stimme ist wieder da
        svc2 = self.make()
        self.assertIn("de_DE-thorsten-low", svc2.voices)

    def test_only_allowlisted_urls_and_catalog_voices(self) -> None:
        svc = self.make()
        bad = [
            "https://evil.example/vits-piper-de_DE-thorsten-low.tar.bz2",
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/../x/vits-piper-de_DE-thorsten-low.tar.bz2",
            "http://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-de_DE-thorsten-low.tar.bz2",
        ]
        for u in bad:
            with self.assertRaises(ServiceError) as e:
                svc.import_voice(url=u)
            self.assertEqual(e.exception.code, "bad_import", u)
        # richtige Form, aber Lizenz nicht frei (pavoque = CC-BY-NC-SA) → abgelehnt
        with self.assertRaises(ServiceError) as e:
            svc.import_voice(url="https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-de_DE-pavoque-low.tar.bz2")
        self.assertEqual(e.exception.code, "not_allowed")
        with self.assertRaises(ServiceError):
            svc.import_voice(voice_id="../../etc")
        self.assertFalse((self.tmp / IMPORTED_FILE).exists())

    def test_broken_imported_file_is_ignored(self) -> None:
        (self.tmp / IMPORTED_FILE).write_text(json.dumps({"voices": ["gibt-es-nicht", 3, "de_DE-thorsten-low"]}))
        self.assertEqual(read_imported(self.tmp / IMPORTED_FILE), ["de_DE-thorsten-low"])
        (self.tmp / IMPORTED_FILE).write_text("{kaputt")
        self.assertEqual(read_imported(self.tmp / IMPORTED_FILE), [])


if __name__ == "__main__":
    unittest.main()
