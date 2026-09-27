"""Härtung des Stimmen-Dienstes.

1. ffmpeg darf einer Aufnahme nicht „folgen“: eine eingeschleuste Liste (ffconcat, HLS) würde sonst
   andere Dateien im Container bzw. Adressen im Netz öffnen (der Dienst hat ausgehendes Netz für den
   Modell-Download). Neuere ffmpeg lehnen HLS ohne .m3u8 selbst ab, Debian-bookworm (5.1) nicht sicher.
2. Sehr lange Aufnahmen (25 MB Opus mit niedriger Bitrate = Stunden) werden beim Umwandeln auf eine
   Höchstdauer gekürzt, damit der Speicher (4 GB) nicht überläuft.
3. Der Modell-Download bricht ab, sobald mehr kommt als das Paket groß sein darf (volle Platte).
"""

from __future__ import annotations

import dataclasses
import hashlib
import io
import shutil
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

from nyx_voice import audio
from nyx_voice.audio import SAMPLE_RATE, AudioError, decode_to_pcm16k, encode_wav
from nyx_voice.catalog import DEFAULT_TTS, TTS_VOICES
from nyx_voice.download import CHUNK, DownloadError, ensure_model

HAS_FFMPEG = shutil.which("ffmpeg") is not None


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg fehlt")
class FfmpegFollowsNothingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.hits: list[str] = []
        wav = encode_wav(np.full(8000 * 2, 0.3, dtype=np.float32), 8000)
        hits = self.hits

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                hits.append(self.path)
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(wav)))
                self.end_headers()
                self.wfile.write(wav)

            def log_message(self, *args) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.port = self.httpd.server_address[1]
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_hls_playlist_pointing_to_network_is_refused(self) -> None:
        playlist = (
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n"
            f"#EXTINF:2.0,\nhttp://127.0.0.1:{self.port}/geheim.wav\n#EXT-X-ENDLIST\n"
        ).encode()
        with self.assertRaises(AudioError):
            decode_to_pcm16k(playlist)
        self.assertEqual(self.hits, [], "ffmpeg darf keine Adresse aus der Aufnahme aufrufen")

    def test_ffconcat_list_reading_another_file_in_tmp_is_refused(self) -> None:
        # „ffconcat“ erkennt ffmpeg am Inhalt; ohne Sperre liest es eine ANDERE Datei im selben /tmp
        # (dort liegen im Container auch fremde Aufnahmen, die gerade umgewandelt werden).
        secret = Path(tempfile.gettempdir()) / f"nyx-kritik-geheim-{self.port}.wav"
        secret.write_bytes(encode_wav(np.full(8000 * 2, 0.3, dtype=np.float32), 8000))
        try:
            with self.assertRaises(AudioError):
                decode_to_pcm16k(f"ffconcat version 1.0\nfile {secret.name}\n".encode())
        finally:
            secret.unlink(missing_ok=True)

    def test_normal_browser_formats_still_decode(self) -> None:
        # 8 kHz-WAV geht NICHT über den Schnellweg, sondern durch ffmpeg; Ogg/Opus wie Telegram.
        wav8k = encode_wav(np.full(8000, 0.2, dtype=np.float32), 8000)
        self.assertAlmostEqual(decode_to_pcm16k(wav8k).size / SAMPLE_RATE, 1.0, delta=0.05)
        ogg = audio.encode_ogg_opus(np.full(SAMPLE_RATE, 0.2, dtype=np.float32), SAMPLE_RATE)
        self.assertAlmostEqual(decode_to_pcm16k(ogg).size / SAMPLE_RATE, 1.0, delta=0.1)
        # Browser: Chrome/Firefox webm (Opus), Safari mp4 (AAC).
        for ext, codec in (("webm", "libopus"), ("mp4", "aac")):
            out = self.tmp / f"probe.{ext}"
            subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=d=1", "-c:a", codec, "-y", str(out)], check=True)
            self.assertAlmostEqual(decode_to_pcm16k(out.read_bytes()).size / SAMPLE_RATE, 1.0, delta=0.1, msg=ext)

    def test_decode_is_capped_to_max_duration(self) -> None:
        old = audio.MAX_AUDIO_S
        audio.MAX_AUDIO_S = 1
        try:
            wav8k = encode_wav(np.full(8000 * 3, 0.2, dtype=np.float32), 8000)
            self.assertLessEqual(decode_to_pcm16k(wav8k).size, SAMPLE_RATE * 1.05)
        finally:
            audio.MAX_AUDIO_S = old


class CountingResponse(io.BytesIO):
    def __init__(self, data: bytes, content_length: int | None) -> None:
        super().__init__(data)
        self.headers = {} if content_length is None else {"Content-Length": str(content_length)}
        self.bytes_read = 0

    def read(self, n: int = -1) -> bytes:  # type: ignore[override]
        chunk = super().read(n)
        self.bytes_read += len(chunk)
        return chunk


class DownloadSizeCapTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_download_stops_when_more_arrives_than_the_package_may_have(self) -> None:
        size = 64 * 1024
        spec = dataclasses.replace(TTS_VOICES[DEFAULT_TTS], sha256=hashlib.sha256(b"x" * size).hexdigest(), size_bytes=size)
        res = CountingResponse(b"x" * (CHUNK * 20), None)  # Server lügt nicht über die Länge, schickt aber zu viel
        with self.assertRaises(DownloadError):
            ensure_model(self.tmp, spec, opener=lambda url: res, attempts=1)
        self.assertLessEqual(res.bytes_read, size * 2 + CHUNK, "nicht bis zum Ende lesen")

    def test_download_refuses_too_large_content_length_up_front(self) -> None:
        size = 64 * 1024
        spec = dataclasses.replace(TTS_VOICES[DEFAULT_TTS], sha256="0" * 64, size_bytes=size)
        res = CountingResponse(b"x" * size, size * 100)
        with self.assertRaises(DownloadError):
            ensure_model(self.tmp, spec, opener=lambda url: res, attempts=1)
        self.assertEqual(res.bytes_read, 0)


if __name__ == "__main__":
    unittest.main()
