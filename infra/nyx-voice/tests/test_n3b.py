"""Stimme schneller + natürlicher — Tests ohne echte Modelle (Fake-Motoren, Fake-Download).

Aufruf (aus infra/nyx-voice):  python3 -m unittest tests.test_n3b -v
Deckt ab: deutsche Zahlen/Daten/Uhrzeiten + Aussprache-Wörterbuch, Einzeldatei-Download (Pocket), Wahl der
Standard-Stimme mit automatischem Rückfall, Streaming (`/speak?stream=1`, WAV mit offener Länge).
"""

from __future__ import annotations

import dataclasses
import hashlib
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

from nyx_voice.catalog import DEFAULT_STT, DEFAULT_TTS, DEFAULT_TTS_VOICES, FALLBACK_TTS, TTS_VOICES, RemoteFile
from nyx_voice.download import DownloadError, ensure_model, is_installed
from nyx_voice.engines import FakeStreamingTts, FakeStt, FakeTts, pocket_config, spec_for_folder
from nyx_voice.server import make_handler, service_from_env
from nyx_voice.service import ServiceError, VoiceService
from nyx_voice.text_de import normalize, number_words, split_sentences

POCKET = "pocket-juergen"


class FakeResponse:
    def __init__(self, data: bytes) -> None:
        self._data = data
        self._pos = 0
        self.headers = {"Content-Length": str(len(data))}

    def read(self, n: int = -1) -> bytes:
        chunk = self._data[self._pos : self._pos + (n if n > 0 else len(self._data))]
        self._pos += len(chunk)
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *a) -> None:
        return None


def factory_for(engines: dict[str, object]):
    """tts_factory, das je Stimmen-Ordner einen vorbereiteten Fake-Motor liefert."""

    def make(folder: Path, threads: int):
        return engines[spec_for_folder(folder).id]

    return make


def service(tmp: Path, voices: list[str], engines: dict[str, object], *, preferred: str | None = None, fail: set[str] | None = None, **kw) -> VoiceService:
    fail = fail or set()

    def download(root, spec, progress=None):
        if spec.id in fail:
            raise RuntimeError("Netz weg")
        return root / spec.archive_dir

    svc = VoiceService(
        models_root=tmp,
        stt_id=DEFAULT_STT,
        tts_ids=voices,
        threads=1,
        stt_factory=lambda f, t: FakeStt(),
        tts_factory=factory_for(engines),
        downloader=download,
        preferred_voice=preferred,
        retry_s=60,
        **kw,
    )
    threads = svc.start()
    deadline = time.time() + 5
    while time.time() < deadline and any(p.state not in ("ready", "error") for p in [svc.stt, *svc.voices.values()]):
        time.sleep(0.01)
    del threads
    return svc


class SlowFake(FakeTts):
    """Rechnet „langsamer als Echtzeit“ (für die RTF-Grenze)."""

    def synthesize(self, text: str, speed: float):
        audio = super().synthesize(text, speed)
        time.sleep(audio.size / self.sample_rate * 0.9)
        return audio


# ─────────────────────────── Text ───────────────────────────


class TextTests(unittest.TestCase):
    def test_numbers(self) -> None:
        self.assertEqual(number_words(0), "null")
        self.assertEqual(number_words(21), "einundzwanzig")
        self.assertEqual(number_words(101), "einhunderteins")
        self.assertEqual(number_words(1999), "eintausendneunhundertneunundneunzig")
        self.assertEqual(number_words(2026), "zweitausendsechsundzwanzig")
        self.assertEqual(number_words(1_000_000), "eine Million")

    def test_dates_times_units(self) -> None:
        self.assertEqual(normalize("Am 25.09.2026 um 14:30 Uhr."), "Am fünfundzwanzigsten September zweitausendsechsundzwanzig um vierzehn Uhr dreißig.")
        self.assertEqual(normalize("Heute ist der 3.10."), "Heute ist der dritte Oktober")
        self.assertEqual(normalize("Um 9 Uhr, 12,5 % mehr, 5–10 min."), "Um neun Uhr, zwölf Komma fünf Prozent mehr, fünf bis zehn Minuten.")
        self.assertEqual(normalize("1.024 MB und 3 Tests"), "eintausendvierundzwanzig Megabyte und drei Tests")

    def test_lexicon_for_tech_words(self) -> None:
        out = normalize("NyxOS: Claude und Codex prüfen die Session, den Build und den Commit, dann Deploy auf GitHub.")
        for bad in ("NyxOS", "Claude", "Codex", "Session", "Build", "Commit", "Deploy"):
            self.assertNotIn(bad, out)
        self.assertIn("Nüx O S", out)
        # Nur ganze Wörter: „Builder“/„Sessionplan“ bleiben, „Mail“ in „E-Mail“ ebenso wenig zerstört
        self.assertIn("Builder", normalize("Der Builder"))
        # Kurze Abkürzungen nur in Großbuchstaben
        self.assertEqual(normalize("Die API und ui"), "Die A P I und ui")

    def test_markdown_urls_emoji_are_not_read_aloud(self) -> None:
        self.assertEqual(normalize("**Fertig** ✅ siehe https://example.com/x"), "Fertig siehe ein Link")

    def test_critic_cases(self) -> None:
        self.assertEqual(normalize("1.500 Tokens"), "eintausendfünfhundert Tohkens")
        self.assertEqual(normalize("Im Jahr 1999 und 1999 Dateien"), "Im Jahr neunzehnhundertneunundneunzig und eintausendneunhundertneunundneunzig Dateien")
        self.assertEqual(normalize("Build 1.1.59 ist da."), "Bild eins Punkt eins Punkt neunundfünfzig ist da.")
        self.assertEqual(normalize("Stand 25.09.2026"), "Stand fünfundzwanzigste September zweitausendsechsundzwanzig")
        self.assertEqual(normalize("Am 2026-09-26 geht es los."), "Am sechsundzwanzigsten September zweitausendsechsundzwanzig geht es los.")
        self.assertEqual(normalize("1 Aufgabe, 1 Test, Schritt 1 von 3, 1 h"), "eine Aufgabe, ein Test, Schritt eins von drei, eine Stunde")
        self.assertEqual(normalize("~5 Minuten -> fertig"), "etwa fünf Minuten zu fertig")
        self.assertEqual(normalize("Der Nyx-Tab und die Claude-Session"), "Der Nüx-Täb und die Klohd-Säschn")
        self.assertEqual(normalize("Kostet 12,50 €"), "Kostet zwölf Euro fünfzig")

    def test_lexicon_can_be_switched_off(self) -> None:
        self.assertIn("Session", normalize("Die Session", lexicon=False))

    def test_split_first_sentence_short(self) -> None:
        parts = split_sentences("Alles klar, ich starte die Session. Der Build läuft gerade, ich melde mich, sobald er grün ist.")
        self.assertEqual(parts[0], "Alles klar, ich starte die Session.")
        self.assertEqual(len(parts), 2)
        long_first = split_sentences("Das ist ein sehr langer erster Satz, der weit über neunzig Zeichen hinausgeht, damit der erste Ton trotzdem schnell kommt.")
        self.assertLessEqual(len(long_first[0]), 90)


# ─────────────────────────── Katalog + Download ───────────────────────────


class CatalogTests(unittest.TestCase):
    def test_pocket_is_files_with_checksums_and_free_license(self) -> None:
        spec = TTS_VOICES[POCKET]
        self.assertEqual(spec.engine, "pocket")
        self.assertEqual({f.path for f in spec.files}, {"model.safetensors", "tokenizer.json", "embeddings/juergen.safetensors"})
        for f in spec.files:
            self.assertRegex(f.sha256, r"^[0-9a-f]{64}$")
            self.assertTrue(f.url.startswith("https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/4e1e0a3e"))
        self.assertIn("CC-BY-4.0", spec.license)
        self.assertEqual(spec.size_bytes, sum(f.size_bytes for f in spec.files))

    def test_every_voice_has_label_and_no_noncommercial_voice(self) -> None:
        for spec in TTS_VOICES.values():
            self.assertTrue(spec.label, spec.id)
            self.assertNotIn("NC", spec.license, spec.id)
        self.assertNotIn("de_DE-pavoque-low", TTS_VOICES)
        self.assertEqual(DEFAULT_TTS_VOICES[0], POCKET)
        self.assertIn(FALLBACK_TTS, DEFAULT_TTS_VOICES)
        self.assertEqual(TTS_VOICES["de_DE-thorsten_emotional-medium"].speaker_id, 4)


class FileDownloadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def spec(self, blobs: dict[str, bytes], **over):
        files = tuple(RemoteFile(p, f"https://x/{p}", hashlib.sha256(d).hexdigest(), len(d)) for p, d in blobs.items())
        return dataclasses.replace(TTS_VOICES[POCKET], files=files, size_bytes=sum(len(d) for d in blobs.values()), **over)

    def test_files_are_checked_and_installed_once(self) -> None:
        blobs = {"model.safetensors": b"m" * 5000, "tokenizer.json": b"{}", "embeddings/juergen.safetensors": b"v" * 300}
        spec = self.spec(blobs)
        calls: list[str] = []
        seen: list[tuple[int, int]] = []

        def opener(url):
            calls.append(url)
            return FakeResponse(blobs[url.removeprefix("https://x/")])

        folder = ensure_model(self.tmp, spec, lambda d, t: seen.append((d, t)), opener=opener)
        self.assertEqual((folder / "embeddings" / "juergen.safetensors").read_bytes(), b"v" * 300)
        self.assertTrue(is_installed(self.tmp, spec))
        self.assertEqual(seen[-1], (5302, 5302))
        ensure_model(self.tmp, spec, opener=opener)
        self.assertEqual(len(calls), 3, "zweiter Start lädt nicht erneut")
        self.assertFalse((self.tmp / f".extract-{spec.id}").exists())

    def test_one_wrong_file_leaves_nothing_behind(self) -> None:
        blobs = {"model.safetensors": b"m" * 100, "tokenizer.json": b"{}"}
        spec = self.spec(blobs)
        bad = {"model.safetensors": b"m" * 100, "tokenizer.json": b"[]"}
        with self.assertRaises(DownloadError):
            ensure_model(self.tmp, spec, opener=lambda url: FakeResponse(bad[url.removeprefix("https://x/")]), attempts=1)
        self.assertFalse((self.tmp / spec.archive_dir).exists())
        self.assertFalse((self.tmp / f".extract-{spec.id}").exists())

    def test_oversized_file_is_cut_off(self) -> None:
        spec = self.spec({"model.safetensors": b"m" * 100})
        with self.assertRaises(DownloadError):
            ensure_model(self.tmp, spec, opener=lambda url: FakeResponse(b"m" * 100_000), attempts=1)

    def test_unsafe_paths_in_catalog_are_refused(self) -> None:
        for evil in ("../boese", "/etc/passwd", "a/../../b"):
            spec = dataclasses.replace(TTS_VOICES[POCKET], files=(RemoteFile(evil, "https://x/y", "0" * 64, 1),))
            with self.assertRaises(DownloadError):
                ensure_model(self.tmp, spec, opener=lambda url: FakeResponse(b"x"), attempts=1)
        self.assertFalse((self.tmp.parent / "boese").exists())


class PocketConfigTests(unittest.TestCase):
    def test_config_points_only_to_local_files(self) -> None:
        try:
            import yaml
        except ImportError:
            self.skipTest("pyyaml fehlt")
        tmp = Path(tempfile.mkdtemp())
        try:
            pkg = tmp / "german.yaml"
            pkg.write_text(
                "weights_path: hf://kyutai/pocket-tts/languages/german/model.safetensors@x\n"
                "weights_path_without_voice_cloning: hf://kyutai/pocket-tts-without-voice-cloning/languages/german/model.safetensors@y\n"
                "flow_lm:\n  lookup_table:\n    dim: 1\n    tokenizer: tokenizers\n    tokenizer_path: hf://kyutai/x/tokenizer.json@y\n"
                "mimi:\n  sample_rate: 24000\n"
            )
            folder = tmp / "pocket"
            cfg = pocket_config(pkg, folder, yaml)
            self.assertEqual(cfg["weights_path"], str(folder / "model.safetensors"))
            self.assertEqual(cfg["weights_path_without_voice_cloning"], str(folder / "model.safetensors"))
            self.assertEqual(cfg["flow_lm"]["lookup_table"]["tokenizer_path"], str(folder / "tokenizer.json"))
            self.assertNotIn("hf://", yaml.safe_dump(cfg))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ─────────────────────────── Wahl der Stimme + Rückfall ───────────────────────────


class VoiceChoiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_preferred_voice_speaks_when_ready(self) -> None:
        svc = service(self.tmp, [POCKET, FALLBACK_TTS], {POCKET: FakeStreamingTts(), FALLBACK_TTS: FakeTts()})
        self.assertEqual(svc.effective_voice(), POCKET)
        _, _, meta = svc.speak("Hallo Alex.", None, None, "wav")
        self.assertEqual((meta["voice"], meta["fallback"]), (POCKET, False))
        st = svc.status()
        self.assertEqual(st["tts"]["voice"], POCKET)
        info = {v["id"]: v for v in st["tts"]["voices"]}
        self.assertEqual(info[POCKET]["label"], "Jürgen (natürlich)")
        self.assertEqual(info[POCKET]["engine"], "pocket")
        self.assertTrue(info[POCKET]["streaming"])
        self.assertIsNotNone(info[POCKET]["rtf"])
        self.assertEqual(st["tts"]["fallback"], FALLBACK_TTS)

    def test_falls_back_to_thorsten_medium_when_preferred_fails(self) -> None:
        svc = service(self.tmp, [POCKET, FALLBACK_TTS], {POCKET: FakeStreamingTts(), FALLBACK_TTS: FakeTts()}, fail={POCKET})
        self.assertEqual(svc.voices[POCKET].state, "error")
        self.assertEqual(svc.effective_voice(), FALLBACK_TTS)
        self.assertEqual(svc.status()["tts"]["voice"], FALLBACK_TTS)
        self.assertTrue(svc.status()["tts"]["ready"])
        # auch ausdrücklich gewünscht: Rückfall statt Fehler
        _, _, meta = svc.speak("Hallo.", POCKET, None, "wav")
        self.assertEqual((meta["voice"], meta["fallback"]), (FALLBACK_TTS, True))

    def test_too_slow_voice_is_not_the_default(self) -> None:
        svc = service(self.tmp, [POCKET, FALLBACK_TTS], {POCKET: SlowFake(), FALLBACK_TTS: FakeTts()}, max_default_rtf=0.5)
        self.assertGreater(svc.voices[POCKET].rtf or 0, 0.5)
        self.assertEqual(svc.effective_voice(), FALLBACK_TTS)
        # wählbar bleibt sie trotzdem
        _, _, meta = svc.speak("Hallo.", POCKET, None, "wav")
        self.assertEqual(meta["voice"], POCKET)

    def test_streaming_voice_has_its_own_speed_limit(self) -> None:
        class SlowStreaming(FakeStreamingTts):
            def synthesize(self, text, speed):
                audio = super().synthesize(text, speed)
                time.sleep(audio.size / self.sample_rate * 0.5)
                return audio

        svc = service(self.tmp, [POCKET, FALLBACK_TTS], {POCKET: SlowStreaming(), FALLBACK_TTS: FakeTts()}, max_default_rtf=0.4)
        self.assertGreater(svc.voices[POCKET].rtf or 0, 0.4)
        self.assertEqual(svc.effective_voice(), POCKET, "streamt → Grenze 0,8 statt 0,4")

    def test_preferred_voice_from_setting(self) -> None:
        svc = service(self.tmp, [POCKET, FALLBACK_TTS], {POCKET: FakeStreamingTts(), FALLBACK_TTS: FakeTts()}, preferred=FALLBACK_TTS)
        self.assertEqual(svc.effective_voice(), FALLBACK_TTS)
        with self.assertRaises(ValueError):
            service(self.tmp, [FALLBACK_TTS], {FALLBACK_TTS: FakeTts()}, preferred="gibt-es-nicht")

    def test_speak_uses_spoken_german(self) -> None:
        fake = FakeTts()
        svc = service(self.tmp, [FALLBACK_TTS], {FALLBACK_TTS: fake})
        svc.speak("Die Session um 14:30 Uhr.", None, None, "wav")
        self.assertEqual(fake.texts[-1], "Die Säschn um vierzehn Uhr dreißig.")

    def test_env_default_and_fake_mode(self) -> None:
        svc = service_from_env({"NYX_FAKE": "1", "NYX_MODELS_DIR": str(self.tmp)})
        self.assertEqual(list(svc.voices), DEFAULT_TTS_VOICES)
        self.assertEqual(svc.preferred_voice, POCKET)
        svc2 = service_from_env({"NYX_FAKE": "1", "NYX_TTS_DEFAULT": FALLBACK_TTS, "NYX_TTS_VOICES": f"{POCKET},{FALLBACK_TTS}"})
        self.assertEqual(svc2.preferred_voice, FALLBACK_TTS)
        # Die Rückfall-Stimme ist immer dabei, auch wenn sie in der Liste fehlt.
        svc3 = service_from_env({"NYX_FAKE": "1", "NYX_TTS_VOICES": POCKET})
        self.assertIn(FALLBACK_TTS, svc3.voices)


# ─────────────────────────── Streaming ───────────────────────────


class StreamTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_streaming_engine_yields_pieces(self) -> None:
        eng = FakeStreamingTts(pieces=4)
        svc = service(self.tmp, [POCKET, FALLBACK_TTS], {POCKET: eng, FALLBACK_TTS: FakeTts()})
        meta, chunks = svc.speak_stream("Hallo Alex, alles klar.", None, None, threading.Event())
        self.assertEqual((meta["voice"], meta["sampleRate"]), (POCKET, 24_000))
        self.assertEqual(len(list(chunks)), 4)

    def test_sentence_engine_streams_per_sentence_with_pause(self) -> None:
        fake = FakeTts()
        svc = service(self.tmp, [FALLBACK_TTS], {FALLBACK_TTS: fake})
        meta, chunks = svc.speak_stream("Alles klar. Der Build läuft.", None, None, threading.Event())
        parts = list(chunks)
        self.assertEqual(fake.texts[-2:], ["Alles klar.", "Der Bild läuft."])
        self.assertEqual(len(parts), 3, "Satz, Pause, Satz")
        self.assertTrue((parts[1] == 0).all())

    def test_stop_ends_stream_and_frees_voice(self) -> None:
        eng = FakeStreamingTts(pieces=10)
        svc = service(self.tmp, [POCKET, FALLBACK_TTS], {POCKET: eng, FALLBACK_TTS: FakeTts()})
        stop = threading.Event()
        _, chunks = svc.speak_stream("Hallo.", None, None, stop)
        next(chunks)
        stop.set()
        list(chunks)
        self.assertTrue(eng.stopped)
        self.assertFalse(svc.voices[POCKET].lock.locked())

    def test_validation_before_streaming(self) -> None:
        svc = service(self.tmp, [FALLBACK_TTS], {FALLBACK_TTS: FakeTts()})
        for args, code in [(("", None, None), "bad_text"), (("Hi", "gibt-es-nicht", None), "bad_voice"), (("Hi", None, 9), "bad_speed")]:
            with self.assertRaises(ServiceError) as ctx:
                svc.speak_stream(*args, threading.Event())
            self.assertEqual(ctx.exception.code, code)


class StreamHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = Path(tempfile.mkdtemp())
        cls.eng = FakeStreamingTts(pieces=3, delay_s=0.2)
        cls.svc = service(cls.tmp, [POCKET, FALLBACK_TTS], {POCKET: cls.eng, FALLBACK_TTS: FakeTts()})
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(cls.svc))
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_stream_is_chunked_wav_and_first_sound_comes_early(self) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        t0 = time.perf_counter()
        conn.request("POST", "/speak?stream=1", json.dumps({"text": "Hallo Alex, alles klar."}), {"Content-Type": "application/json"})
        res = conn.getresponse()
        self.assertEqual(res.status, 200)
        self.assertEqual(res.getheader("Transfer-Encoding"), "chunked")
        self.assertEqual(res.getheader("Content-Type"), "audio/wav")
        self.assertEqual(res.getheader("X-Nyx-Voice"), POCKET)
        self.assertEqual(res.getheader("X-Nyx-Sample-Rate"), "24000")
        header = res.read(44)
        self.assertEqual(header[:4], b"RIFF")
        self.assertEqual(header[8:16], b"WAVEfmt ")
        self.assertEqual(struct.unpack("<I", header[24:28])[0], 24_000)
        self.assertEqual(struct.unpack("<I", header[40:44])[0], 0xFFFFFFFF, "Länge offen (Streaming)")
        first = res.read(2)
        first_ms = (time.perf_counter() - t0) * 1000
        rest = res.read()
        total_ms = (time.perf_counter() - t0) * 1000
        self.assertEqual(len(first + rest) % 2, 0)
        self.assertLess(first_ms, total_ms - 250, "erster Ton kommt vor dem Ende der Rechnung")
        conn.close()

    def test_error_before_first_sound_is_json(self) -> None:
        class Broken(FakeStreamingTts):
            def stream(self, text, speed, stop):
                raise RuntimeError("Modell kaputt")
                yield  # pragma: no cover

        tmp = Path(tempfile.mkdtemp())
        try:
            svc = service(tmp, [POCKET, FALLBACK_TTS], {POCKET: Broken(), FALLBACK_TTS: FakeTts()})
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(svc))
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=5)
            conn.request("POST", "/speak?stream=1", json.dumps({"text": "Hallo."}), {"Content-Type": "application/json"})
            res = conn.getresponse()
            self.assertEqual(res.status, 500)
            self.assertEqual(json.loads(res.read())["error"], "failed")
            self.assertFalse(svc.voices[POCKET].lock.locked())
            conn.close()
            httpd.shutdown()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_stream_errors_are_json(self) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("POST", "/speak?stream=1", json.dumps({"text": ""}), {"Content-Type": "application/json"})
        res = conn.getresponse()
        self.assertEqual((res.status, json.loads(res.read())["error"]), (400, "bad_text"))
        conn.close()


if __name__ == "__main__":
    unittest.main()
