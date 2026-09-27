import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { fetchAuthStatus, onAuthChange } from "../features/terminal/authClient";

/** Nebenbei alle 5 Min neu prüfen (z. B. auf einem anderen Gerät „Überall abmelden"). */
const AUTH_STATUS_REFRESH_MS = 5 * 60_000;

/**
 * Anmeldestatus (`authClient`) als Query — von den Einstellungen (Abschnitt „Anmeldung“) und der
 * Leiste (`ConnectionStatus`) gemeinsam genutzt.
 *
 * Zeigt den echten Zustand. Neu geladen wird nach Login/Logout/401 (`onAuthChange`), bei
 * Fenster-Fokus, bei Sichtbarkeitswechsel (Tab wieder vorne) und alle 5 Minuten. Scheitert ein
 * Abruf (Server/Tunnel kurz weg), wirft `fetchAuthStatus` — die Query behält dann den letzten
 * bestätigten Stand, statt „Nicht angemeldet“ anzuzeigen (so ging die Anmeldung im Review
 * scheinbar verloren, obwohl die Sitzung auf dem Server gültig war).
 */
export function useAuthStatus() {
  const qc = useQueryClient();
  useEffect(() => {
    const refresh = () => void qc.invalidateQueries({ queryKey: ["auth-status"] });
    const onVisible = () => {
      if (document.visibilityState !== "hidden") refresh();
    };
    const off = onAuthChange(refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      off();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [qc]);
  return useQuery({
    queryKey: ["auth-status"],
    queryFn: () => fetchAuthStatus(true),
    refetchOnWindowFocus: "always",
    refetchInterval: AUTH_STATUS_REFRESH_MS,
  });
}
