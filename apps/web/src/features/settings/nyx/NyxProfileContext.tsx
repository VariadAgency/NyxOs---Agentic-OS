// The Nyx profile (sliders, personality, about you) is ONE record on the server but now lives on two subpages
// (Persönlichkeit · Über dich). So the draft lives above all Nyx pages: moving something on „Persönlichkeit“ and
// switching to „Über dich“ loses nothing; „Speichern“ sends everything together.
import type { NyxProfile } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useState } from "react";
import { fetchNyxPresets, fetchNyxProfile, PRESETS_KEY, PROFILE_KEY, saveNyxProfile } from "./nyxApi";

function useNyxProfileState() {
  const qc = useQueryClient();
  const profileQ = useQuery({ queryKey: PROFILE_KEY, queryFn: fetchNyxProfile });
  const presetsQ = useQuery({ queryKey: PRESETS_KEY, queryFn: fetchNyxPresets });
  const [draft, setDraft] = useState<NyxProfile | null>(null);
  const saved = profileQ.data?.profile ?? null;
  const current = draft ?? saved;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);

  const save = useMutation({
    mutationFn: saveNyxProfile,
    onSuccess: (res) => {
      qc.setQueryData(PROFILE_KEY, res);
      setDraft(null);
    },
  });

  const edit = (fn: (p: NyxProfile) => NyxProfile) => {
    if (!current) return;
    save.reset();
    setDraft(fn(current));
  };

  return { profileQ, presetsQ, current, draft, dirty, save, edit };
}

export type NyxProfileState = ReturnType<typeof useNyxProfileState>;

const Ctx = createContext<NyxProfileState | null>(null);

export function NyxProfileProvider({ children }: { children: ReactNode }) {
  const state = useNyxProfileState();
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

/** The shared draft of all Nyx pages (the routes put the provider around `/einstellungen/nyx/*`). */
export function useNyxProfile(): NyxProfileState {
  const state = useContext(Ctx);
  if (!state) throw new Error("useNyxProfile needs <NyxProfileProvider> (see features/settings/routes.tsx)");
  return state;
}
