"""Lokales Stimmen-Paket (`nyxos voice install`): Schlüssel auf 127.0.0.1, Standard-Sprache aus der App,
Pocket-Stimmen nur mit PyTorch, Dienst endet mit dem NyxOS-Server."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from nyx_voice.catalog import FALLBACK_TTS, FALLBACK_TTS_EN
from nyx_voice.engines import FakeStt, FakeTts, engine_available
from nyx_voice.server import make_handler
from nyx_voice.service import IMPORTED_FILE, ServiceError, VoiceService

ROOT = Path(__file__).resolve().parents[1]


def make_service(tmp: Path, engine_ok=lambda engine: engine != "pocket") -> VoiceService:
    svc = VoiceService(
        models_root=tmp,
        stt_id="parakeet-tdt-0.6b-v3-int8",
        tts_ids=[FALLBACK_TTS, FALLBACK_TTS_EN],
        threads=1,
        stt_factory=lambda f, t: FakeStt("Hallo Nyx"),
        tts_factory=lambda f, t: FakeTts(),
        downloader=lambda root, spec, progress=None: root / spec.archive_dir,
        engine_ok=engine_ok,
    )
    for t in svc.start():
        t.join(timeout=5)
    return svc


class LocalPackTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_default_language_decides_only_for_undecided_text(self) -> None:
        svc = make_service(self.tmp)
        # „Okay.“ lässt keine Sprache erkennen: die App-Sprache entscheidet.
        self.assertEqual(svc._plan("Okay.", None, None, None, default_language="en")[0][0], FALLBACK_TTS_EN)
        self.assertEqual(svc._plan("Okay.", None, None, None, default_language="de")[0][0], FALLBACK_TTS)
        # Ein klar deutscher Satz bleibt deutsch, auch wenn die App englisch ist.
        self.assertEqual(svc._plan("Das ist jetzt fertig.", None, None, None, default_language="en")[0][0], FALLBACK_TTS)
        with self.assertRaises(ServiceError) as err:
            svc._plan("Okay.", None, None, None, default_language="fr")
        self.assertEqual(err.exception.code, "bad_language")

    def test_pocket_voices_need_pytorch(self) -> None:
        svc = make_service(self.tmp)
        engines = {v["engine"] for v in svc.importable()}
        self.assertNotIn("pocket", engines)
        self.assertIn("piper", engines)
        with self.assertRaises(ServiceError) as err:
            svc.import_voice("pocket-vera")
        self.assertEqual(err.exception.code, "engine_missing")

    def test_previously_imported_pocket_voice_is_skipped_without_pytorch(self) -> None:
        (self.tmp / IMPORTED_FILE).write_text(json.dumps({"voices": ["pocket-vera", "de_DE-thorsten-low"]}), encoding="utf-8")
        svc = make_service(self.tmp)
        self.assertNotIn("pocket-vera", svc.voices)
        self.assertIn("de_DE-thorsten-low", svc.voices)

    def test_engine_available_for_sherpa_engines(self) -> None:
        self.assertTrue(engine_available("piper"))
        self.assertTrue(engine_available("nemo_transducer"))


class TokenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = Path(tempfile.mkdtemp())
        cls.svc = make_service(cls.tmp)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(cls.svc, "geheim-123"))
        cls.httpd.daemon_threads = True
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def call(self, path: str, token: str | None, body: dict | None = None) -> tuple[int, dict | bytes]:
        headers = {"Content-Type": "application/json"}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method="POST" if body is not None else "GET")
        try:
            with urllib.request.urlopen(req, timeout=5) as res:
                raw = res.read()
                return res.status, json.loads(raw) if res.headers.get("Content-Type", "").startswith("application/json") else raw
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_every_path_needs_the_token(self) -> None:
        for token in (None, "falsch", "geheim-12"):
            status, body = self.call("/health", token)
            self.assertEqual(status, 401)
            self.assertEqual(body["error"], "unauthorized")
            status, _ = self.call("/speak?format=wav", token, {"text": "Hallo"})
            self.assertEqual(status, 401)

    def test_right_token_works_and_default_language_reaches_the_service(self) -> None:
        status, body = self.call("/health", "geheim-123")
        self.assertEqual(status, 200)
        self.assertTrue(body["tts"]["ready"])
        status, audio = self.call("/speak?format=wav", "geheim-123", {"text": "Okay.", "defaultLanguage": "en"})
        self.assertEqual(status, 200)
        self.assertTrue(bytes(audio).startswith(b"RIFF"))
        status, body = self.call("/speak?format=wav", "geheim-123", {"text": "Okay.", "defaultLanguage": "xx"})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], "bad_language")


class ParentWatchTests(unittest.TestCase):
    def test_service_ends_when_its_parent_is_gone(self) -> None:
        # Kind (= Dienst) mit Wächter auf einen Eltern-Prozess, der sofort endet: das Kind muss von selbst gehen.
        code = (
            "import os, sys, time\n"
            f"sys.path.insert(0, {str(ROOT)!r})\n"
            "from nyx_voice.server import watch_parent\n"
            "watch_parent(int(sys.argv[1]), interval_s=0.05)\n"
            "time.sleep(10)\n"
            "sys.exit(3)\n"
        )
        # Der Eltern-Prozess startet das Kind mit seiner eigenen PID und endet dann.
        parent = (
            "import os, subprocess, sys\n"
            f"p = subprocess.Popen([sys.executable, '-c', {code!r}, str(os.getpid())])\n"
            "print(p.pid, flush=True)\n"
        )
        out = subprocess.run([sys.executable, "-c", parent], capture_output=True, text=True, timeout=10, check=True)
        child = int(out.stdout.strip())
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                os.kill(child, 0)
            except ProcessLookupError:
                return
            time.sleep(0.05)
        self.fail("Dienst läuft nach dem Ende des NyxOS-Servers weiter")


if __name__ == "__main__":
    unittest.main()
