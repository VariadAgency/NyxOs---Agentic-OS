// R2 · P2d-2: Schrift-Skala überall – Zuordnung, Ausnahmen, Idempotenz, CLI und Lint-Regel.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { afterAll, describe, expect, it } from "vitest";
import { eslintPlugin, findFixedSizes, findSmallCssFontSizes, globToRegExp, listCssFiles, PENDING, run, scaleForPx, scaleForStandard, transformSource } from "../lint/typography.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "lint", "typography.mjs");

describe("Zuordnung px → Stufe", () => {
  it.each([
    [8, "label"], [9, "label"], [9.5, "label"], [10, "label"], [10.5, "label"], [11, "label"],
    [11.5, "caption"], [12, "caption"], [12.5, "caption"],
    [13, "callout"], [13.5, "callout"], [14, "callout"],
    [14.5, "headline"], [15, "headline"], [15.5, "headline"], [16, "headline"],
    [17, "title2"], [19, "title2"], [20, "title2"], [22, "title2"],
    [24, "title"], [26, "title"], [28, "title"], [32, "title"],
  ])("%s px → text-%s", (px, scale) => {
    expect(scaleForPx(px)).toBe(scale);
  });

  it("nie kleiner als 11 px (text-label)", () => {
    for (let px = 6; px <= 11.5; px += 0.5) expect(["label", "caption"]).toContain(scaleForPx(px));
  });

  it("Tailwind-Standardgrößen", () => {
    expect(scaleForStandard("xs")).toBe("caption");
    expect(scaleForStandard("sm")).toBe("callout");
    expect(scaleForStandard("base")).toBe("headline");
    expect(scaleForStandard("lg")).toBe("title2");
    expect(scaleForStandard("xl")).toBe("title2");
    expect(scaleForStandard("2xl")).toBe("title");
  });
});

describe("transformSource", () => {
  it("ersetzt in className, cn(...) und Template-Strings, mit Varianten", () => {
    const src = [
      `<p className="mt-1 text-[12.5px] text-a-mut">x</p>`,
      `<span className={cn("px-2 text-[10.5px]", on && "text-[13px]")} />`,
      "const C = `grid text-xs ${a} sm:text-[19px] @md:text-sm/6`;",
      `<b className="!text-[11px] hover:text-base">y</b>`,
    ].join("\n");
    const { text, count } = transformSource(src);
    expect(count).toBe(8);
    expect(text).toBe(
      [
        `<p className="mt-1 text-caption text-a-mut">x</p>`,
        `<span className={cn("px-2 text-label", on && "text-callout")} />`,
        "const C = `grid text-caption ${a} sm:text-title2 @md:text-callout/6`;",
        `<b className="!text-label hover:text-headline">y</b>`,
      ].join("\n"),
    );
  });

  it("ist idempotent", () => {
    const once = transformSource(`<p className="text-[12px] text-sm">x</p>`).text;
    const twice = transformSource(once);
    expect(twice.count).toBe(0);
    expect(twice.text).toBe(once);
  });

  it("lässt Farben, relative Größen, Kommentare und ähnliche Klassen stehen", () => {
    const src = [
      `<i className="text-[var(--a-claude)] text-[0.9em] text-a-sm max-text-sm text-xs-foo" />`,
      `// früher text-[12px]`,
      ` * text-sm im Doc-Kommentar`,
    ].join("\n");
    expect(transformSource(src)).toEqual({ text: src, count: 0 });
  });

  it("typo-keep in der Zeile oder als Kommentarzeile davor", () => {
    const src = [
      `<span /* typo-keep: Zahl im Ring */ className="text-[9px]">1</span>`,
      `// typo-keep: Glyphe`,
      `className="text-[8px]"`,
      `{/* typo-keep */}`,
      `<b className="text-[9px]" />`,
      `<b className="text-[9px]" />`,
    ].join("\n");
    const { text, count } = transformSource(src);
    expect(count).toBe(1);
    expect(text.split("\n")[5]).toBe(`<b className="text-label" />`);
  });

  it("große Kennzahl ≥ 26 px mit tabular-nums bleibt, sonst Skala", () => {
    expect(transformSource(`<span className="text-[30px] tabular-nums">1</span>`).count).toBe(0);
    expect(transformSource(`<span className="text-[24px] tabular-nums">1</span>`).text).toContain("text-title");
    expect(transformSource(`<h1 className="text-[30px]">T</h1>`).text).toContain("text-title");
  });

  it("findFixedSizes meldet Zeile, Spalte und Ersatz", () => {
    expect(findFixedSizes(`a\n  <p className="text-[11.5px]" />`)).toEqual([{ line: 2, col: 17, from: "text-[11.5px]", to: "text-caption" }]);
  });
});

describe("Umfang", () => {
  it("globToRegExp", () => {
    expect(globToRegExp("features/brain/**").test("features/brain/x/Y.tsx")).toBe(true);
    expect(globToRegExp("features/brain/**").test("features/brainx/Y.tsx")).toBe(false);
    expect(globToRegExp("components/Sidebar.tsx").test("components/Sidebar.tsx")).toBe(true);
    expect(globToRegExp("**/*.test.tsx").test("a/b/c.test.tsx")).toBe(true);
  });

  it("PENDING ist leer: die Regel gilt die Regel überall", () => {
    expect(PENDING).toEqual([]);
  });

  it("--check meldet 0 feste Größen im echten Repo außerhalb von PENDING", () => {
    const res = run({ mode: "check" });
    expect(res.files).toBeGreaterThan(100);
    expect(res.hits.map((h) => `${h.file}:${h.line} ${h.from}`)).toEqual([]);
  });
});

describe("CLI", () => {
  const root = mkdtempSync(join(tmpdir(), "typography-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const write = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const cli = (...args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args, "--root", root, "--quiet"], { encoding: "utf8" }) };
    } catch (err) {
      return { code: err.status, out: String(err.stdout) };
    }
  };

  it("--check (Exit 1) → --apply → --check 0; PENDING und --exclude bleiben unberührt, --all zieht nach", () => {
    write("apps/web/src/features/a/A.tsx", `export const A = () => <p className="text-[12px]">a</p>;\n`);
    write("apps/web/src/features/brain/B.tsx", `export const B = () => <p className="text-[10px]">b</p>;\n`);
    write("apps/web/src/features/c/C.tsx", `export const C = () => <p className="text-xs">c</p>;\n`);

    expect(cli("--check")).toMatchObject({ code: 1 });
    expect(cli("--check").out).toContain("3 feste Schriftgrößen");
    expect(cli("--apply", "--exclude", "features/c/**", "--exclude", "features/brain/**").code).toBe(0);
    expect(readFileSync(join(root, "apps/web/src/features/a/A.tsx"), "utf8")).toContain(`className="text-caption"`);
    expect(readFileSync(join(root, "apps/web/src/features/brain/B.tsx"), "utf8")).toContain("text-[10px]");
    expect(readFileSync(join(root, "apps/web/src/features/c/C.tsx"), "utf8")).toContain("text-xs");

    expect(cli("--apply", "--all").code).toBe(0);
    expect(readFileSync(join(root, "apps/web/src/features/brain/B.tsx"), "utf8")).toContain("text-label");
    expect(cli("--check", "--all")).toMatchObject({ code: 0 });
  });
});

describe("Lint-Regel typo/no-fixed-font-size", () => {
  const linter = new Linter({ configType: "flat" });
  const lint = (code) =>
    linter.verify(
      code,
      [
        {
          files: ["**/*.tsx"],
          languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
          plugins: { typo: eslintPlugin },
          rules: { "typo/no-fixed-font-size": "error" },
        },
      ],
      "x.tsx",
    );

  it("meldet feste Größen in JSX, cn(...) und Template-Strings", () => {
    const msgs = lint(['const a = <p className="text-[12px]" />;', 'const b = cn("text-sm", x);', "const c = `p-1 ${y} text-[10.5px]`;"].join("\n"));
    expect(msgs.map((m) => [m.line, m.message.includes("text-caption") || m.message.includes("text-callout") || m.message.includes("text-label")])).toEqual([
      [1, true],
      [2, true],
      [3, true],
    ]);
  });

  it("lässt Skala, typo-keep und Kennzahlen durch", () => {
    const code = [
      'const a = <p className="text-caption text-a-mut" />;',
      'const b = <span /* typo-keep: Ring */ className="text-[9px]" />;',
      'const c = <span className="text-[30px] tabular-nums" />;',
    ].join("\n");
    expect(lint(code)).toEqual([]);
  });

  it("--fix ersetzt wie der Codemod", () => {
    const out = linter.verifyAndFix('const a = <p className="text-[11px] sm:text-xs" />;', [
      {
        files: ["**/*.tsx"],
        languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
        plugins: { typo: eslintPlugin },
        rules: { "typo/no-fixed-font-size": "error" },
      },
    ], "x.tsx");
    expect(out.output).toBe('const a = <p className="text-label sm:text-caption" />;');
  });
});

// Auch Zahl-Größen in style-Objekten zählen: z. B. Achsen-Beschriftungen per `style={{ fontSize: 10.5 }}` lagen
// unter 11 px, solange die Regel nur Klassen sah.
describe("Lint-Regel: feste Zahl-Größen in style-Objekten und SVG", () => {
  const linter = new Linter({ configType: "flat" });
  const lint = (code) =>
    linter.verify(
      code,
      [
        {
          files: ["**/*.tsx"],
          languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
          plugins: { typo: eslintPlugin },
          rules: { "typo/no-fixed-font-size": "error" },
        },
      ],
      "x.tsx",
    );

  it("meldet fontSize unter 11 in style-Objekten, SVG-Props und Stil-Konstanten", () => {
    const code = [
      "const a = <text style={{ fontSize: 10.5 }}>1</text>;",
      "const b = <text fontSize={9}>2</text>;",
      'const c = <text fontSize="10px">3</text>;',
      'const d = { fontSize: 8, color: "red" };',
      'const e = <p style={{ fontSize: "10.5px" }} />;',
      'const f = <text style={{ "fontSize": 10 }} />;',
    ].join("\n");
    expect(lint(code).map((m) => [m.line, m.messageId])).toEqual([
      [1, "smallNumber"],
      [2, "smallNumber"],
      [3, "smallNumber"],
      [4, "smallNumber"],
      [5, "smallNumber"],
      [6, "smallNumber"],
    ]);
    expect(lint("const a = <text style={{ fontSize: 10.5 }}>1</text>;")[0].message).toContain("var(--text-label)");
  });

  it("lässt ≥ 11 px, Skala-Variablen, em/rem, Ausdrücke und typo-keep durch", () => {
    const code = [
      "const a = <text style={{ fontSize: 11 }}>1</text>;",
      "const b = { fontSize: 13 };",
      'const c = <text style={{ fontSize: "var(--text-label)" }} />;',
      'const d = { fontSize: "0.9em" };',
      "const e = { fontSize: Math.max(6, size * 0.3) };",
      "const f = <text style={{ fontSize: 9 }} /* typo-keep: Zahl im 18-px-Ring */ />;",
      "// typo-keep: Glyphe im Kästchen",
      "const g = { fontSize: 8 };",
      "const h = { lineHeight: 9, letterSpacing: 1 };",
    ].join("\n");
    expect(lint(code)).toEqual([]);
  });
});

describe("CSS-Dateien: font-size unter 11 px", () => {
  it("findet px-Größen unter 11, lässt typo-keep, Variablen und em stehen", () => {
    const css = [
      ".a { font-size: 10.5px; }",
      ".b {",
      "  font-size: 9px; /* typo-keep: Zahl im 16-px-Kreis */",
      "  font-size: var(--text-label);",
      "  font-size: 0.8em;",
      "  font-size: 11px;",
      "}",
      "/* früher font-size: 8px */",
    ].join("\n");
    expect(findSmallCssFontSizes(css)).toEqual([{ line: 1, px: 10.5 }]);
  });

  it("im echten Repo: keine CSS-Schrift unter 11 px ohne typo-keep", () => {
    const hits = [];
    for (const { abs, rel } of listCssFiles()) for (const h of findSmallCssFontSizes(readFileSync(abs, "utf8"))) hits.push(`${rel}:${h.line} ${h.px}px`);
    expect(hits).toEqual([]);
  });
});
