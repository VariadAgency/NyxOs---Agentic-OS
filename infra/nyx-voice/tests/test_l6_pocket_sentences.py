"""Pocket (streamende Stimme) beendete einen Aufruf nach dem ersten langen Satz – der Rest fehlte im Ton.
Die Stimme bekommt deshalb jeden Satz einzeln, im Stream wie im ganzen WAV."""
from __future__ import annotations

import shutil
import tempfile
import threading
import unittest
from pathlib import Path

from nyx_voice.catalog import FALLBACK_TTS
from nyx_voice.engines import FakeStreamingTts, FakeTts

from tests.test_n3b import POCKET, service


class RecordingPocket(FakeStreamingTts):
    def __init__(self) -> None:
        super().__init__(pieces=2)
        self.calls: list[str] = []

    def stream(self, text, speed, stop):
        self.calls.append(text)
        yield from super().stream(text, speed, stop)


LONG = "Claude hat diese Woche eintausendachthunderteinundachtzig Dollar gekostet, das ist deutlich mehr als letzte Woche. Drei Sessions laufen gerade."


class PocketSentenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.pocket = RecordingPocket()
        self.svc = service(self.tmp, [POCKET, FALLBACK_TTS], {POCKET: self.pocket, FALLBACK_TTS: FakeTts()})

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_stream_gets_every_sentence(self) -> None:
        _, chunks = self.svc.speak_stream(LONG, POCKET, None, threading.Event(), language="de")
        list(chunks)
        self.assertGreaterEqual(len(self.pocket.calls), 2)
        self.assertTrue(any("laufen gerade" in c for c in self.pocket.calls))
        self.assertTrue(all(len(c) <= 240 for c in self.pocket.calls))

    def test_whole_wav_gets_every_sentence(self) -> None:
        self.svc.speak(LONG, POCKET, None, "wav", language="de")
        self.assertTrue(any("laufen gerade" in c for c in self.pocket.calls))
        self.assertGreaterEqual(len(self.pocket.calls), 2)


if __name__ == "__main__":
    unittest.main()


class PocketStopTests(unittest.TestCase):
    """Echte Ursache: PocketTts.stream setzte am Ende eines Satzes das gemeinsame Stopp-Signal – jeder
    weitere Satz der Antwort fiel danach still weg."""

    def _engine(self):
        import numpy as np

        from nyx_voice.engines import PocketTts

        class Chunk:
            def __init__(self, n):
                self._a = np.ones(n, dtype=np.float32)

            def detach(self):
                return self

            def cpu(self):
                return self

            def numpy(self):
                return self._a

        class FakeModel:
            def generate_audio_stream(self, voice, text, copy_state, stop):
                for _ in range(3):
                    if stop.is_set():
                        return
                    yield Chunk(10)

        eng = object.__new__(PocketTts)
        eng._model = FakeModel()
        eng._voice = None
        eng._lock = threading.Lock()  # Modell-Sperre (geteiltes Modell)
        eng.sample_rate = 24_000
        return eng

    def test_end_of_sentence_does_not_stop_the_answer(self) -> None:
        eng = self._engine()
        stop = threading.Event()
        first = list(eng.stream("Erster Satz.", 1.0, stop))
        self.assertEqual(len(first), 3)
        self.assertFalse(stop.is_set(), "das Ende eines Satzes darf die ganze Antwort nicht stoppen")
        self.assertEqual(len(list(eng.stream("Zweiter Satz.", 1.0, stop))), 3)

    def test_outside_stop_still_aborts(self) -> None:
        eng = self._engine()
        stop = threading.Event()
        stop.set()
        self.assertEqual(list(eng.stream("Satz.", 1.0, stop)), [])
