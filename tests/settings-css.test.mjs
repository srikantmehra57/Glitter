import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const css = readFileSync(new URL("../apps/desktop/src/settings.css", import.meta.url), "utf8");

function declarations(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `Missing Settings rule: ${selector}`);
  return match[1].replace(/\s+/g, " ").trim();
}

function contains(actual, ...expected) {
  for (const value of expected) assert.ok(actual.includes(value), `Missing declaration: ${value}`);
}

describe("Settings visual contracts", () => {
  it("uses an independent fixed rail and an opaque two-surface shell", () => {
    contains(
      declarations(".settings-dialog"),
      "--settings-nav-width: 240px",
      "background: var(--surface)",
      "box-shadow: none",
    );
    contains(
      declarations('dialog.settings-dialog:is([open], [data-closing])'),
      "grid-template-columns: var(--settings-nav-width) minmax(0, 1fr)",
    );
    contains(declarations(".settings-nav"), "background: var(--bg)");
    contains(
      declarations(".settings-main"),
      "background: var(--surface)",
      "border-left: 1px solid var(--border)",
    );
  });

  it("keeps the shared reading column and compact page heading", () => {
    contains(declarations(".settings-section-body"), "padding: 28px 40px 80px");
    contains(declarations(".settings-column"), "max-width: 760px");
    contains(declarations(".settings-page-usage .settings-column"), "max-width: 960px");
    contains(declarations(".settings-section-head"), "border-bottom: 0");
    contains(declarations(".settings-section-head h3"), "font-size: var(--text-2xl)");
  });

  it("pins compact card and control geometry, including the switch hit area", () => {
    contains(declarations(".settings-nav-group button"), "height: 32px");
    contains(declarations(".settings-search"), "height: 32px");
    contains(
      declarations(".settings-card"),
      "border: 1px solid var(--border)",
      "border-radius: var(--r-sm)",
      "background: transparent",
    );
    contains(declarations(".setting-row"), "min-height: 56px", "padding: 12px 16px");
    contains(declarations(".settings-dialog .select-trigger"), "min-height: 32px");
    contains(
      declarations(".settings-dialog .ghost-btn.small, .settings-dialog .secondary.small"),
      "height: 26px",
    );
    contains(declarations(".settings-dialog .toggle"), "width: 32px", "height: 18px");
    contains(declarations(".settings-dialog .toggle::before"), "inset: -5px -2px");
    contains(declarations(".settings-dialog .toggle i"), "width: 14px");
    contains(
      declarations('.settings-dialog .toggle[aria-checked="true"] i'),
      "transform: translateX(14px)",
    );
  });

  it("scopes flat embedded surfaces and portaled menus to Settings", () => {
    contains(declarations(".settings-dialog .catalog-card"), "box-shadow: none");
    contains(
      declarations('.settings-dialog .usage-periods button[aria-selected="true"]'),
      "box-shadow: none",
    );
    contains(
      declarations('html[data-settings="open"] .select-menu-overlay .select-menu-popover'),
      "background: var(--surface-2)",
      "backdrop-filter: none",
    );
    contains(
      declarations('html[data-settings="open"] .select-menu-overlay .select-option[aria-selected="true"]:not(:disabled)'),
      "background: var(--active)",
    );
  });

  it("keeps horizontal navigation and wrapping rows in narrow windows", () => {
    const start = css.indexOf("@media (max-width: 720px)");
    assert.ok(start >= 0, "Missing narrow Settings layout");
    const compact = css.slice(start).replace(/\s+/g, " ");
    contains(
      compact,
      "grid-template-rows: auto minmax(0, 1fr)",
      ".settings-nav-groups { flex: none; flex-direction: row;",
      ".settings-section-body { padding: 20px 16px 56px;",
      ".setting-row, .settings-card > .agent-default-section { flex-wrap: wrap;",
      ".setting-control { max-width: 100%;",
    );
  });
});
