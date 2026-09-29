// Handy-Tastatur. iOS/Android verkleinern beim Tippen nur den SICHTBAREN Bereich (`visualViewport`),
// nicht das Layout – `100dvh` bleibt gleich hoch, und die Tastatur legt sich über Eingabezeile, Terminal und
// Tastenzeile. Solange die Tastatur offen ist, bekommt die App darum genau die sichtbare Höhe (`--app-h`) und
// Position (`--app-top`), und `<html data-kb="open">` blendet entbehrliche Leisten aus (`.cc-kb-hide`, app.css).
// Zwei-Finger-Zoom verkleinert den sichtbaren Bereich auch – das ist keine Tastatur (scale ≠ 1).

/** Ab so viel verdeckter Höhe gilt: Tastatur offen (Adressleiste/Werkzeugleiste sind kleiner). */
export const KEYBOARD_MIN_PX = 120;

export function installViewportTracking(win: Window = window): () => void {
  const vv = win.visualViewport;
  if (!vv) return () => {};
  const root = win.document.documentElement;
  let frame = 0;
  const update = () => {
    frame = 0;
    const covered = win.innerHeight - vv.height;
    const open = Math.abs(vv.scale - 1) < 0.01 && covered > KEYBOARD_MIN_PX;
    if (open) {
      root.dataset.kb = "open";
      root.style.setProperty("--app-h", `${Math.round(vv.height)}px`);
      root.style.setProperty("--app-top", `${Math.round(vv.offsetTop)}px`);
    } else if (root.dataset.kb) {
      delete root.dataset.kb;
      root.style.removeProperty("--app-h");
      root.style.removeProperty("--app-top");
    }
  };
  const raf = typeof win.requestAnimationFrame === "function";
  // Größe und Verschieben kommen beim Öffnen der Tastatur in schneller Folge – auf ein Bild bündeln.
  const onChange = () => {
    if (!raf) return update();
    if (!frame) frame = win.requestAnimationFrame(update);
  };
  update();
  vv.addEventListener("resize", onChange);
  vv.addEventListener("scroll", onChange);
  return () => {
    vv.removeEventListener("resize", onChange);
    vv.removeEventListener("scroll", onChange);
    if (frame && raf) win.cancelAnimationFrame(frame);
  };
}
