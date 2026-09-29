"""HTTP-Schnittstelle des Stimmen-Dienstes (nur im internen Netz, ohne Host-Port).

  GET  /health                         → Zustand beider Teile (immer 200, solange der Prozess lebt)
  POST /transcribe?language=de         → Körper = Audio (webm/ogg/mp4/wav) → {text, language, ms, …}
  POST /speak   {text, voice?, voiceEn?, language?, speed?, format?}  → audio/ogg (Opus) oder audio/wav
                (Sprache je Satz, Deutsch mit `voice`, Englisch mit `voiceEn`; language = auto | de | en)
  POST /speak?stream=1 {text, voice?, speed?}     → audio/wav, „chunked“: 44-Byte-Kopf mit offener Länge, dann
                                                    PCM 16 bit mono in Stücken, sobald sie gerechnet sind

Im Server-Modus keine Anmeldung: erreichbar ist der Dienst nur im Netz `nyxos-voice`, in dem außer ihm
nur die API hängt. Die API prüft Anmeldung + CSRF und übersetzt Fehler in einfache Sätze.
Im lokalen Modus (`nyxos voice install`) lauscht er auf 127.0.0.1, wo auch andere Nutzer desselben Rechners
hinkommen: dort setzt NyxOS `NYX_TOKEN`, und jede Anfrage braucht `Authorization: Bearer <NYX_TOKEN>`.
Nur Standardbibliothek (ThreadingHTTPServer) — ein Nutzer, kurze Anfragen, keine Zusatz-Abhängigkeit.
"""

from __future__ import annotations

import hmac
import json
import os
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np

from .catalog import DEFAULT_STT, DEFAULT_TTS_VOICES, FALLBACK_TTS, TTS_VOICES
from .download import ensure_model
from .engines import FakeStreamingTts, FakeStt, FakeTts, SherpaStt, make_tts_engine, spec_for_folder
from .service import MAX_DEFAULT_RTF, MAX_DEFAULT_RTF_STREAMING, ServiceError, VoiceService, parse_lexicon

MAX_BODY_BYTES = 25 * 1024 * 1024
# Länge „unbekannt“ im WAV-Kopf beim Streamen (übliche Konvention, u. a. ffmpeg/Browser lesen das).
WAV_OPEN_LENGTH = 0xFFFFFFFF


def streaming_wav_header(sample_rate: int) -> bytes:
    """44-Byte-WAV-Kopf (PCM 16 bit mono) mit offener Länge — der Ton folgt in Stücken."""
    return b"RIFF" + struct.pack("<I", WAV_OPEN_LENGTH) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16
    ) + b"data" + struct.pack("<I", WAV_OPEN_LENGTH)


def pcm16(samples: np.ndarray) -> bytes:
    return (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def make_handler(service: VoiceService, token: str | None = None) -> type[BaseHTTPRequestHandler]:
    expected = f"Bearer {token}".encode("utf-8") if token else None

    class Handler(BaseHTTPRequestHandler):
        server_version = "nyx-voice/1"
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args) -> None:  # noqa: A002 — Signatur der Basisklasse
            # Kein Inhalt (weder Text noch Audio) ins Log, nur Weg + Status.
            sys.stderr.write(f"nyx-voice {self.command} {urlparse(self.path).path} {args[1] if len(args) > 1 else ''}\n")

        def _send(self, status: int, body: bytes, ctype: str, extra: dict[str, str] | None = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, obj: dict) -> None:
            self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

        def _error(self, e: ServiceError) -> None:
            self._json(e.status, {"error": e.code, "message": e.message})

        def _body(self) -> bytes | None:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY_BYTES:
                self._error(ServiceError("too_large", 413, "Aufnahme größer als 25 MB."))
                self.close_connection = True
                return None
            return self.rfile.read(length) if length > 0 else b""

        def _authorized(self) -> bool:
            """Mit Schlüssel (lokaler Modus): ohne passenden Kopf 401 und Verbindung zu (Körper wird nie gelesen)."""
            if expected is None:
                return True
            got = (self.headers.get("Authorization") or "").encode("utf-8")
            if hmac.compare_digest(got, expected):
                return True
            self.close_connection = True
            self._json(401, {"error": "unauthorized", "message": "Schlüssel fehlt oder ist falsch."})
            return False

        def do_GET(self) -> None:  # noqa: N802
            if not self._authorized():
                return
            if urlparse(self.path).path == "/health":
                self._json(200, service.status())
            else:
                self._json(404, {"error": "not_found", "message": "Unbekannter Weg."})

        def do_POST(self) -> None:  # noqa: N802
            if not self._authorized():
                return
            url = urlparse(self.path)
            body = self._body()
            if body is None:
                return
            try:
                if url.path == "/voices/import":
                    # Stimme zur Laufzeit dazuholen ({"id"} oder {"url"}), lädt im Hintergrund.
                    try:
                        req = json.loads(body.decode("utf-8") or "{}")
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        raise ServiceError("bad_request", 400, "Körper ist kein JSON.") from None
                    if not isinstance(req, dict):
                        raise ServiceError("bad_request", 400, "Körper ist kein JSON-Objekt.")
                    self._json(200, service.import_voice(req.get("id"), req.get("url")))
                elif url.path == "/transcribe":
                    lang = (parse_qs(url.query).get("language") or [None])[0]
                    self._json(200, service.transcribe(body, lang))
                elif url.path == "/speak":
                    try:
                        req = json.loads(body.decode("utf-8") or "{}")
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        raise ServiceError("bad_request", 400, "Körper ist kein JSON.") from None
                    if not isinstance(req, dict):
                        raise ServiceError("bad_request", 400, "Körper ist kein JSON-Objekt.")
                    query = parse_qs(url.query)
                    # `lexicon` = eigene Aussprache-Einträge [{"word", "say"}] (Prüfung vor dem ersten Ton).
                    # `defaultLanguage` = Sprache der App: entscheidet, wenn der Text selbst keine Sprache erkennen lässt.
                    extra = {
                        "voice_en": req.get("voiceEn"),
                        "language": req.get("language"),
                        "lexicon_extra": parse_lexicon(req.get("lexicon")),
                        "default_language": req.get("defaultLanguage"),
                    }
                    if (query.get("stream") or ["0"])[0] in ("1", "true"):
                        self._stream(str(req.get("text") or ""), req.get("voice"), req.get("speed"), extra)
                        return
                    fmt = (query.get("format") or [req.get("format") or "ogg"])[0]
                    audio, ctype, meta = service.speak(str(req.get("text") or ""), req.get("voice"), req.get("speed"), fmt, **extra)
                    self._send(200, audio, ctype, {
                        "X-Nyx-Voice": meta["voice"],
                        "X-Nyx-Voices": ",".join(meta["voices"]),
                        "X-Nyx-Fallback": "1" if meta.get("fallback") else "0",
                        "X-Nyx-Ms": str(meta["ms"]),
                        "X-Nyx-Synth-Ms": str(meta["synthMs"]),
                        "X-Nyx-Audio-Seconds": str(meta["audioSeconds"]),
                    })
                else:
                    self._json(404, {"error": "not_found", "message": "Unbekannter Weg."})
            except ServiceError as e:
                self._error(e)
            except Exception as e:  # noqa: BLE001 — nie ohne Antwort abbrechen
                self._json(500, {"error": "failed", "message": str(e)[:300]})

        def _stream(self, text: str, voice, speed, extra: dict) -> None:
            """Kopf sofort, dann jedes Stück als eigener HTTP-Chunk. Bricht der Leser ab, stoppt die Rechnung."""
            stop = threading.Event()
            meta, chunks = service.speak_stream(text, voice, speed, stop, **extra)  # Fehler hier → JSON (s. do_POST)
            # Erst das erste Stück rechnen, dann den Kopf schicken: Warten auf die Stimme und ein Fehler beim Start
            # kommen so noch als JSON an, und die Start-Frist der API (30 s) umfasst wirklich „bis zum ersten Ton“.
            try:
                first = next(chunks, None)
            except Exception:
                stop.set()
                chunks.close()
                raise
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Nyx-Voice", meta["voice"])
            self.send_header("X-Nyx-Voices", ",".join(meta["voices"]))
            self.send_header("X-Nyx-Fallback", "1" if meta["fallback"] else "0")
            self.send_header("X-Nyx-Sample-Rate", str(meta["sampleRate"]))
            self.send_header("X-Nyx-Streaming", "1" if meta["streaming"] else "0")
            self.end_headers()

            def chunk(data: bytes) -> None:
                if data:
                    self.wfile.write(f"{len(data):X}\r\n".encode("ascii") + data + b"\r\n")
                    self.wfile.flush()

            try:
                chunk(streaming_wav_header(meta["sampleRate"]))
                if first is not None:
                    chunk(pcm16(first))
                for piece in chunks:
                    chunk(pcm16(piece))
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                stop.set()
                self.close_connection = True
            except Exception as e:  # noqa: BLE001 — Kopf ist raus: nur noch abbrechen + protokollieren
                stop.set()
                self.close_connection = True
                sys.stderr.write(f"nyx-voice stream abgebrochen: {str(e)[:200]}\n")
            finally:
                stop.set()
                chunks.close()

    return Handler


def service_from_env(env: dict[str, str]) -> VoiceService:
    # Nur für Probe/Mac-Messung (nie im Compose gesetzt): NYX_FAKE=1 → beide Teile ohne Modell,
    # NYX_FAKE=stt → nur die Erkennung ohne Modell (das große Modell gehört nicht auf den Mac).
    fake_mode = env.get("NYX_FAKE", "")
    fake = {"stt", "tts"} if fake_mode in ("1", "all") else {"stt"} if fake_mode == "stt" else set()
    voices = [v.strip() for v in (env.get("NYX_TTS_VOICES") or ",".join(DEFAULT_TTS_VOICES)).split(",") if v.strip()]
    # Die Rückfall-Stimme (klein, schnell) ist immer geladen — sie springt ein, wenn die gewünschte fehlt.
    if FALLBACK_TTS not in voices:
        voices.append(FALLBACK_TTS)
    preferred = (env.get("NYX_TTS_DEFAULT") or "").strip() or None
    # eigene englische Standard-Stimme (leer = pocket-en-george, sofern geladen). Steht sie nicht in der
    # Liste, wird sie dazugeladen.
    preferred_en = (env.get("NYX_TTS_DEFAULT_EN") or "").strip() or None
    if preferred_en and preferred_en in TTS_VOICES and preferred_en not in voices:
        voices.append(preferred_en)

    def fake_tts(folder, threads):
        spec = spec_for_folder(folder)
        return FakeStreamingTts() if spec.engine == "pocket" else FakeTts()

    def download(root, spec, progress=None):
        if spec.kind in fake:
            return root / spec.archive_dir
        return ensure_model(root, spec, progress)

    return VoiceService(
        models_root=Path(env.get("NYX_MODELS_DIR", "/models")),
        stt_id=env.get("NYX_STT_MODEL", DEFAULT_STT),
        tts_ids=voices,
        threads=int(env.get("NYX_THREADS", "3")),
        stt_factory=(lambda folder, threads: FakeStt()) if "stt" in fake else SherpaStt,
        tts_factory=fake_tts if "tts" in fake else make_tts_engine,
        ffmpeg=env.get("NYX_FFMPEG", "ffmpeg"),
        downloader=download,
        # auto = nie fest auf eine Sprache gezwungen (Parakeet v3 kann Deutsch und Englisch).
        language=(env.get("NYX_LANGUAGE") or "auto").strip().lower(),
        preferred_voice=preferred,
        preferred_voice_en=preferred_en,
        max_default_rtf=float(env.get("NYX_MAX_DEFAULT_RTF") or MAX_DEFAULT_RTF),
        max_default_rtf_streaming=float(env.get("NYX_MAX_DEFAULT_RTF_STREAMING") or MAX_DEFAULT_RTF_STREAMING),
        lexicon=env.get("NYX_LEXICON", "all"),
    )


def watch_parent(parent_pid: int, interval_s: float = 2.0) -> threading.Thread:
    """Lokaler Modus: endet der NyxOS-Server (auch hart, ohne SIGTERM an uns), endet der Dienst mit ihm —
    sonst bliebe ein Waise mit Modellen im Speicher und belegtem Port zurück."""

    def loop() -> None:
        while True:
            time.sleep(interval_s)
            if os.getppid() != parent_pid:
                sys.stderr.write("nyx-voice: NyxOS-Server ist weg, beende\n")
                os._exit(0)

    t = threading.Thread(target=loop, daemon=True, name="parent-watch")
    t.start()
    return t


def main() -> None:
    env = dict(os.environ)
    parent = int(env.get("NYX_PARENT_PID") or 0)
    if parent > 0:
        watch_parent(parent)
    service = service_from_env(env)
    service.start()
    host = env.get("NYX_HOST", "0.0.0.0")
    port = int(env.get("NYX_PORT", "8090"))
    token = (env.get("NYX_TOKEN") or "").strip() or None
    httpd = ThreadingHTTPServer((host, port), make_handler(service, token))
    httpd.daemon_threads = True
    sys.stderr.write(f"nyx-voice lauscht auf {host}:{port} (Modelle: {service.root}{', mit Schlüssel' if token else ''})\n")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
