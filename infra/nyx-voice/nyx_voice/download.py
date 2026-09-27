"""Modell einmal ins Volume laden — geprüft (SHA-256), sicher entpackt, idempotent.

Ablauf je Modell: schon da (Marker mit passender Prüfsumme)? → fertig. Sonst herunterladen nach
`/models/.partial/`, Prüfsumme beim Lesen mitrechnen, nur bei Treffer entpacken (tarfile-Filter
„data“: keine absoluten Pfade, keine Links nach außen), dann atomar an den Zielnamen umbenennen.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import tarfile
import threading
import time
import urllib.request
from pathlib import Path
from typing import Callable

from .catalog import ModelSpec, RemoteFile

MARKER = ".nyx-ok"
CHUNK = 1024 * 1024
# Mehr als die erwartete Größe (+ Spielraum) wird nie gelesen: ein falscher oder böser Server kann so
# die Platte (Volume) nicht füllen. Die Prüfsumme greift sonst erst nach dem vollständigen Download.
SIZE_SLACK = 1.10
Progress = Callable[[int, int], None]


class DownloadError(Exception):
    pass


def model_dir(root: Path, spec: ModelSpec) -> Path:
    return root / spec.archive_dir


def is_installed(root: Path, spec: ModelSpec) -> bool:
    marker = model_dir(root, spec) / MARKER
    try:
        return marker.read_text().strip() == spec.sha256
    except OSError:
        return False


def _default_open(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "nyx-voice/1"})
    return urllib.request.urlopen(req, timeout=60)


# je Modell höchstens EIN Download gleichzeitig — mehrere Pocket-Stimmen teilen sich ein Modell und fragen es
# beim Start zugleich an (sonst schrieben zwei Fäden in denselben Bereitstellungs-Ordner).
_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def _lock_for(spec_id: str) -> threading.Lock:
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(spec_id, threading.Lock())


def ensure_model(root: Path, spec: ModelSpec, progress: Progress | None = None, opener=None, attempts: int = 3) -> Path:
    """Liefert den fertigen Modell-Ordner; lädt ihn bei Bedarf (mit Wiederholung).
    Eine Stimme auf einem geteilten Pocket-Modell (`pocket_model`) lädt zuerst dieses Modell mit."""
    if spec.pocket_model:
        from .catalog import TTS_VOICES

        ensure_model(root, TTS_VOICES[spec.pocket_model], None, opener, attempts)
    with _lock_for(spec.id):
        return _ensure_one(root, spec, progress, opener, attempts)


def _ensure_one(root: Path, spec: ModelSpec, progress: Progress | None, opener, attempts: int) -> Path:
    target = model_dir(root, spec)
    if is_installed(root, spec):
        if progress:
            progress(spec.size_bytes, spec.size_bytes)
        return target
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            if spec.files:
                _download_files(root, spec, progress, opener or _default_open)
            else:
                _download_and_extract(root, spec, progress, opener or _default_open)
            return target
        except Exception as e:  # noqa: BLE001 — jeder Fehler zählt als Versuch
            last = e
            time.sleep(min(30, 2 ** attempt))
    raise DownloadError(f"{spec.id}: {last}")


def _download_and_extract(root: Path, spec: ModelSpec, progress: Progress | None, opener) -> None:
    partial_dir = root / ".partial"
    partial_dir.mkdir(parents=True, exist_ok=True)
    archive = partial_dir / f"{spec.id}.tar.bz2"
    digest = hashlib.sha256()
    done = 0
    limit = int(spec.size_bytes * SIZE_SLACK)
    with opener(spec.url) as res, open(archive, "wb") as out:
        total = int(res.headers.get("Content-Length") or spec.size_bytes)
        if total > limit:
            raise DownloadError(f"Paket {spec.id} ist größer als erwartet ({total} statt {spec.size_bytes} Bytes)")
        while True:
            chunk = res.read(CHUNK)
            if not chunk:
                break
            if done + len(chunk) > limit:
                out.close()
                archive.unlink(missing_ok=True)
                raise DownloadError(f"Paket {spec.id} ist größer als erwartet (mehr als {spec.size_bytes} Bytes)")
            out.write(chunk)
            digest.update(chunk)
            done += len(chunk)
            if progress:
                progress(done, total)
    if digest.hexdigest() != spec.sha256:
        archive.unlink(missing_ok=True)
        raise DownloadError(f"Prüfsumme falsch für {spec.id} (erwartet {spec.sha256[:12]}…, bekommen {digest.hexdigest()[:12]}…)")

    staging = root / f".extract-{spec.id}"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    with tarfile.open(archive, "r:bz2") as tar:
        tar.extractall(staging, filter="data")
    extracted = staging / spec.archive_dir
    if not extracted.is_dir():
        raise DownloadError(f"Paket {spec.id} enthält den Ordner {spec.archive_dir} nicht")
    (extracted / MARKER).write_text(spec.sha256)
    target = model_dir(root, spec)
    shutil.rmtree(target, ignore_errors=True)
    os.replace(extracted, target)
    shutil.rmtree(staging, ignore_errors=True)
    archive.unlink(missing_ok=True)


def _safe_relpath(rel: str) -> Path:
    """Nur einfache relative Pfade im Modell-Ordner (kein „..“, nicht absolut, keine leeren Teile)."""
    p = Path(rel)
    if p.is_absolute() or not p.parts or any(part in ("", ".", "..") for part in p.parts) or "\\" in rel:
        raise DownloadError(f"unsicherer Dateipfad im Katalog: {rel!r}")
    return p


def _fetch_file(opener, f: RemoteFile, dest: Path, on_bytes: Callable[[int], None]) -> None:
    digest = hashlib.sha256()
    limit = int(f.size_bytes * SIZE_SLACK) + 1024
    done = 0
    dest.parent.mkdir(parents=True, exist_ok=True)
    with opener(f.url) as res, open(dest, "wb") as out:
        declared = int(res.headers.get("Content-Length") or 0)
        if declared > limit:
            raise DownloadError(f"{f.path} ist größer als erwartet ({declared} statt {f.size_bytes} Bytes)")
        while True:
            chunk = res.read(CHUNK)
            if not chunk:
                break
            if done + len(chunk) > limit:
                raise DownloadError(f"{f.path} ist größer als erwartet (mehr als {f.size_bytes} Bytes)")
            out.write(chunk)
            digest.update(chunk)
            done += len(chunk)
            on_bytes(len(chunk))
    if digest.hexdigest() != f.sha256:
        raise DownloadError(f"Prüfsumme falsch für {f.path} (erwartet {f.sha256[:12]}…, bekommen {digest.hexdigest()[:12]}…)")


def _download_files(root: Path, spec: ModelSpec, progress: Progress | None, opener) -> None:
    """Einzeldateien (Pocket TTS) — jede mit Größen-Grenze + SHA-256, erst alles in einen
    Bereitstellungs-Ordner, dann atomar an den Zielnamen. Eine falsche Datei → nichts landet im Ziel."""
    rels = [_safe_relpath(f.path) for f in spec.files]
    staging = root / f".extract-{spec.id}"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    total = sum(f.size_bytes for f in spec.files)
    done = 0

    def on_bytes(n: int) -> None:
        nonlocal done
        done += n
        if progress:
            progress(done, total)

    try:
        for f, rel in zip(spec.files, rels):
            _fetch_file(opener, f, staging / rel, on_bytes)
        (staging / MARKER).write_text(spec.sha256)
        target = model_dir(root, spec)
        shutil.rmtree(target, ignore_errors=True)
        os.replace(staging, target)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
