"""Erkennung und Sprachausgabe über sherpa-onnx (Apache-2.0, nur als Bibliothek genutzt).

Die Dateinamen in den Modell-Paketen werden gesucht statt fest verdrahtet (int8 bevorzugt), damit
ein neueres Paket mit leicht anderen Namen nicht still bricht. Beide Motoren sind nicht für
gleichzeitige Aufrufe gebaut — der Dienst schützt jeden mit einer eigenen Sperre.
"""

from __future__ import annotations

import os
import tempfile
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Protocol

import numpy as np

from .audio import SAMPLE_RATE, split_long
from .catalog import TTS_VOICES, ModelSpec


class SttEngine(Protocol):
    def transcribe(self, samples: np.ndarray) -> str: ...


class TtsEngine(Protocol):
    sample_rate: int

    def synthesize(self, text: str, speed: float) -> np.ndarray: ...


class StreamingTtsEngine(TtsEngine, Protocol):
    """Motor, der Ton schon WÄHREND der Rechnung stückweise liefert (Pocket TTS)."""

    def stream(self, text: str, speed: float, stop: threading.Event) -> Iterator[np.ndarray]: ...


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _pick(folder: Path, pattern: str) -> str:
    hits = sorted(folder.glob(pattern), key=lambda p: (".int8." not in p.name, p.name))
    if not hits:
        raise FileNotFoundError(f"{pattern} fehlt in {folder}")
    return str(hits[0])


class SherpaStt:
    def __init__(self, folder: Path, threads: int) -> None:
        import sherpa_onnx  # erst hier: Tests laufen ohne die Bibliothek

        self._rec = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=_pick(folder, "encoder*.onnx"),
            decoder=_pick(folder, "decoder*.onnx"),
            joiner=_pick(folder, "joiner*.onnx"),
            tokens=_pick(folder, "tokens.txt"),
            num_threads=threads,
            model_type="nemo_transducer",
            decoding_method="greedy_search",
        )

    def transcribe(self, samples: np.ndarray) -> str:
        texts: list[str] = []
        for part in split_long(samples):
            stream = self._rec.create_stream()
            stream.accept_waveform(SAMPLE_RATE, part)
            self._rec.decode_stream(stream)
            t = stream.result.text.strip()
            if t:
                texts.append(t)
        return " ".join(texts)


# Feinschliff der Piper-Stimmen (Standardwerte der Stimmen: noise 0,667 / noise_w 0,8 / length 1,0).
# Weniger Rauschen = klarere, ruhigere Aussprache; etwas kürzere Länge = zügiger, ohne zu hetzen.
# Umstellbar ohne Neubau über die Umgebung (Compose).
PIPER_NOISE_SCALE = 0.55
PIPER_NOISE_SCALE_W = 0.7
PIPER_LENGTH_SCALE = 0.95


class SherpaTts:
    def __init__(self, folder: Path, threads: int, speaker_id: int = 0) -> None:
        import sherpa_onnx

        model = [p for p in folder.glob("*.onnx")]
        if len(model) != 1:
            raise FileNotFoundError(f"genau eine .onnx-Stimme erwartet in {folder}, gefunden {len(model)}")
        self.speaker_id = speaker_id
        cfg = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                    model=str(model[0]),
                    tokens=_pick(folder, "tokens.txt"),
                    data_dir=str(folder / "espeak-ng-data"),
                    noise_scale=_env_float("NYX_PIPER_NOISE_SCALE", PIPER_NOISE_SCALE),
                    noise_scale_w=_env_float("NYX_PIPER_NOISE_SCALE_W", PIPER_NOISE_SCALE_W),
                    length_scale=_env_float("NYX_PIPER_LENGTH_SCALE", PIPER_LENGTH_SCALE),
                ),
                num_threads=threads,
                provider="cpu",
            ),
            max_num_sentences=1,
        )
        if not cfg.validate():
            raise ValueError(f"Stimme in {folder} unvollständig")
        self._tts = sherpa_onnx.OfflineTts(cfg)
        self.sample_rate = int(self._tts.sample_rate)

    def synthesize(self, text: str, speed: float) -> np.ndarray:
        audio = self._tts.generate(text, sid=self.speaker_id, speed=speed)
        return np.asarray(audio.samples, dtype=np.float32)


# Klang von Pocket TTS (API pocket-tts 3.3.0, `TTSModel.load_model`): `temp` (Standard aus der Modell-Konfiguration
# 0,3), `sampler_decode_steps` (Standard 1), `noise_clamp` (Standard aus). Das Rauschen der Flow-Stufe wird in
# `sampler_decode_steps` Schritten in Ton-Merkmale übersetzt; mit nur EINEM Schritt klingt die Ausgabe am ehesten
# „verwaschen“. Zwei Schritte sind laut Kyutai besser und kosten nur den kleinen Flow-Kopf, nicht den Transformer
# (Server-RTF heute 0,38, Grenze beim Streamen 0,8). Eine Klemme auf das Rauschen verhindert einzelne Ausreißer
# (Knackser, Nuscheln). Alles ohne Neubau umstellbar (Compose-Env), z. B. NYX_POCKET_DECODE_STEPS=1 = alter Klang.
POCKET_TEMP: float | None = None  # None = Empfehlung des Modells (0,3)
POCKET_DECODE_STEPS = 2
POCKET_NOISE_CLAMP: float | None = None


def pocket_params(env: dict[str, str] | None = None) -> dict:
    """Parameter für `TTSModel.load_model` aus der Umgebung (leer/ungültig → Standard oben)."""
    e = os.environ if env is None else env

    def num(name: str, default, cast):
        raw = (e.get(name) or "").strip()
        if not raw:
            return default
        try:
            return cast(raw)
        except ValueError:
            return default

    steps = num("NYX_POCKET_DECODE_STEPS", POCKET_DECODE_STEPS, int)
    temp = num("NYX_POCKET_TEMP", POCKET_TEMP, float)
    clamp = num("NYX_POCKET_NOISE_CLAMP", POCKET_NOISE_CLAMP, float)
    return {
        "temp": temp if temp is None or 0.0 < temp <= 1.5 else POCKET_TEMP,
        "sampler_decode_steps": steps if 1 <= steps <= 8 else POCKET_DECODE_STEPS,
        "noise_clamp": clamp if clamp is None or clamp > 0 else POCKET_NOISE_CLAMP,
    }


# EIN geladenes Pocket-Modell je Modell-Ordner, geteilt von allen Stimmen darauf (+ eine Sperre, weil das Modell
# nicht thread-sicher ist — die Sperren im Dienst gelten je Stimme, nicht je Modell).
_POCKET_MODELS: dict[tuple[str, str], tuple[object, threading.Lock]] = {}
_POCKET_GUARD = threading.Lock()


class PocketTts:
    """Kyutai Pocket TTS (Code MIT, pip `pocket-tts`; Gewichte CC-BY-4.0) mit der Stimme „juergen“
    (bzw. dem eigenen englischen Modell mit „george“ — Konfiguration + Stimme kommen aus catalog.py).

    Lädt NUR aus dem Volume (Dateien s. catalog.py, geprüft per SHA-256): Die Konfiguration des Pakets wird mit
    lokalen Pfaden neu geschrieben, Hugging Face bleibt aus (HF_HUB_OFFLINE). Streamt: `generate_audio_stream`
    liefert Stücke von 80 ms-Rahmen, sobald sie fertig sind. Kein Tempo-Regler im Modell → `speed` wird ignoriert.
    """

    def __init__(self, folder: Path, threads: int, config: str = "german.yaml", voice: str = "juergen", voice_folder: Path | None = None) -> None:
        """`folder` = Modell (Gewichte + Tokenizer); `voice_folder` = Ordner mit embeddings/<voice> (Standard: `folder`)."""
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        import torch  # erst hier: Tests und reine Piper-Setups laufen ohne PyTorch

        torch.set_num_threads(max(1, threads))
        self._model, self._lock = self._shared_model(folder, config)
        with self._lock:
            self._voice = self._model.get_state_for_audio_prompt((voice_folder or folder) / "embeddings" / f"{voice}.safetensors")
        self.sample_rate = int(self._model.sample_rate)

    @staticmethod
    def _shared_model(folder: Path, config: str):
        import yaml
        from pocket_tts import TTSModel
        from pocket_tts.utils.config import CONFIGS_DIR

        key = (str(folder.resolve()), config)
        with _POCKET_GUARD:
            hit = _POCKET_MODELS.get(key)
            if hit:
                return hit
            cfg = pocket_config(CONFIGS_DIR / config, folder, yaml)
            fd, cfg_path = tempfile.mkstemp(prefix="nyx-pocket-", suffix=".yaml")
            with os.fdopen(fd, "w") as f:
                yaml.safe_dump(cfg, f)
            try:
                model = TTSModel.load_model(config=cfg_path, **pocket_params())
            finally:
                os.unlink(cfg_path)
            _POCKET_MODELS[key] = (model, threading.Lock())
            return _POCKET_MODELS[key]

    def stream(self, text: str, speed: float, stop: threading.Event) -> Iterator[np.ndarray]:
        # eigenes Stopp-Signal je Aufruf. Vorher setzte das Ende eines Satzes das GEMEINSAME Signal der ganzen
        # Antwort – danach fiel jeder weitere Satz still weg. Ein echter Abbruch (`stop` von außen) wird weitergereicht.
        local = threading.Event()
        # Modell-Sperre für die ganze Rechnung (mehrere Stimmen teilen sich ein Modell).
        with self._lock:
            inner = self._model.generate_audio_stream(self._voice, text, copy_state=True, stop=local)
            try:
                for chunk in inner:
                    if stop.is_set():
                        break
                    yield chunk.detach().cpu().numpy().astype(np.float32, copy=False).reshape(-1)
            finally:
                # Abbruch (Browser weg) oder Ende: Pockets Rechen-Fäden laufen sonst noch einen Schritt weiter, das
                # Modell ist nicht thread-sicher. Erst anhalten, dann den Rest abholen — danach ist alles fertig.
                local.set()
                for _ in inner:
                    pass

    def synthesize(self, text: str, speed: float) -> np.ndarray:
        parts = list(self.stream(text, speed, threading.Event()))
        return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)


def pocket_config(package_yaml: Path, folder: Path, yaml_mod) -> dict:
    """Paket-Konfiguration (german.yaml / english.yaml) → dieselbe mit lokalen Pfaden aus dem Volume (kein hf://)."""
    cfg = yaml_mod.safe_load(package_yaml.read_text())
    weights = str(folder / "model.safetensors")
    cfg["weights_path"] = weights
    cfg["weights_path_without_voice_cloning"] = weights
    cfg["flow_lm"]["lookup_table"]["tokenizer_path"] = str(folder / "tokenizer.json")
    for key in ("weights_path",):
        cfg["flow_lm"].pop(key, None)
        cfg["mimi"].pop(key, None)
    return cfg


def spec_for_folder(folder: Path) -> ModelSpec:
    for spec in TTS_VOICES.values():
        if spec.archive_dir == folder.name:
            return spec
    raise FileNotFoundError(f"unbekannter Stimmen-Ordner {folder.name}")


def engine_available(engine: str) -> bool:
    """Kann dieser Dienst den Motor laden? Pocket braucht PyTorch + pocket-tts (Zusatzpaket, fehlt im lokalen
    Stimmen-Paket von `nyxos voice install`); Piper und die Erkennung laufen immer über sherpa-onnx."""
    if engine != "pocket":
        return True
    import importlib.util

    return importlib.util.find_spec("torch") is not None and importlib.util.find_spec("pocket_tts") is not None


def make_tts_engine(folder: Path, threads: int) -> TtsEngine:
    """Richtiger Motor je Stimme (Piper über sherpa-onnx oder Pocket TTS)."""
    spec = spec_for_folder(folder)
    if spec.engine == "pocket" and spec.pocket_model:
        # Stimme auf geteiltem Modell — Gewichte aus dem Ordner der Modell-Stimme (download.py lädt ihn mit).
        base = TTS_VOICES[spec.pocket_model]
        return PocketTts(folder.parent / base.archive_dir, threads, base.pocket_config, spec.pocket_voice, voice_folder=folder)
    if spec.engine == "pocket":
        return PocketTts(folder, threads, spec.pocket_config, spec.pocket_voice)
    return SherpaTts(folder, threads, spec.speaker_id)


class FakeStt:
    """Für Tests und die Probe ohne Modelle: gibt einen festen Text + die Dauer zurück."""

    def __init__(self, text: str = "Hallo Nyx") -> None:
        self.text = text

    def transcribe(self, samples: np.ndarray) -> str:
        return self.text


class FakeTts:
    sample_rate = 22_050

    def __init__(self) -> None:
        self.texts: list[str] = []

    def synthesize(self, text: str, speed: float) -> np.ndarray:
        self.texts.append(text)
        n = int(self.sample_rate * min(5.0, 0.06 * len(text)) / max(speed, 0.1))
        t = np.arange(n, dtype=np.float32) / self.sample_rate
        return (0.2 * np.sin(2 * np.pi * 220.0 * t)).astype(np.float32)


class FakeStreamingTts(FakeTts):
    """Für Tests: liefert jeden Text in `pieces` Stücken (wie Pocket TTS) und merkt sich Abbrüche."""

    sample_rate = 24_000

    def __init__(self, pieces: int = 3, delay_s: float = 0.0) -> None:
        super().__init__()
        self.pieces = pieces
        self.delay_s = delay_s
        self.stopped = False

    def stream(self, text: str, speed: float, stop: threading.Event) -> Iterator[np.ndarray]:
        import time

        audio = self.synthesize(text, speed)
        for part in np.array_split(audio, self.pieces):
            if stop.is_set():
                self.stopped = True
                return
            if self.delay_s:
                time.sleep(self.delay_s)
            yield part
