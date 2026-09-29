"""Welche Modelle der Stimmen-Dienst kennt (Quelle, Prüfsumme, Lizenz).

Alle Modelle kommen als fertige ONNX-Pakete aus den Releases von sherpa-onnx (Apache-2.0,
https://github.com/k2-fsa/sherpa-onnx). Die SHA-256-Werte stammen aus der GitHub-API
(Feld `digest` der Release-Assets, abgefragt am 25.09.2026) — ein manipuliertes oder
abgebrochenes Paket wird so nie entpackt.

Modelle liegen NIE im Abbild, sondern im Volume `/models` (erster Start lädt sie).
"""

from __future__ import annotations

from dataclasses import dataclass

RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download"
POCKET_REV = "4e1e0a3e611c51c0b4ed8174fc10f32a54644303"
POCKET_BASE = f"https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/{POCKET_REV}/languages/german"
POCKET_MODEL_SHA = "d2fabbc2c383d30ee29fcd374f8281406cc501b1d963fe687691f8573de3252b"
# eigenes ENGLISCHES Pocket-Modell (nur Englisch, getrennt vom deutschen) aus demselben Repo + derselben
# Revision. Gleiche Gewichte wie `english.yaml` im pip-Paket pocket-tts 3.3.0 (LFS-SHA dort identisch geprüft).
POCKET_BASE_EN = f"https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/{POCKET_REV}/languages/english"
POCKET_MODEL_EN_SHA = "916ccd2686e9311cb40054893a3c4284393d658825ffc714a276f3e9b152344f"


@dataclass(frozen=True)
class RemoteFile:
    """Eine einzelne Datei (kein Archiv), z. B. Gewichte von Hugging Face — geprüft per SHA-256."""

    path: str  # relativ im Modell-Ordner, nur einfache Namen/Unterordner (kein „..“, nicht absolut)
    url: str
    sha256: str
    size_bytes: int


@dataclass(frozen=True)
class ModelSpec:
    id: str
    kind: str  # "stt" | "tts"
    engine: str  # "nemo_transducer" | "piper" | "pocket"
    url: str
    sha256: str
    size_bytes: int
    archive_dir: str
    license: str
    source: str
    # Anzeige-Name für die Einstellungen (einfach, deutsch).
    label: str = ""
    # Mehrsprecher-Stimmen (thorsten_emotional): welche Sprecher-Nummer (4 = „neutral“).
    speaker_id: int = 0
    # Statt eines Archivs (url/sha256 oben leer) einzelne Dateien laden (Pocket TTS).
    files: tuple[RemoteFile, ...] = ()
    # Sprache der Stimme („de“ | „en“). Jede Stimme spricht GENAU eine Sprache — kein Mehrsprachen-Modell.
    language: str = "de"
    # Nur Pocket: Konfiguration im pip-Paket (pocket_tts/config/…) und Stimmen-Einbettung (embeddings/<name>).
    pocket_config: str = "german.yaml"
    pocket_voice: str = "juergen"
    # weitere Pocket-Stimme auf DEMSELBEN Modell: Kennung der Stimme, deren Ordner Gewichte + Tokenizer hält
    # (z. B. „pocket-juergen“). Der eigene Ordner enthält dann nur die Stimmen-Einbettung; das Modell wird einmal
    # geladen und von allen Stimmen geteilt (engines.py). Leer = eigenes, vollständiges Modell.
    pocket_model: str = ""


STT_MODELS: dict[str, ModelSpec] = {
    # Parakeet TDT 0.6B v3 (NVIDIA, 25 europäische Sprachen inkl. Deutsch). Kein 30-s-Fenster wie
    # bei Whisper: die Rechenzeit wächst mit der Länge der Aufnahme, 5 s Sprache kosten nur 5 s.
    "parakeet-tdt-0.6b-v3-int8": ModelSpec(
        id="parakeet-tdt-0.6b-v3-int8",
        kind="stt",
        engine="nemo_transducer",
        url=f"{RELEASES}/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
        sha256="5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf",
        size_bytes=487_170_055,
        archive_dir="sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
        license="CC-BY-4.0 (NVIDIA)",
        source="https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3",
    ),
}

TTS_VOICES: dict[str, ModelSpec] = {
    # Piper-VITS-Stimmen (Datensatz CC0 laut Modellkarte rhasspy/piper-voices). Laufen über
    # sherpa-onnx, NICHT über `piper1-gpl`.
    "de_DE-thorsten-high": ModelSpec(
        id="de_DE-thorsten-high",
        kind="tts",
        engine="piper",
        url=f"{RELEASES}/tts-models/vits-piper-de_DE-thorsten-high.tar.bz2",
        sha256="dd4ed1b0d42c30a1a4862fc2b243e8044d52b8889c9ff3d1e99e92028888bc4a",
        size_bytes=115_591_546,
        archive_dir="vits-piper-de_DE-thorsten-high",
        license="Datensatz CC0 (Thorsten-Voice)",
        source="https://huggingface.co/rhasspy/piper-voices/tree/main/de/de_DE/thorsten/high",
        label="Thorsten (echte deutsche Stimme, klar)",
    ),
    # Thorsten „low“ (16 kHz, am kleinsten) — nur zum Importieren, nicht standardmäßig geladen.
    "de_DE-thorsten-low": ModelSpec(
        id="de_DE-thorsten-low",
        kind="tts",
        engine="piper",
        url=f"{RELEASES}/tts-models/vits-piper-de_DE-thorsten-low.tar.bz2",
        sha256="41fab35910fdcec4696b031951d8fd6c262e594cf77b35e1068fadbeb5a091a6",
        size_bytes=67_101_576,
        archive_dir="vits-piper-de_DE-thorsten-low",
        license="Datensatz CC0 (Thorsten-Voice)",
        source="https://huggingface.co/rhasspy/piper-voices/tree/main/de/de_DE/thorsten/low",
        label="Thorsten (echte deutsche Stimme, klein)",
    ),
    "de_DE-thorsten-medium": ModelSpec(
        id="de_DE-thorsten-medium",
        kind="tts",
        engine="piper",
        url=f"{RELEASES}/tts-models/vits-piper-de_DE-thorsten-medium.tar.bz2",
        sha256="50487d9c95fdf2191f31d2588569381063ba1591dcd4c7d4bdd30f12b2191714",
        size_bytes=67_214_254,
        archive_dir="vits-piper-de_DE-thorsten-medium",
        license="Datensatz CC0 (Thorsten-Voice)",
        source="https://huggingface.co/rhasspy/piper-voices/tree/main/de/de_DE/thorsten/medium",
        label="Thorsten (echte deutsche Stimme, schnell)",
    ),
    "de_DE-kerstin-low": ModelSpec(
        id="de_DE-kerstin-low",
        kind="tts",
        engine="piper",
        url=f"{RELEASES}/tts-models/vits-piper-de_DE-kerstin-low.tar.bz2",
        sha256="4bfe121d5f690a3b87acecd7ae1e70b48f4589ce6ae9f45a1809e6eb19fad97b",
        size_bytes=67_107_768,
        archive_dir="vits-piper-de_DE-kerstin-low",
        license="Datensatz CC0 (dataset-voice-kerstin)",
        source="https://huggingface.co/rhasspy/piper-voices/tree/main/de/de_DE/kerstin/low",
        label="Kerstin (echte deutsche Stimme)",
    ),
    # weitere freie deutsche Piper-Stimmen für den Vergleich (SHA-256 aus der GitHub-API, 25.09.2026, 22:45).
    # NICHT dabei: pavoque (Datensatz CC-BY-NC-SA, nicht kommerziell), glados (Spielfigur), miro/dii (Lizenz unklar).
    "de_DE-thorsten_emotional-medium": ModelSpec(
        id="de_DE-thorsten_emotional-medium",
        kind="tts",
        engine="piper",
        url=f"{RELEASES}/tts-models/vits-piper-de_DE-thorsten_emotional-medium.tar.bz2",
        sha256="4e55e6c7ba21700b6fb71e9544e1615bb348f74114799d23395826fdb33ee6f7",
        size_bytes=80_215_792,
        archive_dir="vits-piper-de_DE-thorsten_emotional-medium",
        license="Datensatz CC0 (Thorsten-Voice)",
        source="https://huggingface.co/rhasspy/piper-voices/tree/main/de/de_DE/thorsten_emotional/medium",
        label="Thorsten (echte deutsche Stimme, betont)",
        speaker_id=4,  # speaker_id_map: amused 0 … neutral 4 … whisper 7
    ),
    "de_DE-ramona-low": ModelSpec(
        id="de_DE-ramona-low",
        kind="tts",
        engine="piper",
        url=f"{RELEASES}/tts-models/vits-piper-de_DE-ramona-low.tar.bz2",
        sha256="79f985c10f86c4d58205b519abc488aa65eb713d54665ff729880a02e2625a42",
        size_bytes=67_084_795,
        archive_dir="vits-piper-de_DE-ramona-low",
        license="Datensatz M-AILABS (BSD-ähnlich, kommerziell erlaubt, Namensnennung)",
        source="https://huggingface.co/rhasspy/piper-voices/tree/main/de/de_DE/ramona/low",
        label="Ramona (echte deutsche Stimme)",
    ),
    "de_DE-eva_k-x_low": ModelSpec(
        id="de_DE-eva_k-x_low",
        kind="tts",
        engine="piper",
        url=f"{RELEASES}/tts-models/vits-piper-de_DE-eva_k-x_low.tar.bz2",
        sha256="daec8658456d8e5ec714972f2e5a71f8a84d58b974db396f4eaeace0df06455a",
        size_bytes=26_521_242,
        archive_dir="vits-piper-de_DE-eva_k-x_low",
        license="Datensatz M-AILABS (BSD-ähnlich, kommerziell erlaubt, Namensnennung)",
        source="https://huggingface.co/rhasspy/piper-voices/tree/main/de/de_DE/eva_k/x_low",
        label="Eva (echte deutsche Stimme)",
    ),
    # Kyutai Pocket TTS, Stimme „juergen“ (natürlicher, streamt). Code MIT (pip `pocket-tts==3.3.0`, im
    # Abbild), Gewichte CC-BY-4.0 aus dem Hugging-Face-Repo OHNE Stimmen-Klonen, feste Revision. Die SHA-256 der
    # Gewichte sind die LFS-Prüfsummen laut Hugging-Face-API (25.09.2026); tokenizer.json ist keine LFS-Datei,
    # ihre Prüfsumme ist lokal nachgerechnet.
    "pocket-juergen": ModelSpec(
        id="pocket-juergen",
        kind="tts",
        engine="pocket",
        url="",
        sha256=POCKET_MODEL_SHA,
        size_bytes=219_029_196 + 245_966 + 6_244_152,
        archive_dir="pocket-tts-german-4e1e0a3e",
        license="Code MIT (Kyutai), Gewichte CC-BY-4.0 (kyutai/pocket-tts-without-voice-cloning)",
        source=f"https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/tree/{POCKET_REV}/languages/german",
        label="Jürgen (natürlich)",
        files=(
            RemoteFile("model.safetensors", f"{POCKET_BASE}/model.safetensors", POCKET_MODEL_SHA, 219_029_196),
            RemoteFile("tokenizer.json", f"{POCKET_BASE}/tokenizer.json", "2d77849811e3d1b6ae80e5b11b203f57e1847901104d8a0573b34f46f8dddb53", 245_966),
            RemoteFile("embeddings/juergen.safetensors", f"{POCKET_BASE}/embeddings/juergen.safetensors", "0846249f121a8fb9466519080544549409f27f52b64bd381d41ef2b2c0410a50", 6_244_152),
        ),
    ),
    # ─────────── weitere Stimmen auf dem deutschen Pocket-Modell (nur die Einbettung, ~6–7 MB je Stimme) ───────────
    # Einbettungen aus languages/german/embeddings derselben Revision; SHA-256 = LFS-Prüfsummen der HF-API (26.09.2026).
    # Lizenzen laut huggingface.co/kyutai/tts-voices: VCTK = CC-BY-4.0, „voice-donations“ = CC0. Genau die drei, für die
    # Kyutai auch Einbettungen zum großen deutschen Modell (german_24l) anbietet — also für Deutsch ausgesucht.
    # NICHT genommen: Expresso/EARS-Stimmen (cosette, jean: nicht kommerziell), voice-zero und daan (Lizenz unklar).
    **{
        f"pocket-{name}": ModelSpec(
            id=f"pocket-{name}",
            kind="tts",
            engine="pocket",
            url="",
            sha256=sha,
            size_bytes=size,
            archive_dir=f"pocket-tts-german-4e1e0a3e-{name}",
            license=f"Code MIT (Kyutai), Gewichte CC-BY-4.0, {lic}",
            source=f"https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/blob/{POCKET_REV}/languages/german/embeddings/{name}.safetensors",
            label=label,
            files=(RemoteFile(f"embeddings/{name}.safetensors", f"{POCKET_BASE}/embeddings/{name}.safetensors", sha, size),),
            pocket_voice=name,
            pocket_model="pocket-juergen",
        )
        for name, sha, size, lic, label in (
            ("vera", "9ee79a5b144851ae758a4882d4025faa1759c160b46950f4554cd3f4e0d2b94d", 6_735_672, "Stimme VCTK p229 CC-BY-4.0", "Vera (natürlich, Frau)"),
            ("michael", "04652331d115da987fbac0fbcd2ca7c39bca6bca643015c6b2cc954107c61061", 7_276_344, "Stimme VCTK p360 CC-BY-4.0", "Michael (natürlich)"),
            ("marius", "a9c0d041fadcb4b03d94fadbb8404969d9456076c8ca3a6f8422fdabaefb49b4", 6_195_000, "Stimme Kyutai Voice Donation CC0", "Marius (natürlich)"),
        )
    },
    # ─────────── englische Stimmen (eigene Modelle, nur für englische Sätze) ───────────
    # Pocket TTS ENGLISCH, Stimme „george“ (männlich, ruhig; Aufnahme aus VCTK Sprecher p315, CC-BY-4.0 laut
    # huggingface.co/kyutai/tts-voices). Gewichte CC-BY-4.0, Code MIT. SHA-256 = LFS-Prüfsummen der HF-API (26.09.2026);
    # tokenizer.json (keine LFS-Datei) lokal nachgerechnet. NICHT genommen: Stimmen aus Expresso/EARS (nicht kommerziell).
    "pocket-en-george": ModelSpec(
        id="pocket-en-george",
        kind="tts",
        engine="pocket",
        url="",
        sha256=POCKET_MODEL_EN_SHA,
        size_bytes=219_029_196 + 245_020 + 6_244_152,
        archive_dir="pocket-tts-english-4e1e0a3e",
        license="Code MIT (Kyutai), Gewichte CC-BY-4.0, Stimme VCTK p315 CC-BY-4.0",
        source=f"https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/tree/{POCKET_REV}/languages/english",
        label="George (natürlich, englisch)",
        files=(
            RemoteFile("model.safetensors", f"{POCKET_BASE_EN}/model.safetensors", POCKET_MODEL_EN_SHA, 219_029_196),
            RemoteFile("tokenizer.json", f"{POCKET_BASE_EN}/tokenizer.json", "f498428e1eafee50492f7be13dc9bfafcfc12e508cd0eb1b01c92ecd5d8c6687", 245_020),
            RemoteFile("embeddings/george.safetensors", f"{POCKET_BASE_EN}/embeddings/george.safetensors", "9cee0daccb0eda1631b73f8b35f6f8cb195885d55d2e1e20fc711f9e4456ceb0", 6_244_152),
        ),
        language="en",
        pocket_config="english.yaml",
        pocket_voice="george",
    ),
    # Englische Rückfall-Stimme (Piper, klein, schnell): LJSpeech-Datensatz gemeinfrei (public domain) laut Modellkarte.
    # NICHT genommen: en_US-ryan (Datensatz CC-BY-NC-SA), en_US-lessac (Blizzard-Lizenz, nicht kommerziell).
    "en_US-ljspeech-high": ModelSpec(
        id="en_US-ljspeech-high",
        kind="tts",
        engine="piper",
        url=f"{RELEASES}/tts-models/vits-piper-en_US-ljspeech-high.tar.bz2",
        sha256="00c6408d2409050312193b0d40ae07fde28af7d3d45a56efcc55440db516b935",
        size_bytes=115_817_679,
        archive_dir="vits-piper-en_US-ljspeech-high",
        license="Datensatz gemeinfrei (LJSpeech)",
        source="https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/ljspeech/high",
        label="Linda (klar, englisch)",
        language="en",
    ),
}

DEFAULT_STT = "parakeet-tdt-0.6b-v3-int8"
# Rückfall-Stimme (schnell, klein, immer dabei): springt automatisch ein, wenn die gewünschte Stimme nicht bereit ist.
# Server-Messung: erster Ton 150 ms, RTF 0,037.
# German main voice is Thorsten (clear, Piper "high"). It is also the fallback: if it fails, the next German voice
# of the list takes over (Jürgen). The other Thorsten variants (low, medium, emphatic) are neither loaded nor offered
# for import (their entries stay only for old volumes).
DEFAULT_TTS = "de_DE-thorsten-high"
FALLBACK_TTS = DEFAULT_TTS
RETIRED_TTS = ("de_DE-thorsten-low", "de_DE-thorsten-medium", "de_DE-thorsten_emotional-medium")
# Order = preference. Change without rebuild via NYX_TTS_DEFAULT or NYX_TTS_VOICES.
# English has its own default and fallback voice (env NYX_TTS_DEFAULT_EN).
DEFAULT_TTS_EN = "pocket-en-george"
FALLBACK_TTS_EN = "en_US-ljspeech-high"
DEFAULT_TTS_VOICES = [
    DEFAULT_TTS,
    "pocket-juergen",  # second choice: more natural, streams
    DEFAULT_TTS_EN,
    FALLBACK_TTS_EN,
    "de_DE-kerstin-low",
    "de_DE-ramona-low",
    "de_DE-eva_k-x_low",
]

# ─────────── Stimmen importieren (zur Laufzeit, Liste im Volume) ───────────
# Importierbar ist jede Stimme dieses Katalogs, die nicht schon geladen ist — also nur Stimmen mit GEPRÜFTER freier
# Lizenz. Eine eingefügte Adresse muss ein sherpa-onnx-Piper-Paket sein UND im Katalog stehen (Prüfsumme bekannt).
# Geprüft und NICHT aufgenommen (Modellkarten rhasspy/piper-voices, 26.09.2026): pavoque (CC-BY-NC-SA, nicht
# kommerziell), karlsson (Feinschliff der Ryan-Stimme, deren Datensatz nicht kommerziell ist), glados/glados_turret
# (Spielfigur), miro/dii (Lizenz unklar), mls (kein sherpa-onnx-Paket).
IMPORT_URL_RE = r"^https://github\.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-([a-z]{2}_[A-Z]{2}-[A-Za-z0-9_]+-(?:x_low|low|medium|high))\.tar\.bz2$"
# Eigene, echt deutsche Stimmen zuerst; die Pocket-Stimmen englischer Sprecher (Vera/Michael/Marius) nur auf Wunsch.
IMPORTABLE_TTS = [v for v in TTS_VOICES if TTS_VOICES[v].kind == "tts" and v not in RETIRED_TTS]
