#!/usr/bin/env node
/** WCAG 2.1 contrast audit for the theme tokens in apps/desktop/src/styles.css. */
import { readFile } from "node:fs/promises";

function rgb(hex) {
  const v = hex.replace("#", "");
  return [parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255];
}
function channel(c) { return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
function luminance([r, g, b]) { return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); }
function contrast(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function over(fg, alpha, bg) { return fg.map((c, i) => c * alpha + bg[i] * (1 - alpha)); }

// Audit the actual shipped tokens so a palette change cannot silently leave
// this gate measuring an obsolete copy of the design system.
const css = await readFile(new URL('../apps/desktop/src/styles.css', import.meta.url), 'utf8');
function declarations(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1];
  if (!block) throw new Error(`Missing theme selector: ${selector}`);
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()]));
}
const tokenNames = {
  bg: 'bg', surface: 'surface', surface2: 'surface-2', surface3: 'surface-3',
  ink: 'ink', secondary: 'secondary', tertiary: 'tertiary', accent: 'accent',
  accentHover: 'accent-hover', accentText: 'accent-text', accentContrast: 'accent-contrast',
  success: 'success', warning: 'warning', danger: 'danger', onInk: 'on-ink',
  syntaxKeyword: 'syntax-keyword', syntaxString: 'syntax-string', syntaxLiteral: 'syntax-literal', syntaxComment: 'syntax-comment',
  diffAddText: 'diff-add-text', diffDelText: 'diff-del-text',
};
function colors(values) {
  const resolve = (token) => {
    let value = values[token];
    for (let depth = 0; /^var\(--/.test(value ?? '') && depth < 4; depth++) {
      value = values[value.match(/^var\(--([\w-]+)\)$/)?.[1]];
    }
    return value;
  };
  const result = Object.fromEntries(Object.entries(tokenNames).map(([key, token]) => {
    const value = resolve(token);
    if (!/^#[0-9a-f]{6}$/i.test(value ?? '')) throw new Error(`Expected a hex color for --${token}: ${value}`);
    return [key, value];
  }));
  const soft = values['accent-soft'].match(/^rgba\(([^)]+)\)$/)?.[1].split(',').map(Number);
  if (!soft || soft.length !== 4 || soft.some((value) => !Number.isFinite(value))) throw new Error('Expected RGBA --accent-soft');
  return { ...result, accentSoft: soft };
}
const darkTokens = declarations(':root');
const lightTokens = { ...darkTokens, ...declarations('html[data-theme="light"]') };
const themes = { dark: colors(darkTokens), light: colors(lightTokens) };
const accents = { dark: {}, light: {} };
for (const name of ['ember', 'mono', 'blue', 'violet', 'pink', 'orange', 'yellow', 'green', 'teal']) {
  // Monochrome inherits the theme's neutral controls; its selector only sets
  // the thinking/effort palette. Optional colors layer over those defaults.
  const accent = declarations(`html[data-accent="${name}"]`);
  const lightAccent = declarations(`html[data-theme="light"][data-accent="${name}"]`);
  accents.dark[name] = colors({ ...darkTokens, ...accent });
  accents.light[name] = colors({ ...lightTokens, ...accent, ...lightAccent });
}

let failures = 0;
const rows = [];
function check(name, fgHex, bgHex, min = 4.5) {
  checkRgb(name, rgb(fgHex), rgb(bgHex), min);
}

function checkRgb(name, fg, bg, min = 4.5) {
  const ratio = contrast(fg, bg);
  const ok = ratio >= min;
  if (!ok) failures++;
  rows.push({ name, ratio: ratio.toFixed(2), min, ok });
}

for (const [name, t] of Object.entries(themes)) {
  for (const bg of ["bg", "surface", "surface2", "surface3"]) {
    check(`${name} ink/${bg}`, t.ink, t[bg]);
    check(`${name} secondary/${bg}`, t.secondary, t[bg]);
    check(`${name} tertiary/${bg}`, t.tertiary, t[bg]);
    check(`${name} accentText/${bg}`, t.accentText, t[bg]);
  }
  check(`${name} accentContrast/accent`, t.accentContrast, t.accent);
  check(`${name} accentContrast/accentHover`, t.accentContrast, t.accentHover);
  const softBg = over(t.accentSoft.slice(0, 3).map((value) => value / 255), t.accentSoft[3], rgb(t.surface2));
  const softRatio = contrast(rgb(t.accentText), softBg);
  const softOk = softRatio >= 4.5;
  if (!softOk) failures++;
  rows.push({ name: `${name} accentText/accentSoft(surface2)`, ratio: softRatio.toFixed(2), min: 4.5, ok: softOk });
  for (const status of ["success", "warning", "danger"]) {
    check(`${name} ${status}/surface2`, t[status], t.surface2);
  }
  check(`${name} onInk/ink`, t.onInk, t.ink);
  // Diff text, signs and numbers use ink over a tinted row; word marks add
  // another translucent layer. Check both the pane and approval backgrounds.
  for (const bg of ["bg", "surface"]) {
    for (const [kind, tint] of [["add", t.success], ["del", t.danger]]) {
      const rowBg = over(rgb(tint), 0.11, rgb(t[bg]));
      const wordBg = over(rgb(tint), 0.18, rowBg);
      checkRgb(`${name} diff ink/${kind}(${bg})`, rgb(t.ink), rowBg);
      checkRgb(`${name} diff ink/${kind}-word(${bg})`, rgb(t.ink), wordBg);
    }
  }
  // Diff add/del text and counts use dedicated text tokens (USA-006): the
  // status colors they aliased failed AA as foreground on light surfaces.
  for (const [name2, token] of [["add", "diffAddText"], ["del", "diffDelText"]]) {
    for (const bg of ["bg", "surface", "surface2", "surface3"]) {
      check(`${name} ${name2}-text/${bg}`, t[token], t[bg]);
    }
    for (const tint of [0.11, 0.18]) {
      for (const bg of ["bg", "surface"]) {
        const rowBg = over(rgb(name2 === "add" ? t.success : t.danger), tint, rgb(t[bg]));
        checkRgb(`${name} ${name2}-text/diff-tint${tint}(${bg})`, rgb(t[token]), rowBg);
      }
    }
  }
  // Syntax colors are accent-independent. Include both translucent diff
  // layers so keyword/comment colors remain readable inside changed words.
  for (const token of ["syntaxKeyword", "syntaxString", "syntaxLiteral", "syntaxComment"]) {
    for (const bg of ["bg", "surface", "surface2", "surface3"]) {
      check(`${name} ${token}/${bg}`, t[token], t[bg]);
      for (const [kind, tint] of [["add", t.success], ["del", t.danger]]) {
        const rowBg = over(rgb(tint), 0.11, rgb(t[bg]));
        const wordBg = over(rgb(tint), 0.18, rowBg);
        checkRgb(`${name} ${token}/${kind}(${bg})`, rgb(t[token]), rowBg);
        checkRgb(`${name} ${token}/${kind}-word(${bg})`, rgb(t[token]), wordBg);
      }
    }
  }
}

for (const [theme, set] of Object.entries(accents)) {
  const t = themes[theme];
  for (const [accent, a] of Object.entries(set)) {
    for (const bg of ["bg", "surface", "surface2", "surface3"]) {
      check(`${theme}/${accent} accentText/${bg}`, a.accentText, t[bg]);
    }
    check(`${theme}/${accent} accentContrast/accent`, a.accentContrast, a.accent);
    check(`${theme}/${accent} accentContrast/accentHover`, a.accentContrast, a.accentHover);
    const softBg = over(a.accentSoft.slice(0, 3).map((value) => value / 255), a.accentSoft[3], rgb(t.surface2));
    checkRgb(`${theme}/${accent} accentText/accentSoft(surface2)`, rgb(a.accentText), softBg);
  }
}

const pad = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(pad)}  ${r.ratio}:1  (min ${r.min}:1)`);
}
console.log(`\n${rows.filter((r) => r.ok).length}/${rows.length} pairs meet WCAG AA (4.5:1).`);
if (failures) process.exit(1);
