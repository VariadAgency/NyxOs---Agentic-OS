"""Tempo ohne Tonhöhen-Änderung (WSOLA) für Stimmen ohne eigenen Tempo-Regler (Pocket).

Der Nutzer stellte das Tempo höher, „Jürgen“ blieb gleich schnell: Pocket kennt kein `speed`. Hier wird der fertige Ton
gestreckt bzw. gestaucht – Stücke von 30 ms werden mit Überlappung neu gelegt, jedes an der Stelle, die am besten an
das vorige anschließt (Kreuzkorrelation). So bleibt die Stimme gleich hoch, nur das Sprechtempo ändert sich.
Reines numpy (BSD-3), keine neue Abhängigkeit.
"""

from __future__ import annotations

import numpy as np

FRAME_S = 0.030
TOLERANCE_S = 0.010


def time_stretch(audio: np.ndarray, speed: float, sample_rate: int) -> np.ndarray:
    """`speed` > 1 = schneller (kürzer), < 1 = langsamer. Nahe 1 oder zu kurz: unverändert."""
    x = np.asarray(audio, dtype=np.float32).reshape(-1)
    if abs(speed - 1.0) < 0.01 or speed <= 0:
        return x
    frame = max(64, int(FRAME_S * sample_rate))
    hop_out = frame // 2
    hop_in = hop_out * speed
    tol = max(8, int(TOLERANCE_S * sample_rate))
    if x.size < frame + 2 * tol + hop_out:
        return x
    window = np.hanning(frame).astype(np.float32)
    target = int(round(x.size / speed))
    y = np.zeros(target + frame, dtype=np.float32)
    weight = np.zeros(target + frame, dtype=np.float32)
    padded = np.concatenate([np.zeros(tol, dtype=np.float32), x, np.zeros(frame + tol + hop_out, dtype=np.float32)])
    pos_in = 0.0
    pos_out = 0
    natural: np.ndarray | None = None
    while pos_out < target and int(pos_in) < x.size:
        center = int(pos_in) + tol  # Index im gepolsterten Signal
        if natural is None:
            best = center
        else:
            region = padded[center - tol : center + tol + frame]
            corr = np.correlate(region, natural, mode="valid")
            best = center - tol + int(np.argmax(corr))
        seg = padded[best : best + frame]
        y[pos_out : pos_out + frame] += seg * window
        weight[pos_out : pos_out + frame] += window
        natural = padded[best + hop_out : best + hop_out + frame]
        pos_in += hop_in
        pos_out += hop_out
    ok = weight > 1e-3
    y[ok] /= weight[ok]
    return y[:target]
