#!/usr/bin/env python3
# Test-Helfer: ein „eigenes Fenster“ auf dem Mac nachstellen — ein echtes Pseudo-Terminal wie
# Terminal.app, ohne tmux. Startet das übergebene Programm (z. B. `claude …`) darin, liest die Ausgabe
# (nach argv[1] als Log) und beendet sich, sobald das Programm endet. Tippt nie etwas, außer die
# Vertrauens-Frage für einen neuen Ordner mit Enter („Ja“) zu beantworten.
# Aufruf: outside-window.py <log> <ordner> <programm> [argumente …]
import os
import pty
import select
import signal
import struct
import sys
import fcntl
import termios

log_path, cwd, argv = sys.argv[1], sys.argv[2], sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.environ.pop("TMUX", None)
    # Wie ein frisches Terminal-Fenster: keine Kennzeichen einer umgebenden Claude-Sitzung (sonst speichert
    # Claude keinen Verlauf: „inherited CLAUDE_CODE_CHILD_SESSION marker“).
    for k in [k for k in os.environ if k.startswith("CLAUDE")]:
        del os.environ[k]
    os.environ["NYXOS_TMUX"] = "0"
    os.execvp(argv[0], argv)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 120, 0, 0))
os.kill(pid, signal.SIGWINCH)
answered_trust = False
seen = b""
with open(log_path, "wb") as log:
    while True:
        try:
            r, _, _ = select.select([fd], [], [], 0.5)
        except InterruptedError:
            continue
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            log.write(data)
            log.flush()
            seen = (seen + data)[-8192:]
            if not answered_trust and b"trust" in seen.lower():
                answered_trust = True
                os.write(fd, b"\r")
        done, _ = os.waitpid(pid, os.WNOHANG)
        if done:
            break
