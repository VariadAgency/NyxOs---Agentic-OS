"""Tempo-Regler wirkt auch bei Stimmen ohne eigenes Tempo (Pocket) – Länge ändert sich, Tonhöhe nicht."""

import numpy as np

from nyx_voice.tempo import time_stretch

SR = 24000


def tone(freq: float, seconds: float) -> np.ndarray:
    t = np.arange(int(SR * seconds)) / SR
    return (0.5 * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def dominant(x: np.ndarray) -> float:
    spec = np.abs(np.fft.rfft(x * np.hanning(x.size)))
    return float(np.fft.rfftfreq(x.size, 1 / SR)[int(np.argmax(spec))])


def test_faster_is_shorter_same_pitch():
    x = tone(220.0, 2.0)
    y = time_stretch(x, 1.3, SR)
    assert abs(y.size - x.size / 1.3) < SR * 0.02
    assert abs(dominant(y) - 220.0) < 5


def test_slower_is_longer_same_pitch():
    x = tone(300.0, 1.5)
    y = time_stretch(x, 0.8, SR)
    assert abs(y.size - x.size / 0.8) < SR * 0.02
    assert abs(dominant(y) - 300.0) < 5


def test_speed_one_and_short_audio_unchanged():
    x = tone(200.0, 1.0)
    assert time_stretch(x, 1.0, SR) is not None and time_stretch(x, 1.0, SR).size == x.size
    short = tone(200.0, 0.01)
    assert time_stretch(short, 1.5, SR).size == short.size


def test_no_clipping_or_nan():
    x = tone(180.0, 1.0)
    y = time_stretch(x, 1.15, SR)
    assert np.isfinite(y).all()
    assert np.max(np.abs(y)) <= 0.51


def test_pocket_stream_and_wav_get_faster_with_speed():
    """Streamende Stimme (wie Pocket, ignoriert `speed`): der Dienst streckt selbst – Tempo 1,3 → deutlich kürzer."""
    import shutil
    import tempfile
    import threading
    from pathlib import Path

    from nyx_voice.catalog import FALLBACK_TTS
    from nyx_voice.engines import FakeStreamingTts, FakeTts

    from tests.test_n3b import POCKET, service

    tmp = Path(tempfile.mkdtemp())
    try:
        svc = service(tmp, [POCKET, FALLBACK_TTS], {POCKET: FakeStreamingTts(pieces=6), FALLBACK_TTS: FakeTts()})
        text = "Heute laufen drei Sessions und zwei Aufträge warten auf dich."

        def streamed(speed):
            _, chunks = svc.speak_stream(text, POCKET, speed, threading.Event(), language="de")
            return sum(np.asarray(c).size for c in chunks)

        normal, fast = streamed(1.0), streamed(1.3)
        assert fast < normal * 0.85
        _, _, meta_normal = svc.speak(text, POCKET, 1.0, "wav", language="de")
        _, _, meta_fast = svc.speak(text, POCKET, 1.3, "wav", language="de")
        assert meta_fast["audioSeconds"] < meta_normal["audioSeconds"] * 0.85
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
