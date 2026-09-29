# Container `nyxos-nyx-voice` — Erkennung (Parakeet) + Sprachausgabe (Piper-Stimmen über sherpa-onnx,
# zusätzlich Kyutai Pocket TTS „juergen“ über PyTorch-CPU), nur CPU. Modelle liegen NIE im Abbild: der erste
# Start lädt sie ins Volume /models (geprüft per SHA-256, s. nyx_voice/catalog.py). Gebaut auf dem Server (x86_64),
# Kontext = Repo-Wurzel.
FROM python:3.12.14-slim-bookworm
# ffmpeg (Debian-Paket, eigener Prozess): Browser-/Telegram-Audio lesen, Ogg/Opus schreiben.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY infra/nyx-voice/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
  && python -c "import sherpa_onnx, numpy; print('sherpa-onnx', sherpa_onnx.__version__)"
# Pocket TTS + PyTorch (CPU, ≈ +1 GB Abbild) in einer eigenen Schicht — ändert sich selten.
COPY infra/nyx-voice/requirements-pocket.txt ./
RUN pip install --no-cache-dir -r requirements-pocket.txt \
  && python -c "import torch, pocket_tts; from pocket_tts.utils.config import CONFIGS_DIR; assert (CONFIGS_DIR / 'german.yaml').is_file() and (CONFIGS_DIR / 'english.yaml').is_file(); print('torch', torch.__version__, 'pocket-tts ok')"
COPY infra/nyx-voice/nyx_voice ./nyx_voice
COPY infra/nyx-voice/tests ./tests
# Bau bricht ab, wenn die Tests (Fake-Motoren, echtes ffmpeg mit Opus) hier nicht grün sind.
RUN python -m unittest discover -s tests && rm -rf tests
RUN useradd --system --uid 10001 --no-create-home nyx && mkdir -p /models && chown nyx /models
USER nyx
# HF_HUB_OFFLINE: Pocket lädt nur aus dem Volume, nie selbst aus dem Netz. HOME=/tmp: Dateisystem ist schreibgeschützt.
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 NYX_MODELS_DIR=/models NYX_PORT=8090 \
    HF_HUB_OFFLINE=1 HOME=/tmp
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=4)"]
CMD ["python", "-m", "nyx_voice"]
