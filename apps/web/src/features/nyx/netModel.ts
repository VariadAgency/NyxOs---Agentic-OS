// Zustände, in denen Nyx sichtbar sein kann (Leiste, Zentrum, Logo `NyxAura`).
// Das alte 2D-Netz (`NeuralNet.tsx` samt Netz-Modell hier) war nach dem Wechsel auf die Aura
// nirgends mehr eingebunden und ist entfernt; das 3D-Netz des Nyx-Tabs hat sein eigenes Modell (`tab/netModel.ts`).

export type NyxVisualState = "idle" | "listening" | "thinking" | "speaking" | "tool";
