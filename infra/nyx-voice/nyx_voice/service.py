"""Zustand des Stimmen-Dienstes — Modelle laden im Hintergrund, Anfragen beantworten.

Erkennung (STT) und Sprachausgabe (TTS) laden unabhängig voneinander in eigenen Fäden: die kleine
Stimme ist nach Sekunden bereit, auch wenn das Erkennungs-Modell noch lädt. Scheitert ein Laden
(Netz weg, Prüfsumme falsch), versucht der Faden es nach `retry_s` erneut — der Container bleibt
dabei gesund und sagt über `/health`, was los ist.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

from .audio import SAMPLE_RATE, AudioError, decode_to_pcm16k, encode_ogg_opus, encode_wav
from .catalog import IMPORT_URL_RE, IMPORTABLE_TTS, DEFAULT_TTS_EN, FALLBACK_TTS, FALLBACK_TTS_EN, STT_MODELS, TTS_VOICES, ModelSpec
from .download import ensure_model
from .engines import SttEngine, TtsEngine, engine_available
from .tempo import time_stretch
from .text_de import normalize, split_sentences
from .text_en import normalize_en
from .text_lang import guess_language, split_by_language

LANGUAGES = ("de", "en")

MAX_TEXT_CHARS = 2000
MIN_SPEED = 0.5
MAX_SPEED = 2.0
# Eine Stimme, die beim Warmlauf länger rechnet als 0,4 × Tonlänge, wird nicht automatisch Standard:
# ohne Streaming wartet der erste Satz (≤ 90 Zeichen ≈ 5 s Ton) sonst über 2 s. Wählbar bleibt sie.
MAX_DEFAULT_RTF = 0.4
# Streamende Stimmen (Pocket) spielen schon während der Rechnung: schneller als Echtzeit mit etwas Luft reicht.
MAX_DEFAULT_RTF_STREAMING = 0.8
# Längste Rechnung ohne Stream (Telegram/ogg, ganzer Text): danach wird abgeschnitten statt die Stimme zu blockieren.
SPEAK_MAX_S = 50.0
# Pause zwischen zwei Sätzen beim satzweisen Streamen (Piper): natürlicher Atem, nicht abgehackt.
SENTENCE_PAUSE_S = 0.12
WARMUP_TEXT = "Hallo, ich bin Nyx. Alles ist bereit."
# Warmlauf je Sprache — die englische Stimme misst mit einem englischen Satz.
WARMUP_TEXTS = {"de": WARMUP_TEXT, "en": "Hi, I'm Nyx. Everything is ready."}



def paced(pieces, speed: float, sample_rate: int):
    """Streamende Stimmen (Pocket) haben keinen eigenen Tempo-Regler – `speed` wirkte nie. Bei Tempo ≠ 1
    wird der Satz gesammelt, per WSOLA gestreckt (gleiche Tonhöhe) und in kurzen Stücken weitergegeben."""
    if abs(speed - 1.0) < 0.01:
        yield from pieces
        return
    parts = [np.asarray(p, dtype=np.float32).reshape(-1) for p in pieces]
    if not parts:
        return
    audio = time_stretch(np.concatenate(parts), speed, sample_rate)
    step = max(1, int(sample_rate * 0.25))
    for start in range(0, audio.size, step):
        yield audio[start : start + step]

class ServiceError(Exception):
    def __init__(self, code: str, status: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.message = message


@dataclass
class Part:
    spec: ModelSpec
    state: str = "waiting"  # waiting | downloading | loading | ready | error
    bytes_done: int = 0
    bytes_total: int = 0
    error: str | None = None
    load_ms: int | None = None
    # Rechenzeit/Tonlänge beim Warmlauf (< 1 = schneller als Echtzeit), nur für Stimmen.
    rtf: float | None = None
    streaming: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock)

    def public(self) -> dict:
        out = {
            "id": self.spec.id,
            "state": self.state,
            "ready": self.state == "ready",
            "bytesDone": self.bytes_done,
            "bytesTotal": self.bytes_total or self.spec.size_bytes,
            "error": self.error,
            "loadMs": self.load_ms,
            "license": self.spec.license,
        }
        if self.spec.kind == "tts":
            out.update({
                "label": self.spec.label or self.spec.id,
                "engine": self.spec.engine,
                "rtf": self.rtf,
                "streaming": self.streaming,
                "language": self.spec.language,
            })
        return out


# eigenes Aussprache-Wörterbuch je Anfrage (Einstellungen vom Nutzer, vom Server mitgeschickt).
MAX_LEXICON_ENTRIES = 300
MAX_LEXICON_WORD = 60
MAX_LEXICON_SAY = 120


def parse_lexicon(raw: object) -> list[tuple[str, str]]:
    """JSON-Feld `lexicon` = [{"word": str, "say": str}, …] → [(Wort, Aussprache)]. Fehlt es (None), leer.
    Alles andere als diese Form → ServiceError „bad_lexicon“ (400), bevor irgendetwas gerechnet wird."""
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_LEXICON_ENTRIES:
        raise ServiceError("bad_lexicon", 400, f"Wörterbuch muss eine Liste mit höchstens {MAX_LEXICON_ENTRIES} Einträgen sein.")
    out: list[tuple[str, str]] = []
    for entry in raw:
        word = entry.get("word") if isinstance(entry, dict) else None
        say = entry.get("say") if isinstance(entry, dict) else None
        if not isinstance(word, str) or not isinstance(say, str):
            raise ServiceError("bad_lexicon", 400, "Jeder Wörterbuch-Eintrag braucht „word“ und „say“ als Text.")
        word, say = word.strip(), say.strip()
        if not word or not say or len(word) > MAX_LEXICON_WORD or len(say) > MAX_LEXICON_SAY:
            raise ServiceError("bad_lexicon", 400, f"Wort 1–{MAX_LEXICON_WORD} Zeichen, Aussprache 1–{MAX_LEXICON_SAY} Zeichen.")
        out.append((word, say))
    return out


class VoiceService:
    def __init__(
        self,
        models_root: Path,
        stt_id: str,
        tts_ids: list[str],
        threads: int,
        stt_factory: Callable[[Path, int], SttEngine],
        tts_factory: Callable[[Path, int], TtsEngine],
        ffmpeg: str = "ffmpeg",
        downloader: Callable[..., Path] = ensure_model,
        language: str = "auto",
        retry_s: float = 300.0,
        preferred_voice: str | None = None,
        preferred_voice_en: str | None = None,
        max_default_rtf: float = MAX_DEFAULT_RTF,
        max_default_rtf_streaming: float = MAX_DEFAULT_RTF_STREAMING,
        lexicon: str = "all",
        engine_ok: Callable[[str], bool] = engine_available,
    ) -> None:
        if stt_id not in STT_MODELS:
            raise ValueError(f"unbekanntes Erkennungs-Modell {stt_id} (bekannt: {', '.join(STT_MODELS)})")
        unknown = [v for v in tts_ids if v not in TTS_VOICES]
        if unknown or not tts_ids:
            raise ValueError(f"unbekannte Stimme(n) {unknown} (bekannt: {', '.join(TTS_VOICES)})")
        if preferred_voice and preferred_voice not in tts_ids:
            raise ValueError(f"Standard-Stimme {preferred_voice} ist nicht in der Liste ({', '.join(tts_ids)})")
        if preferred_voice_en and preferred_voice_en not in tts_ids:
            raise ValueError(f"Englische Standard-Stimme {preferred_voice_en} ist nicht in der Liste ({', '.join(tts_ids)})")
        if preferred_voice_en and TTS_VOICES[preferred_voice_en].language != "en":
            raise ValueError(f"{preferred_voice_en} ist keine englische Stimme")
        if language not in ("auto", *LANGUAGES):
            raise ValueError(f"NYX_LANGUAGE muss auto, de oder en sein (nicht {language})")
        self.root = models_root
        self.threads = threads
        self.ffmpeg = ffmpeg
        self.language = language
        self.retry_s = retry_s
        self._stt_factory = stt_factory
        self._tts_factory = tts_factory
        self._download = downloader
        self.stt = Part(STT_MODELS[stt_id])
        self.voices = {v: Part(TTS_VOICES[v]) for v in tts_ids}
        # früher importierte Stimmen (Liste im Volume) kommen beim Start wieder dazu.
        self._imported_file = models_root / IMPORTED_FILE
        self._import_lock = threading.Lock()
        self._started = False
        for v in read_imported(self._imported_file):
            # eine früher importierte Pocket-Stimme ohne PyTorch (lokales Paket) bliebe für immer im Fehler: auslassen.
            if v not in self.voices and engine_ok(TTS_VOICES[v].engine):
                self.voices[v] = Part(TTS_VOICES[v])
        # Gewünschte Standard-Stimme (Einstellung); was wirklich spricht, sagt `effective_voice()`.
        german = [v for v in tts_ids if TTS_VOICES[v].language == "de"] or tts_ids
        english = [v for v in tts_ids if TTS_VOICES[v].language == "en"]
        self.preferred_voice = preferred_voice or german[0]
        self.default_voice = self.preferred_voice  # früherer Name, gleiche Bedeutung
        self.fallback_voice = FALLBACK_TTS if FALLBACK_TTS in self.voices else german[0]
        # Englisch mit eigener Stimme (None = keine englische Stimme geladen → die deutsche liest vor).
        self.preferred_voice_en = preferred_voice_en or (DEFAULT_TTS_EN if DEFAULT_TTS_EN in self.voices else (english[0] if english else None))
        self.fallback_voice_en = FALLBACK_TTS_EN if FALLBACK_TTS_EN in self.voices else (english[-1] if english else None)
        self.max_default_rtf = max_default_rtf
        self.max_default_rtf_streaming = max_default_rtf_streaming
        self.lexicon = lexicon
        self._engine_ok = engine_ok
        self._remeasured = False
        self._remeasure_lock = threading.Lock()
        self._stt_engine: SttEngine | None = None
        self._tts_engines: dict[str, TtsEngine] = {}
        self.started_at = time.time()

    # ─────────────────────────── Laden ───────────────────────────

    def start(self) -> list[threading.Thread]:
        self._started = True
        threads = [threading.Thread(target=self._load_loop, args=(self.stt, self._load_stt), daemon=True, name="stt")]
        for part in self.voices.values():
            threads.append(threading.Thread(target=self._load_loop, args=(part, self._load_tts), daemon=True, name=f"tts-{part.spec.id}"))
        for t in threads:
            t.start()
        return threads

    def _load_loop(self, part: Part, load: Callable[[Part, Path], None]) -> None:
        while part.state != "ready":
            try:
                part.state = "downloading"
                part.error = None

                def progress(done: int, total: int) -> None:
                    part.bytes_done, part.bytes_total = done, total

                folder = self._download(self.root, part.spec, progress)
                part.state = "loading"
                t0 = time.perf_counter()
                load(part, folder)
                part.load_ms = int((time.perf_counter() - t0) * 1000)
                part.state = "ready"
                self._remeasure_when_all_loaded()
            except Exception as e:  # noqa: BLE001 — Zustand „error“ mit Grund, dann später erneut
                part.state = "error"
                part.error = str(e)[:300]
                time.sleep(self.retry_s)

    def _load_stt(self, part: Part, folder: Path) -> None:
        engine = self._stt_factory(folder, self.threads)
        engine.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32))  # Warmlauf: erste echte Anfrage ohne Anlauf
        self._stt_engine = engine

    def _load_tts(self, part: Part, folder: Path) -> None:
        engine = self._tts_factory(folder, self.threads)
        # erster Aufruf baut Zwischenspeicher auf — nicht mitmessen
        engine.synthesize("Hallo." if part.spec.language == "de" else "Hello.", 1.0)
        part.rtf = self._measure(engine, part.spec.language)
        part.streaming = callable(getattr(engine, "stream", None))
        self._tts_engines[part.spec.id] = engine

    @staticmethod
    def _measure(engine: TtsEngine, language: str = "de") -> float | None:
        t0 = time.perf_counter()
        audio = engine.synthesize(WARMUP_TEXTS.get(language, WARMUP_TEXT), 1.0)
        took = time.perf_counter() - t0
        seconds = audio.size / engine.sample_rate if engine.sample_rate else 0
        return round(took / seconds, 3) if seconds > 0 else None

    def _remeasure_when_all_loaded(self) -> None:
        """Beim Start laden alle Teile gleichzeitig — die erste RTF-Messung ist dann zu pessimistisch. Sobald
        nichts mehr lädt, wird jede Stimme einmal in Ruhe nachgemessen (nacheinander, unter ihrer Sperre)."""
        parts = [self.stt, *self.voices.values()]
        if any(p.state != "ready" for p in parts):
            return
        with self._remeasure_lock:
            if self._remeasured:
                return
            self._remeasured = True
        for voice_id, part in self.voices.items():
            engine = self._tts_engines.get(voice_id)
            if engine is None:
                continue
            try:
                with part.lock:
                    part.rtf = self._measure(engine, part.spec.language)
            except Exception:  # noqa: BLE001 — Messung ist nur ein Hinweis, die erste bleibt stehen
                pass

    # ─────────────────────────── Wahl der Stimme ───────────────────────────

    def _usable_as_default(self, voice_id: str) -> bool:
        part = self.voices[voice_id]
        limit = self.max_default_rtf_streaming if part.streaming else self.max_default_rtf
        return part.state == "ready" and voice_id in self._tts_engines and (part.rtf is None or part.rtf <= limit)

    def effective_voice(self, language: str = "de") -> str | None:
        """Wer gerade spricht: die gewünschte Stimme, sonst die Rückfall-Stimme, sonst die erste bereite — je Sprache.
        Für Englisch nur englische Stimmen; ist keine da, None (dann liest die deutsche Stimme vor)."""
        if language == "en":
            order = [v for v in (self.preferred_voice_en, self.fallback_voice_en) if v]
            order += [v for v in self.voices if TTS_VOICES[v].language == "en" and v not in order]
        else:
            order = [self.preferred_voice, self.fallback_voice, *(v for v in self.voices if TTS_VOICES[v].language == "de")]
        for v in order:
            if self._usable_as_default(v):
                return v
        for v in order:
            if v in self._tts_engines:
                return v
        return None

    def _resolve_voice(self, voice: str | None, language: str = "de") -> tuple[str, bool]:
        """(Stimme, Rückfall?) — eine gewünschte, aber (noch) nicht bereite Stimme fällt automatisch zurück.
        Eine Stimme der anderen Sprache spricht diese Sprache nie (kein Deutsch mit der englischen Stimme)."""
        if voice is not None and voice not in self.voices:
            raise ServiceError("bad_voice", 400, f"Stimme {voice} ist nicht installiert.")
        if voice is not None and TTS_VOICES[voice].language != language:
            voice = None
        if voice is not None and voice in self._tts_engines:
            return voice, False
        preferred = self.preferred_voice_en if language == "en" else self.preferred_voice
        effective = self.effective_voice(language)
        if effective is None and language == "en":
            return self._resolve_voice(None, "de")  # keine englische Stimme bereit/installiert: die deutsche liest vor
        if effective is None:
            raise self._not_ready(self.voices[voice or self.preferred_voice])
        return effective, voice is not None or effective != preferred

    def _spoken(self, text: str, voice_id: str, lexicon_extra: list[tuple[str, str]] | None = None) -> str:
        spec = TTS_VOICES[voice_id]
        use = self.lexicon == "all" or (self.lexicon == "piper" and spec.engine == "piper")
        if spec.language == "en":
            return normalize_en(text, lexicon=use) or text
        # eigenes Wörterbuch nur für deutsche Sätze (die Einträge sind deutsche Aussprache-Schreibweisen).
        return normalize(text, lexicon=use, extra=lexicon_extra) or text

    def _plan(
        self,
        text: str,
        voice: str | None,
        voice_en: str | None,
        language: str | None,
        lexicon_extra: list[tuple[str, str]] | None = None,
        default_language: str | None = None,
    ) -> list[tuple[str, str, bool]]:
        """Text → [(Stimme, sprechbarer Text, Rückfall?), …]. Sprache je Satz, jede Sprache mit ihrer eigenen
        Stimme und Normalisierung. Alle Prüfungen passieren hier, also VOR dem ersten Ton.
        `default_language` (Sprache der App) entscheidet nur, wenn der ganze Text keine Sprache erkennen lässt."""
        lang = language or "auto"
        if lang not in ("auto", *LANGUAGES):
            raise ServiceError("bad_language", 400, "Sprache muss auto, de oder en sein.")
        if default_language is not None and default_language not in LANGUAGES:
            raise ServiceError("bad_language", 400, "Standard-Sprache muss de oder en sein.")
        for v in (voice, voice_en):
            if v is not None and v not in self.voices:
                raise ServiceError("bad_voice", 400, f"Stimme {v} ist nicht installiert.")
        default = default_language or (self.language if self.language in LANGUAGES else "de")
        plan: list[tuple[str, str, bool]] = []
        for seg_lang, segment in split_by_language(text, default=default, forced=None if lang == "auto" else lang):
            voice_id, fallback = self._resolve_voice(voice_en if seg_lang == "en" else voice, seg_lang)
            plan.append((voice_id, self._spoken(segment, voice_id, lexicon_extra), fallback))
        return plan

    # ─────────────────────────── Anfragen ───────────────────────────

    def status(self) -> dict:
        effective = self.effective_voice()
        shown = self.voices[effective or self.preferred_voice]
        return {
            "stt": {"model": self.stt.spec.id, "language": self.language, **self.stt.public()},
            "tts": {
                "voice": effective or self.preferred_voice,
                "preferred": self.preferred_voice,
                "fallback": self.fallback_voice,
                "voiceEn": self.effective_voice("en"),
                "preferredEn": self.preferred_voice_en,
                "fallbackEn": self.fallback_voice_en,
                "voices": [p.public() for p in self.voices.values()],
                "importable": self.importable(),
                **shown.public(),
            },
            "threads": self.threads,
            "uptimeS": int(time.time() - self.started_at),
        }

    # ─────────────────────────── Stimmen importieren ───────────────────────────

    def importable(self) -> list[dict]:
        """Katalog-Stimmen mit geprüfter Lizenz, die man zur Laufzeit dazuholen kann (installierte markiert)."""
        return [
            {
                "id": v,
                "label": TTS_VOICES[v].label or v,
                "language": TTS_VOICES[v].language,
                "engine": TTS_VOICES[v].engine,
                "license": TTS_VOICES[v].license,
                "sizeBytes": TTS_VOICES[v].size_bytes,
                "installed": v in self.voices,
            }
            for v in IMPORTABLE_TTS
            if self._engine_ok(TTS_VOICES[v].engine)
        ]

    def import_voice(self, voice_id: str | None = None, url: str | None = None) -> dict:
        """Stimme zur Laufzeit dazuholen: per Katalog-Kennung oder per sherpa-onnx-Paket-Adresse (nur Katalog, weil
        nur dort Prüfsumme + Lizenz bekannt sind). Lädt im Hintergrund (Download mit SHA-256, sicheres Entpacken in
        download.py) und merkt sich die Stimme im Volume, damit sie nach einem Neustart wieder da ist."""
        if url is not None:
            if not isinstance(url, str) or len(url) > 300:
                raise ServiceError("bad_import", 400, "Adresse fehlt oder ist zu lang.")
            m = re.match(IMPORT_URL_RE, url.strip())
            if not m:
                raise ServiceError("bad_import", 400, "Nur Piper-Pakete von github.com/k2-fsa/sherpa-onnx (tts-models, vits-piper-….tar.bz2).")
            voice_id = m.group(1)
            if voice_id not in TTS_VOICES or TTS_VOICES[voice_id].url != url.strip():
                raise ServiceError("not_allowed", 400, f"{voice_id} steht nicht in der Liste der Stimmen mit geprüfter freier Lizenz.")
        if not isinstance(voice_id, str) or voice_id not in IMPORTABLE_TTS:
            raise ServiceError("not_allowed", 400, "Diese Stimme gibt es nicht in der Liste der Stimmen mit geprüfter freier Lizenz.")
        if not self._engine_ok(TTS_VOICES[voice_id].engine):
            raise ServiceError("engine_missing", 400, f"{voice_id} braucht ein Zusatzpaket ({TTS_VOICES[voice_id].engine}), das hier nicht installiert ist.")
        with self._import_lock:
            fresh = voice_id not in self.voices
            if fresh:
                part = Part(TTS_VOICES[voice_id])
                self.voices[voice_id] = part
                write_imported(self._imported_file, [*read_imported(self._imported_file), voice_id])
                if self._started:
                    threading.Thread(target=self._load_loop, args=(part, self._load_tts), daemon=True, name=f"tts-{voice_id}").start()
        return {"id": voice_id, "added": fresh, **self.voices[voice_id].public()}

    def _not_ready(self, part: Part) -> ServiceError:
        if part.state == "error":
            return ServiceError("error", 503, f"{part.spec.id} konnte nicht geladen werden: {part.error}")
        return ServiceError("loading", 503, f"{part.spec.id} lädt noch ({part.state})")

    def transcribe(self, data: bytes, language: str | None = None) -> dict:
        engine = self._stt_engine
        if engine is None:
            raise self._not_ready(self.stt)
        if not data:
            raise ServiceError("empty_audio", 400, "Die Aufnahme ist leer.")
        t0 = time.perf_counter()
        try:
            samples = decode_to_pcm16k(data, self.ffmpeg)
        except AudioError as e:
            raise ServiceError("bad_audio", 422, f"Aufnahme nicht lesbar: {e}") from e
        t_decode = time.perf_counter()
        with self.stt.lock:
            text = engine.transcribe(samples)
        t1 = time.perf_counter()
        # Parakeet v3 erkennt Deutsch UND Englisch ohne Vorgabe. Die Sprache kommt aus dem erkannten Text; ein
        # Hinweis (Anfrage bzw. NYX_LANGUAGE) entscheidet nur, wenn der Text unentschieden ist („Okay“).
        hint = language if language in LANGUAGES else (self.language if self.language in LANGUAGES else "de")
        return {
            "text": text.strip(),
            "language": guess_language(text, default=hint),
            "ms": int((t1 - t0) * 1000),
            "decodeMs": int((t_decode - t0) * 1000),
            "audioSeconds": round(samples.size / SAMPLE_RATE, 2),
            "model": self.stt.spec.id,
        }

    def _check(self, text: str | None, speed: float | None) -> tuple[str, float]:
        text = (text or "").strip()
        if not text:
            raise ServiceError("bad_text", 400, "Kein Text zum Sprechen.")
        if len(text) > MAX_TEXT_CHARS:
            raise ServiceError("text_too_long", 413, f"Text länger als {MAX_TEXT_CHARS} Zeichen.")
        try:
            spd = 1.0 if speed is None else float(speed)
        except (TypeError, ValueError):
            raise ServiceError("bad_speed", 400, "Tempo ist keine Zahl.") from None
        if not (MIN_SPEED <= spd <= MAX_SPEED):
            raise ServiceError("bad_speed", 400, f"Tempo muss zwischen {MIN_SPEED} und {MAX_SPEED} liegen.")
        return text, spd

    def speak(
        self,
        text: str,
        voice: str | None,
        speed: float | None,
        fmt: str,
        *,
        voice_en: str | None = None,
        language: str | None = None,
        lexicon_extra: list[tuple[str, str]] | None = None,
        default_language: str | None = None,
    ) -> tuple[bytes, str, dict]:
        text, spd = self._check(text, speed)
        if fmt not in ("ogg", "wav"):
            raise ServiceError("bad_format", 400, "Format muss ogg oder wav sein.")
        plan = self._plan(text, voice, voice_en, language, lexicon_extra, default_language)
        rate = int(self._tts_engines[plan[0][0]].sample_rate)
        t0 = time.perf_counter()
        pieces: list[np.ndarray] = []
        stop = threading.Event()
        # Streamende Stimme ohne Stream-Aufruf (Telegram, ganzer Text): mit Zeitgrenze, damit ein sehr langer Text die
        # Stimme nicht über das Zeitlimit der API hinaus blockiert.
        timer = threading.Timer(SPEAK_MAX_S, stop.set)
        timer.start()
        try:
            for voice_id, spoken, _ in plan:
                if stop.is_set():
                    break
                engine = self._tts_engines[voice_id]
                with self.voices[voice_id].lock:
                    stream = getattr(engine, "stream", None)
                    if callable(stream):
                        # Pocket beendet einen Aufruf nach dem ersten langen Satz – deshalb Satz für Satz.
                        audio: list[np.ndarray] = []
                        pause = np.zeros(int(int(engine.sample_rate) * SENTENCE_PAUSE_S), dtype=np.float32)
                        for i, sentence in enumerate(split_sentences(spoken)):
                            if stop.is_set():
                                break
                            if i:
                                audio.append(pause)
                            audio.extend(np.asarray(p, dtype=np.float32) for p in paced(stream(sentence, spd, stop), spd, int(engine.sample_rate)))
                        samples = np.concatenate(audio) if audio else np.zeros(0, dtype=np.float32)
                    else:
                        samples = np.asarray(engine.synthesize(spoken, spd), dtype=np.float32)
                if pieces:
                    pieces.append(np.zeros(int(rate * SENTENCE_PAUSE_S), dtype=np.float32))
                pieces.append(resample(samples, int(engine.sample_rate), rate))
        finally:
            timer.cancel()
        samples = np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)
        t_synth = time.perf_counter()
        if fmt == "wav":
            body, ctype = encode_wav(samples, rate), "audio/wav"
        else:
            body, ctype = encode_ogg_opus(samples, rate, self.ffmpeg), "audio/ogg"
        t1 = time.perf_counter()
        meta = {
            "voice": plan[0][0],
            "voices": [p[0] for p in plan],
            "fallback": any(p[2] for p in plan),
            "ms": int((t1 - t0) * 1000),
            "synthMs": int((t_synth - t0) * 1000),
            "audioSeconds": round(samples.size / rate, 2),
        }
        return body, ctype, meta

    def speak_stream(
        self,
        text: str,
        voice: str | None,
        speed: float | None,
        stop: threading.Event,
        *,
        voice_en: str | None = None,
        language: str | None = None,
        lexicon_extra: list[tuple[str, str]] | None = None,
        default_language: str | None = None,
    ) -> tuple[dict, Iterator[np.ndarray]]:
        """Ton stückweise, sobald er fertig ist. Prüfung + Wahl der Stimmen passieren SOFORT (Fehler kommen
        als ServiceError vor dem ersten Byte); die Rechnung läuft erst beim Lesen der Stücke. Stimmen mit eigenem
        Streaming (Pocket) liefern Rahmen-Stücke, die anderen Satz für Satz mit kurzer Atem-Pause.
        Wechselt die Sprache, wechselt die Stimme — alles in EINEM Strom mit der Abtastrate der ersten Stimme
        (andere Raten werden umgerechnet). `stop` beendet die Rechnung; die Sperre jeder Stimme wird immer frei."""
        text, spd = self._check(text, speed)
        plan = self._plan(text, voice, voice_en, language, lexicon_extra, default_language)
        first = plan[0][0]
        rate = int(self._tts_engines[first].sample_rate)
        meta = {
            "voice": first,
            "voices": [p[0] for p in plan],
            "fallback": any(p[2] for p in plan),
            "sampleRate": rate,
            "streaming": self.voices[first].streaming,
        }
        pause = np.zeros(int(rate * SENTENCE_PAUSE_S), dtype=np.float32)

        def chunks() -> Iterator[np.ndarray]:
            for index, (voice_id, spoken, _) in enumerate(plan):
                if stop.is_set():
                    return
                if index:
                    yield pause
                engine = self._tts_engines[voice_id]
                src = int(engine.sample_rate)
                with self.voices[voice_id].lock:
                    stream = getattr(engine, "stream", None)
                    if callable(stream):
                        # Pocket beendet einen Aufruf nach dem ersten langen Satz – deshalb Satz für Satz.
                        for i, sentence in enumerate(split_sentences(spoken)):
                            if stop.is_set():
                                return
                            if i:
                                yield pause
                            for piece in paced(stream(sentence, spd, stop), spd, src):
                                if stop.is_set():
                                    return
                                yield resample(np.asarray(piece, dtype=np.float32), src, rate)
                        continue
                    for i, sentence in enumerate(split_sentences(spoken)):
                        if stop.is_set():
                            return
                        if i:
                            yield pause
                        yield resample(np.asarray(engine.synthesize(sentence, spd), dtype=np.float32), src, rate)

        return meta, chunks()


IMPORTED_FILE = "imported-voices.json"


def read_imported(path: Path) -> list[str]:
    """Liste importierter Stimmen aus dem Volume; Unbekanntes/Kaputtes wird still übergangen (nie Absturz beim Start)."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    ids = data.get("voices") if isinstance(data, dict) else None
    return [v for v in ids if isinstance(v, str) and v in IMPORTABLE_TTS] if isinstance(ids, list) else []


def write_imported(path: Path, ids: list[str]) -> None:
    """Atomar schreiben (erst Zwischendatei, dann umbenennen) — ein Absturz lässt nie eine halbe Datei zurück."""
    path.parent.mkdir(parents=True, exist_ok=True)
    unique = list(dict.fromkeys(ids))
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"voices": unique}, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def resample(samples: np.ndarray, src: int, dst: int) -> np.ndarray:
    """Abtastrate umrechnen (linear) — nur beim Stimmwechsel zwischen z. B. Piper (22,05 kHz) und Pocket
    (24 kHz), damit ein WAV-Strom durchgehend EINE Rate hat. Gleiche Rate: unverändert."""
    if src == dst or samples.size == 0:
        return samples
    n = int(round(samples.size * dst / src))
    if n <= 0:
        return np.zeros(0, dtype=np.float32)
    x_new = np.linspace(0.0, samples.size - 1, n, dtype=np.float64)
    return np.interp(x_new, np.arange(samples.size, dtype=np.float64), samples).astype(np.float32)
