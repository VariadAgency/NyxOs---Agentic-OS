"""Audio hinein (webm/ogg/mp4/wav → 16 kHz mono) und hinaus (wav, ogg/opus).

ffmpeg läuft als eigener Prozess (Debian-Paket im Abbild); eine Datei in /tmp statt einer Pipe,
weil mp4 (Safari) seinen Index am Dateiende hat und aus einer Pipe nicht lesbar ist.
WAV mit 16 kHz mono 16 bit (so schickt es das Mess-Skript) geht ohne ffmpeg direkt durch.
"""

from __future__ import annotations

import io
import os
import subprocess
import tempfile
import wave

import numpy as np

SAMPLE_RATE = 16_000
FFMPEG_TIMEOUT_S = 60
# Längste Aufnahme, die umgewandelt wird (25 MB Opus mit niedriger Bitrate wären sonst Stunden → >1 GB
# Samples im Speicher). 30 Min liegen über dem Vertrag (≈ 25 Min).
MAX_AUDIO_S = 30 * 60
# ffmpeg liest NUR die hochgeladene Datei: keine Netz-Adressen, keine Wiedergabelisten (HLS/concat), die
# auf andere Dateien zeigen. Erlaubt sind nur echte Audio-Container (Browser, Telegram, Mess-Skript).
FFMPEG_INPUT_GUARD = [
    "-protocol_whitelist", "file",
    "-format_whitelist", "matroska,webm,ogg,mov,mp4,m4a,wav,mp3,flac,aac",
]


class AudioError(Exception):
    """Die Aufnahme ließ sich nicht lesen (kaputt, leer, unbekanntes Format)."""


def _wav_fast_path(data: bytes) -> np.ndarray | None:
    if not (data[:4] == b"RIFF" and data[8:12] == b"WAVE"):
        return None
    try:
        with wave.open(io.BytesIO(data)) as w:
            if w.getframerate() != SAMPLE_RATE or w.getnchannels() != 1 or w.getsampwidth() != 2:
                return None
            frames = w.readframes(w.getnframes())
    except (wave.Error, EOFError):
        return None
    return np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0


def decode_to_pcm16k(data: bytes, ffmpeg: str = "ffmpeg") -> np.ndarray:
    if not data:
        raise AudioError("leer")
    fast = _wav_fast_path(data)
    if fast is not None:
        return fast
    fd, path = tempfile.mkstemp(prefix="nyx-in-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        proc = subprocess.run(
            [
                ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", *FFMPEG_INPUT_GUARD, "-i", path,
                "-t", str(MAX_AUDIO_S), "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "pipe:1",
            ],
            capture_output=True,
            timeout=FFMPEG_TIMEOUT_S,
            check=False,
        )
    finally:
        os.unlink(path)
    if proc.returncode != 0:
        raise AudioError(proc.stderr.decode("utf-8", "replace")[-300:] or "ffmpeg-Fehler")
    samples = np.frombuffer(proc.stdout, dtype="<f4")
    if samples.size == 0:
        raise AudioError("keine Tonspur")
    return samples


def encode_wav(samples: np.ndarray, sample_rate: int) -> bytes:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def encode_ogg_opus(samples: np.ndarray, sample_rate: int, ffmpeg: str = "ffmpeg") -> bytes:
    """Ogg/Opus, 48 kHz mono, Sprach-Einstellung — genau das Format von Telegram-Sprachnachrichten."""
    proc = subprocess.run(
        [
            ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
            "-f", "f32le", "-ar", str(sample_rate), "-ac", "1", "-i", "pipe:0",
            "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", "-application", "voip", "-f", "ogg", "pipe:1",
        ],
        input=np.asarray(samples, dtype="<f4").tobytes(),
        capture_output=True,
        timeout=FFMPEG_TIMEOUT_S,
        check=False,
    )
    if proc.returncode != 0 or not proc.stdout:
        raise AudioError(proc.stderr.decode("utf-8", "replace")[-300:] or "ffmpeg-Fehler")
    return proc.stdout


def split_long(samples: np.ndarray, max_s: float = 30.0, search_s: float = 8.0) -> list[np.ndarray]:
    """Lange Aufnahmen an leisen Stellen in Stücke ≤ `max_s` teilen (hält den Speicher klein)."""
    max_n = int(max_s * SAMPLE_RATE)
    if samples.size <= max_n:
        return [samples]
    frame = SAMPLE_RATE // 10  # 100 ms
    parts: list[np.ndarray] = []
    start = 0
    while samples.size - start > max_n:
        lo = start + max_n - int(search_s * SAMPLE_RATE)
        hi = start + max_n
        window = samples[lo:hi]
        n_frames = window.size // frame
        energy = np.square(window[: n_frames * frame].reshape(n_frames, frame)).mean(axis=1)
        cut = lo + int(np.argmin(energy)) * frame + frame // 2
        parts.append(samples[start:cut])
        start = cut
    parts.append(samples[start:])
    return parts
