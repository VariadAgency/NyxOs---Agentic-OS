// Texteditor mit Zeilennummern und Syntax-Hervorhebung — CodeMirror 6 (MIT, s. NOTICE). Eigenes
// Bundle (lazy), damit der Finder ohne geöffnete Datei leicht bleibt. Farben aus den Tokens (app.css).
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, StreamLanguage, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { c, java, kotlin, objectiveC } from "@codemirror/legacy-modes/mode/clike";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { go } from "@codemirror/legacy-modes/mode/go";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { pgSQL } from "@codemirror/legacy-modes/mode/sql";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { xml } from "@codemirror/legacy-modes/mode/xml";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";

function languageFor(name: string): Extension | LanguageSupport | null {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  if (lower === "dockerfile" || ext === "dockerfile") return StreamLanguage.define(dockerFile);
  switch (ext) {
    case "md":
    case "markdown":
    case "mdx":
      return markdown();
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return javascript({ jsx: true });
    case "json":
      return json();
    case "css":
      return css();
    case "html":
    case "htm":
      return html();
    case "py":
      return python();
    case "yml":
    case "yaml":
      return yaml();
    case "swift":
      return StreamLanguage.define(swift);
    case "sh":
    case "zsh":
    case "bash":
      return StreamLanguage.define(shell);
    case "sql":
      return StreamLanguage.define(pgSQL);
    case "go":
      return StreamLanguage.define(go);
    case "rs":
      return StreamLanguage.define(rust);
    case "toml":
      return StreamLanguage.define(toml);
    case "xml":
    case "plist":
    case "svg":
    case "storyboard":
    case "xib":
      return StreamLanguage.define(xml);
    case "kt":
      return StreamLanguage.define(kotlin);
    case "java":
      return StreamLanguage.define(java);
    case "c":
    case "h":
      return StreamLanguage.define(c);
    case "m":
      return StreamLanguage.define(objectiveC);
    case "rb":
      return StreamLanguage.define(ruby);
    case "ini":
    case "conf":
    case "env":
    case "properties":
      return StreamLanguage.define(properties);
    default:
      return null;
  }
}

/** Hervorhebung in den Token-Farben (bunt, gut unterscheidbar, auch bei Rot-Grün-Schwäche). */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: "var(--a-conf)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--a-lime)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--a-claude)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--a-dim)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--a-codex)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--a-wait)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--a-acc)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--a-done)" },
  { tag: [t.heading], color: "var(--a-ink)", fontWeight: "650" },
  { tag: [t.heading1], color: "var(--a-ink)", fontWeight: "700", fontSize: "1.12em" },
  { tag: [t.heading2], color: "var(--a-ink)", fontWeight: "700", fontSize: "1.06em" },
  { tag: [t.strong], fontWeight: "700", color: "var(--a-ink)" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.link, t.url], color: "var(--a-acc)", textDecoration: "underline" },
  { tag: [t.quote], color: "var(--a-mut)", fontStyle: "italic" },
  { tag: [t.monospace], color: "var(--a-lime)" },
  { tag: [t.list], color: "var(--a-violet)" },
  { tag: [t.meta, t.processingInstruction], color: "var(--a-indigo)" },
  { tag: [t.invalid], color: "var(--a-bad)" },
]);

const theme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "var(--a-p)", color: "var(--a-ink)", fontSize: "13px" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
    ".cm-content": { caretColor: "var(--a-acc)", padding: "10px 0" },
    ".cm-gutters": { backgroundColor: "var(--a-p)", color: "var(--a-dim)", borderRight: "1px solid var(--a-line)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--a-p2)", color: "var(--a-mut)" },
    ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--a-p3) 55%, transparent)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--a-acc)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in srgb, var(--a-acc) 28%, transparent) !important" },
    ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--a-wait) 22%, transparent)" },
    ".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--a-acc) 25%, transparent)", outline: "none" },
    ".cm-foldGutter .cm-gutterElement": { color: "var(--a-dim)" },
    ".cm-panels": { backgroundColor: "var(--a-p2)", color: "var(--a-ink)", borderBottom: "1px solid var(--a-line)" },
    ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--a-wait) 30%, transparent)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--a-wait) 55%, transparent)" },
    ".cm-textfield": { backgroundColor: "var(--a-p)", border: "1px solid var(--a-line)", color: "var(--a-ink)", borderRadius: "6px" },
    ".cm-button": { backgroundImage: "none", backgroundColor: "var(--a-p3)", border: "1px solid var(--a-line)", color: "var(--a-ink)", borderRadius: "6px" },
    "&.cm-focused": { outline: "none" },
  },
  { dark: true },
);

export interface CodeEditorProps {
  value: string;
  filename: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  /** ⌘S / Strg+S. */
  onSave?: () => void;
  label?: string;
}

export function CodeEditor({ value, filename, readOnly = false, onChange, onSave, label = "Editor" }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };
  const ro = useRef(new Compartment());

  useEffect(() => {
    if (!host.current) return;
    const lang = languageFor(filename);
    const wrap = /\.(md|markdown|mdx|txt)$/i.test(filename);
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        syntaxHighlighting(highlight),
        theme,
        ...(wrap ? [EditorView.lineWrapping] : []),
        ...(lang ? [lang] : []),
        ro.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              handlers.current.onSave?.();
              return true;
            },
          },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...foldKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) handlers.current.onChange?.(u.state.doc.toString());
        }),
        EditorView.contentAttributes.of({ "aria-label": label }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // Neu aufbauen nur bei anderer Datei; Text und Nur-Lesen werden unten nachgeführt.
  }, [filename]);

  // Von außen neu geladener Text (z. B. nach „Neu laden“) — nur, wenn er sich vom Editor unterscheidet.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: ro.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}

export default CodeEditor;
