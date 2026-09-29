// Mini-Seite `/i/<token>`: EINE eigenständige HTML-Datei (kein App-Bundle, keine Assets unter
// anderen Pfaden) – nur Chat. So kann später genau dieser Pfad nach außen freigegeben werden, ohne dass
// die NyxOS mitkommt. Text wird ausschließlich als textContent gesetzt (keine HTML-Einschleusung).

import { getLang, t } from "@nyxos/shared";

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);

export function ideaLinkCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function invalidLinkPage(nonce: string): string {
  return `<!doctype html><html lang="${getLang()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(t("Link ungültig"))}</title>
<style nonce="${nonce}">body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#0a0d12;color:#e2e7ee;font:16px/1.5 -apple-system,system-ui,sans-serif}main{max-width:26rem;padding:2rem;text-align:center}p{color:#8691a1}</style>
</head><body><main><h1>${esc(t("Dieser Link gilt nicht (mehr)"))}</h1><p>${esc(t("Er ist abgelaufen, wurde widerrufen oder ist falsch kopiert. Frag die Person, die ihn dir geschickt hat, nach einem neuen Link."))}</p></main></body></html>`;
}

export function ideaLinkPage(opts: { name: string; nonce: string }): string {
  const n = opts.nonce;
  // Texte für das Skript der Seite: als JSON eingebettet (`<` maskiert, damit nichts das Skript-Tag schließt).
  const js = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
  const err = js({
    rate_limit: t("Gerade zu viele Nachrichten – bitte später noch einmal."),
    budget: t("Nyx macht für heute Pause. Versuch es morgen wieder."),
    disabled: t("Nyx ist gerade nicht erreichbar."),
    timeout: t("Das hat zu lange gedauert. Bitte noch einmal."),
    busy: t("Gerade viel los – bitte gleich noch einmal."),
    quota: t("Danke! Für heute sind hier genug Ideen eingegangen – morgen gerne wieder."),
  });
  const failLater = js(t("Das hat nicht geklappt. Bitte später noch einmal."));
  const failed = js(t("Das hat nicht geklappt."));
  const offline = js(t("Keine Verbindung. Bitte später noch einmal."));
  return `<!doctype html>
<html lang="${getLang()}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#0a0d12">
<title>${esc(t("Idee einreichen"))}</title>
<style nonce="${n}">
:root{--bg:#0a0d12;--p:#10141b;--p2:#151a23;--p3:#1b212c;--line:#232a36;--ink:#e2e7ee;--mut:#8691a1;--acc:#45bac2;--bad:#f06b64}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"IBM Plex Sans",system-ui,sans-serif}
.app{display:flex;flex-direction:column;height:100dvh;max-width:44rem;margin:0 auto;padding:0 16px}
header{padding:20px 0 12px;border-bottom:1px solid var(--line)}
h1{margin:0;font-size:20px;font-weight:600;letter-spacing:-.01em}
header p{margin:4px 0 0;color:var(--mut);font-size:14px}
.log{flex:1;overflow-y:auto;padding:16px 0;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}
.msg{max-width:85%;padding:10px 14px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word;border:1px solid var(--line);animation:in .2s cubic-bezier(.2,.8,.2,1)}
.me{align-self:flex-end;background:linear-gradient(180deg,#1d2f35,#17262b);border-color:#2b4a50}
.bot{align-self:flex-start;background:linear-gradient(180deg,#141922,var(--p));box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
.err{align-self:center;color:var(--bad);font-size:14px;background:none;border:none}
.hint{color:var(--mut);font-size:14px;text-align:center;margin:auto 0}
.dots{display:inline-flex;gap:4px;padding:4px 0}.dots i{width:6px;height:6px;border-radius:50%;background:var(--mut);animation:b 1.2s infinite}.dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}
form{display:flex;gap:8px;padding:12px 0 calc(12px + env(safe-area-inset-bottom));border-top:1px solid var(--line)}
textarea{flex:1;resize:none;min-height:46px;max-height:160px;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:var(--p2);color:var(--ink);font:inherit}
textarea:focus{outline:2px solid var(--acc);outline-offset:1px}
button{min-width:46px;padding:0 16px;border:0;border-radius:12px;background:var(--acc);color:#061114;font-weight:600;font-size:15px;cursor:pointer;transition:opacity .15s}
button:disabled{opacity:.45;cursor:default}
@keyframes in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes b{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
@media (prefers-reduced-motion:reduce){.msg,.dots i{animation:none}.log{scroll-behavior:auto}}
</style>
</head><body>
<div class="app">
<header><h1>${esc(t("Hallo {name} – hast du eine Idee?", { name: opts.name }))}</h1><p>${esc(t("Schreib sie einfach auf. Nyx schaut, ob es sie schon gibt, und legt sie sonst für den Nutzer ab."))}</p></header>
<div class="log" id="log" role="log" aria-live="polite"><p class="hint" id="hint">${esc(t("Zum Beispiel: „Eine Warteliste für volle Clubs wäre cool.“"))}</p></div>
<form id="f"><textarea id="t" rows="1" maxlength="2000" placeholder="${esc(t("Deine Idee …"))}" aria-label="${esc(t("Deine Idee"))}"></textarea><button id="s" type="submit" aria-label="${esc(t("Senden"))}">➤</button></form>
</div>
<script nonce="${n}">
(function(){
  var base = location.pathname.replace(/\\/+$/, "");
  var key = "ideenlink:" + base.slice(-12);
  var conv = null;
  try { conv = localStorage.getItem(key); } catch (e) {}
  if (!conv) { conv = (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, function(c){return (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16);})); try { localStorage.setItem(key, conv); } catch (e) {} }
  var log = document.getElementById("log"), f = document.getElementById("f"), t = document.getElementById("t"), s = document.getElementById("s"), hint = document.getElementById("hint");
  function add(cls, text){ if (hint) { hint.remove(); hint = null; } var d = document.createElement("div"); d.className = "msg " + cls; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }
  function typing(){ var d = add("bot", ""); var w = document.createElement("span"); w.className = "dots"; w.innerHTML = "<i></i><i></i><i></i>"; d.appendChild(w); return d; }
  var ERR = ${err};
  t.addEventListener("input", function(){ t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 160) + "px"; });
  t.addEventListener("keydown", function(e){ if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); } });
  f.addEventListener("submit", async function(e){
    e.preventDefault();
    var text = t.value.trim(); if (!text || s.disabled) return;
    add("me", text); t.value = ""; t.style.height = "auto"; s.disabled = true;
    var bot = typing(), got = "";
    try {
      var res = await fetch(base + "/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: text, conversationId: conv }), credentials: "omit", referrerPolicy: "no-referrer" });
      if (!res.ok || !res.body) { var j = {}; try { j = await res.json(); } catch (x) {} bot.remove(); add("err", ERR[j.code] || ${failLater}); return; }
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
      for (;;) {
        var r = await reader.read(); if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        var lines = buf.split("\\n"); buf = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          var ev; try { ev = JSON.parse(lines[i]); } catch (x) { continue; }
          if (ev.type === "delta") { got += ev.text; bot.textContent = got; log.scrollTop = log.scrollHeight; }
          else if (ev.type === "done") { bot.textContent = ev.text; }
          else if (ev.type === "error") { bot.remove(); add("err", ERR[ev.code] || ${failed}); }
        }
      }
    } catch (x) { bot.remove(); add("err", ${offline}); }
    finally { s.disabled = false; t.focus(); }
  });
})();
</script>
</body></html>`;
}
