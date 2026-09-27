"""Tests des Stimmen-Dienstes — ohne echte Modelle (Fake-Motoren, Fake-Download).

Aufruf (aus infra/nyx-voice):  python3 -m unittest discover -s tests -v
Braucht nur numpy; ffmpeg optional (Ogg-Test wird sonst übersprungen).
"""

from __future__ import annotations

import dataclasses
import hashlib
import io
import json
import shutil
import tarfile
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import numpy as np

from nyx_voice.audio import SAMPLE_RATE, encode_wav, split_long
from nyx_voice.catalog import DEFAULT_STT, DEFAULT_TTS, TTS_VOICES
from nyx_voice.download import DownloadError, ensure_model, is_installed
from nyx_voice.engines import FakeStt, FakeTts
from nyx_voice.server import make_handler, service_from_env
from nyx_voice.service import ServiceError, VoiceService


def ready_service(tmp: Path, **kw) -> VoiceService:
    svc = VoiceService(
        models_root=tmp,
        stt_id=DEFAULT_STT,
        tts_ids=[DEFAULT_TTS],
        threads=1,
        stt_factory=lambda f, t: FakeStt("Starte die NyxOS"),
        tts_factory=lambda f, t: FakeTts(),
        downloader=lambda root, spec, progress=None: root / spec.archive_dir,
        **kw,
    )
    for t in svc.start():
        t.join(timeout=5)
    return svc


def wav_bytes(seconds: float) -> bytes:
    return encode_wav(np.zeros(int(SAMPLE_RATE * seconds), dtype=np.float32), SAMPLE_RATE)


class ServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_loading_state_reports_progress_and_refuses_requests(self) -> None:
        gate = threading.Event()

        def slow_download(root, spec, progress=None):
            progress(spec.size_bytes // 4, spec.size_bytes)
            gate.wait(5)
            return root / spec.archive_dir

        svc = VoiceService(self.tmp, DEFAULT_STT, [DEFAULT_TTS], 1, lambda f, t: FakeStt(), lambda f, t: FakeTts(), downloader=slow_download)
        threads = svc.start()
        time.sleep(0.1)
        st = svc.status()
        self.assertEqual(st["stt"]["state"], "downloading")
        self.assertFalse(st["stt"]["ready"])
        self.assertAlmostEqual(st["stt"]["bytesDone"] / st["stt"]["bytesTotal"], 0.25, places=3)
        with self.assertRaises(ServiceError) as ctx:
            svc.transcribe(wav_bytes(1))
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("loading", 503))
        with self.assertRaises(ServiceError) as ctx2:
            svc.speak("Hallo", None, None, "wav")
        self.assertEqual(ctx2.exception.code, "loading")
        gate.set()
        for t in threads:
            t.join(timeout=5)
        self.assertTrue(svc.status()["stt"]["ready"])
        self.assertTrue(svc.status()["tts"]["ready"])

    def test_failed_load_is_error_with_reason_not_a_crash(self) -> None:
        def broken(root, spec, progress=None):
            raise DownloadError("Netz weg")

        svc = VoiceService(self.tmp, DEFAULT_STT, [DEFAULT_TTS], 1, lambda f, t: FakeStt(), lambda f, t: FakeTts(), downloader=broken, retry_s=60)
        svc.start()
        time.sleep(0.2)
        st = svc.status()
        self.assertEqual(st["stt"]["state"], "error")
        self.assertIn("Netz weg", st["stt"]["error"])
        with self.assertRaises(ServiceError) as ctx:
            svc.transcribe(wav_bytes(1))
        self.assertEqual(ctx.exception.code, "error")

    def test_transcribe_wav_fast_path(self) -> None:
        svc = ready_service(self.tmp)
        out = svc.transcribe(wav_bytes(5), None)
        self.assertEqual(out["text"], "Starte die NyxOS")
        self.assertEqual(out["language"], "de")
        self.assertEqual(out["audioSeconds"], 5.0)
        self.assertEqual(out["model"], DEFAULT_STT)
        self.assertGreaterEqual(out["ms"], 0)

    def test_transcribe_rejects_empty_and_garbage(self) -> None:
        svc = ready_service(self.tmp)
        with self.assertRaises(ServiceError) as ctx:
            svc.transcribe(b"")
        self.assertEqual(ctx.exception.code, "empty_audio")
        if shutil.which("ffmpeg"):
            with self.assertRaises(ServiceError) as ctx2:
                svc.transcribe(b"das ist kein audio" * 10)
            self.assertEqual((ctx2.exception.code, ctx2.exception.status), ("bad_audio", 422))

    def test_speak_wav_and_validation(self) -> None:
        svc = ready_service(self.tmp)
        body, ctype, meta = svc.speak("Hallo Alex.", None, 1.2, "wav")
        self.assertEqual(ctype, "audio/wav")
        self.assertEqual(body[:4], b"RIFF")
        self.assertEqual(meta["voice"], DEFAULT_TTS)
        for args, code in [(("", None, None, "wav"), "bad_text"), (("x" * 2001, None, None, "wav"), "text_too_long"), (("Hi", "gibt-es-nicht", None, "wav"), "bad_voice"), (("Hi", None, 5, "wav"), "bad_speed"), (("Hi", None, None, "mp3"), "bad_format")]:
            with self.assertRaises(ServiceError) as ctx:
                svc.speak(*args)
            self.assertEqual(ctx.exception.code, code)

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg fehlt")
    def test_speak_ogg_opus(self) -> None:
        svc = ready_service(self.tmp)
        body, ctype, _ = svc.speak("Hallo.", None, None, "ogg")
        self.assertEqual(ctype, "audio/ogg")
        self.assertEqual(body[:4], b"OggS")
        self.assertIn(b"OpusHead", body[:200])

    def test_env_defaults_and_fake_mode(self) -> None:
        svc = service_from_env({"NYX_FAKE": "1", "NYX_MODELS_DIR": str(self.tmp), "NYX_THREADS": "2"})
        # Standard ist jetzt die natürlichere Stimme (Pocket „juergen“), thorsten-medium der Rückfall.
        self.assertEqual((svc.stt.spec.id, svc.default_voice, svc.fallback_voice, svc.threads), (DEFAULT_STT, "pocket-juergen", DEFAULT_TTS, 2))
        for t in svc.start():
            t.join(timeout=5)
        self.assertTrue(svc.status()["stt"]["ready"] and svc.status()["tts"]["ready"])
        two = service_from_env({"NYX_FAKE": "1", "NYX_TTS_VOICES": "de_DE-thorsten-medium, de_DE-thorsten-high"})
        self.assertEqual(two.default_voice, "de_DE-thorsten-medium")
        self.assertEqual(list(two.voices), ["de_DE-thorsten-medium", "de_DE-thorsten-high"])

    def test_unknown_models_fail_at_start(self) -> None:
        with self.assertRaises(ValueError):
            VoiceService(self.tmp, "gibt-es-nicht", [DEFAULT_TTS], 1, lambda f, t: FakeStt(), lambda f, t: FakeTts())
        with self.assertRaises(ValueError):
            VoiceService(self.tmp, DEFAULT_STT, ["piper1-gpl"], 1, lambda f, t: FakeStt(), lambda f, t: FakeTts())


class SplitTests(unittest.TestCase):
    def test_long_audio_is_cut_at_quiet_points_below_30s(self) -> None:
        loud = np.full(SAMPLE_RATE * 70, 0.5, dtype=np.float32)
        loud[SAMPLE_RATE * 25 : SAMPLE_RATE * 25 + SAMPLE_RATE // 5] = 0.0  # Pause bei 25 s
        parts = split_long(loud)
        self.assertEqual(sum(p.size for p in parts), loud.size)
        self.assertTrue(all(p.size <= SAMPLE_RATE * 30 for p in parts))
        self.assertAlmostEqual(parts[0].size / SAMPLE_RATE, 25.0, delta=0.2)


def fake_archive(dir_name: str, extra: tarfile.TarInfo | None = None) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:bz2") as tar:
        data = b"onnx"
        info = tarfile.TarInfo(f"{dir_name}/model.onnx")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
        if extra is not None:
            tar.addfile(extra, io.BytesIO(b"x" * extra.size))
    return buf.getvalue()


class FakeResponse(io.BytesIO):
    def __init__(self, data: bytes) -> None:
        super().__init__(data)
        self.headers = {"Content-Length": str(len(data))}


class DownloadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.base = TTS_VOICES[DEFAULT_TTS]

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def spec_for(self, data: bytes):
        return dataclasses.replace(self.base, sha256=hashlib.sha256(data).hexdigest(), size_bytes=len(data))

    def test_download_checks_sha_extracts_and_is_idempotent(self) -> None:
        data = fake_archive(self.base.archive_dir)
        spec = self.spec_for(data)
        calls = []
        seen = []

        def opener(url):
            calls.append(url)
            return FakeResponse(data)

        folder = ensure_model(self.tmp, spec, lambda d, t: seen.append((d, t)), opener=opener)
        self.assertTrue((folder / "model.onnx").is_file())
        self.assertTrue(is_installed(self.tmp, spec))
        self.assertEqual(seen[-1], (len(data), len(data)))
        ensure_model(self.tmp, spec, opener=opener)
        self.assertEqual(len(calls), 1, "zweiter Start lädt nicht erneut")
        self.assertFalse((self.tmp / ".partial" / f"{spec.id}.tar.bz2").exists())

    def test_wrong_checksum_never_extracts(self) -> None:
        data = fake_archive(self.base.archive_dir)
        spec = dataclasses.replace(self.spec_for(data), sha256="0" * 64)
        with self.assertRaises(DownloadError):
            ensure_model(self.tmp, spec, opener=lambda url: FakeResponse(data), attempts=1)
        self.assertFalse((self.tmp / spec.archive_dir).exists())

    def test_path_traversal_in_archive_is_refused(self) -> None:
        evil = tarfile.TarInfo("../../boese.txt")
        evil.size = 1
        data = fake_archive(self.base.archive_dir, evil)
        spec = self.spec_for(data)
        with self.assertRaises(DownloadError):
            ensure_model(self.tmp, spec, opener=lambda url: FakeResponse(data), attempts=1)
        self.assertFalse((self.tmp.parent / "boese.txt").exists())


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = Path(tempfile.mkdtemp())
        cls.svc = ready_service(cls.tmp)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(cls.svc))
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def req(self, method: str, path: str, body: bytes | None = None, headers: dict | None = None):
        r = urllib.request.Request(self.base + path, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(r, timeout=5) as res:
                return res.status, dict(res.headers), res.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def test_health(self) -> None:
        status, _, body = self.req("GET", "/health")
        self.assertEqual(status, 200)
        st = json.loads(body)
        self.assertTrue(st["stt"]["ready"] and st["tts"]["ready"])
        self.assertEqual(st["tts"]["voice"], DEFAULT_TTS)

    def test_transcribe_and_speak(self) -> None:
        status, _, body = self.req("POST", "/transcribe?language=de", wav_bytes(2), {"Content-Type": "audio/wav"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["text"], "Starte die NyxOS")
        status, headers, audio = self.req("POST", "/speak?format=wav", json.dumps({"text": "Hallo."}).encode(), {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "audio/wav")
        self.assertEqual(audio[:4], b"RIFF")
        self.assertIn("X-Nyx-Ms", headers)

    def test_errors_are_json_with_code(self) -> None:
        status, _, body = self.req("POST", "/speak", b"kein json", {"Content-Type": "application/json"})
        self.assertEqual((status, json.loads(body)["error"]), (400, "bad_request"))
        status, _, body = self.req("POST", "/speak", json.dumps({"text": "Hi", "voice": "x"}).encode())
        self.assertEqual((status, json.loads(body)["error"]), (400, "bad_voice"))

    def test_too_large_is_refused_before_reading(self) -> None:
        import http.client

        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1], timeout=5)
        conn.putrequest("POST", "/transcribe")
        conn.putheader("Content-Length", str(26 * 1024 * 1024))
        conn.endheaders()
        res = conn.getresponse()
        self.assertEqual(res.status, 413)
        self.assertEqual(json.loads(res.read())["error"], "too_large")
        conn.close()


if __name__ == "__main__":
    unittest.main()
