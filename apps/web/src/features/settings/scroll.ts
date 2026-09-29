// Scrolling in the main area (`<main class="cc-scroll">` from App.tsx). List → subpage starts at the top, back lands
// at the same spot of the list again (like the iOS settings); an anchor scrolls to the block.

const saved = new Map<string, number>();

function scroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>("main.cc-scroll") ?? document.querySelector<HTMLElement>("main");
}

export function rememberScroll(key: string): void {
  const el = scroller();
  if (el) saved.set(key, el.scrollTop);
}

export function restoreScroll(key: string): void {
  const el = scroller();
  const top = saved.get(key);
  if (el && top !== undefined) el.scrollTop = top;
}

export function scrollToTop(): void {
  const el = scroller();
  if (el) el.scrollTop = 0;
}

/**
 * Scrollt zum Element mit `id`, sobald es da ist (Panels laden ihre Daten nach), und hebt es kurz hervor.
 * Gibt eine Aufräum-Funktion zurück (für useEffect).
 */
export function scrollToAnchor(id: string, { tries = 20, everyMs = 80 } = {}): () => void {
  let n = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const attempt = () => {
    const el = document.getElementById(id);
    if (el) {
      // If the spot sits in a collapsed block („Erweitert“), open it first – a closed <details> has no position.
      for (let d = el.closest("details"); d; d = d.parentElement?.closest("details") ?? null) if (!d.open) d.open = true;
      el.scrollIntoView?.({ block: "start", behavior: "smooth" });
      el.setAttribute("data-settings-flash", "");
      timer = setTimeout(() => el.removeAttribute("data-settings-flash"), 1600);
      return;
    }
    if (++n < tries) timer = setTimeout(attempt, everyMs);
  };
  attempt();
  return () => {
    if (timer) clearTimeout(timer);
  };
}
