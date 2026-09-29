// „Nyx fragen: …“ aus ⌘K — öffnet den Nyx-Chat (⌘J) mit vorausgefüllter Frage. Bewusst nur
// vorausgefüllt, nicht abgeschickt: du siehst die Frage und schickst sie selbst mit Enter.
export const NYX_ASK_EVENT = "nyxos:nyx-ask";

export interface NyxAskDetail {
  text: string;
}

export function askNyx(text: string): void {
  window.dispatchEvent(new CustomEvent<NyxAskDetail>(NYX_ASK_EVENT, { detail: { text } }));
}
