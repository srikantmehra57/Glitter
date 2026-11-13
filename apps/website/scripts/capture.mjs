// Captures real screenshots of the desktop app (apps/desktop dev:ui preview
// mode) for use on the marketing site. Requires `npm run dev:ui` at repo root.
//
//   node apps/website/scripts/capture.mjs [--base http://localhost:1420] [--only app,components,surfaces,window]
//
// Output: apps/website/public/shots/

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "..", "public", "shots");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg("base", "http://localhost:1420");
const ONLY = (arg("only", "app,components,surfaces,window")).split(",");
const URL = `${BASE}/?usage=preview`;

const THEMES = ["dark", "light"];
const ACCENTS = ["ember", "mono", "blue", "violet", "pink", "orange", "yellow", "green", "teal"];
const PAD = 16;

// Skip animations entirely (paused ones freeze mount animations at opacity:0).
const FREEZE_CSS =
  "*{animation:none!important;transition:none!important;caret-color:transparent!important}";
// Preview-mode-only chrome that should not appear in product shots.
const PREVIEW_HIDE_CSS = [
  ".exit-preview", // "Exit preview" row
  ".regrant-btn", // "Re-open" pill beside the workspace
  ".settings-connection", // "Preview mode" in the Settings footer
  ".jump-latest", // scroll affordance left over from the scripted scroll-to-top
]
  .map((sel) => `${sel}{display:none!important}`)
  .join("");

const results = [];
async function snap(page, name, options = {}) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, ...options });
  results.push(name);
  console.log(`  ✓ ${name}`);
}

/** Union of the bounding boxes of every locator + PAD, clamped to the viewport. */
async function cropShot(page, name, locators, pad = PAD) {
  let box = null;
  for (const locator of locators) {
    const b = await locator.boundingBox();
    if (!b) throw new Error(`no bounding box for ${name}`);
    const r = b.x + b.width;
    const bot = b.y + b.height;
    box = box
      ? {
          x: Math.min(box.x, b.x),
          y: Math.min(box.y, b.y),
          r: Math.max(box.r, r),
          b: Math.max(box.b, bot),
        }
      : { x: b.x, y: b.y, r, b: bot };
  }
  const vp = page.viewportSize();
  const clip = {
    x: Math.max(0, box.x - pad),
    y: Math.max(0, box.y - pad),
    width: Math.min(vp.width, box.r + pad) - Math.max(0, box.x - pad),
    height: Math.min(vp.height, box.b + pad) - Math.max(0, box.y - pad),
  };
  await snap(page, name, { clip });
}

async function newPage(browser, { theme, width = 1440, height = 900 } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: theme === "light" ? "light" : "dark",
  });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: "networkidle" });
  const explore = page.getByRole("button", { name: "Explore the interface" });
  if (await explore.isVisible().catch(() => false)) await explore.click();
  // Preview mode populates after hydration; wait for the dressed UI.
  await page.waitForSelector(".sidebar .thread", { timeout: 15000 });
  await page.waitForSelector(".conversation-inner .item, .conversation-inner > *", {
    timeout: 15000,
  });
  await page.waitForSelector(".composer .picker-trigger", { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.addStyleTag({ content: FREEZE_CSS + PREVIEW_HIDE_CSS });
  return { context, page };
}

/** Point the CSS theme/accent datasets at the requested look (no store write). */
async function setLook(page, theme, accent = "ember") {
  await page.evaluate(
    ([t, a]) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.dataset.accent = a;
      document.documentElement.dataset.sidebarAccent = "false";
    },
    [theme, accent],
  );
  await page.waitForTimeout(250);
}

/** The topbar PanelRight button toggles the review dock (⌘I). */
async function setDock(page, open) {
  const visible = await page.locator("aside.dock").isVisible().catch(() => false);
  if (visible !== open) {
    await page.locator('.icon-btn[aria-label="Toggle changes"]').click();
    await page.waitForTimeout(350);
  }
  if (open) {
    const back = page.getByRole("button", { name: "Back to changes" });
    if (await back.isVisible().catch(() => false)) await back.click();
    await page.waitForTimeout(250);
  }
}

/** Transcript to the top, run groups expanded so tool cards are visible. */
async function scrollTop(page) {
  for (const head of await page.locator(".group-head").all()) {
    if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  }
  await page
    .locator(".conversation")
    .evaluate((el) => {
      el.scrollTop = 0;
    })
    .catch(() => {});
  await page.waitForTimeout(300);
}

/** Click the sidebar thread row by its title. */
async function selectThread(page, title) {
  await page.locator(`.sidebar .thread:has-text("${title}")`).first().click();
  await page.waitForTimeout(500);
}

async function shootApp(browser, theme, accent) {
  const { context, page } = await newPage(browser, { theme });
  await setLook(page, theme, accent);
  await scrollTop(page);
  await setDock(page, true); // three-pane look: sidebar · transcript · changes
  await snap(page, `app-${theme}-${accent}.png`);
  await context.close();
}

async function shootWindow(browser, theme) {
  const { context, page } = await newPage(browser, { theme, width: 1280, height: 800 });
  await setLook(page, theme, "ember");
  await scrollTop(page);
  await setDock(page, true);
  await snap(page, `window-${theme}-ember.png`);
  await context.close();
}

async function shootComponents(browser, theme) {
  const { context, page } = await newPage(browser, { theme });
  await setLook(page, theme, "ember");
  await setDock(page, false);
  const composer = page.locator(".composer-beam");

  // Effort menu, at the model's default tier.
  await page.locator('#effort-meter').click();
  const effortMenu = page.locator('.effort-menu.select-menu-overlay .select-menu-popover');
  await effortMenu.waitFor({ state: "visible", timeout: 5000 });
  await page.waitForTimeout(250);
  await cropShot(page, `effort-open-${theme}.png`, [composer, effortMenu]);

  if (theme === "dark") {
    // Select the last tier so the peak state shows, then reopen its menu.
    await effortMenu.getByRole("option", { name: "Max" }).click();
    // The peak ripple self-removes after ~1.4s; wait it out so the shot is clean.
    await page
      .waitForFunction(
        () =>
          !document.querySelector(".effort-ripple") &&
          !document.querySelector(".app")?.classList.contains("thump"),
        { timeout: 5000 },
      )
      .catch(() => {});
    await page.waitForTimeout(400);
    await page.locator('#effort-meter').click();
    await effortMenu.waitFor({ state: "visible" });
    await cropShot(page, "effort-max-dark.png", [composer, effortMenu]);
    // Restore the model's default for the remaining shots.
    await effortMenu.getByRole("option", { name: /Medium/ }).click();
    await page.waitForTimeout(400);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // Model picker popover.
  await page.locator('#model-picker').click();
  await page.waitForSelector(".model-pop", { timeout: 5000 });
  await page.waitForTimeout(250);
  await cropShot(page, `model-open-${theme}.png`, [composer, page.locator(".model-pop")]);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // Idle composer — drop focus first so no trigger shows a focus ring.
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(150);
  await cropShot(page, `composer-${theme}.png`, [composer]);

  if (theme === "dark") {
    await cropShot(page, "sidebar-dark.png", [page.locator("aside.sidebar")], 0);
  }

  // Approval card on the running mock thread.
  await selectThread(page, "Stream agent events");
  const approval = page.locator("section.approval");
  if (await approval.isVisible().catch(() => false)) {
    await cropShot(page, `approval-${theme}.png`, [approval]);
  } else {
    console.log(`  ! approval card not visible for ${theme} — skipped`);
  }
  await selectThread(page, "Command center layout");

  // Settings modal on the Appearance tab.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.waitForSelector("dialog.settings-dialog", { timeout: 5000 });
  await page.locator('dialog.settings-dialog button[aria-label="Theme"]').click();
  await page.waitForSelector(".theme-panel", { timeout: 5000 });
  await page.waitForTimeout(250);
  await cropShot(page, `settings-theme-${theme}.png`, [
    page.locator("dialog.settings-dialog"),
  ]);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  await context.close();
}

/** The surfaces the features section shows: one cropped shot each, per theme. */
async function shootSurfaces(browser, theme) {
  const { context, page } = await newPage(browser, { theme });
  await setLook(page, theme, "ember");
  await scrollTop(page);

  // Find in thread, over the first message.
  await setDock(page, false);
  await page.keyboard.press("Meta+f");
  await page.waitForSelector(".find-bar", { timeout: 5000 });
  await page.keyboard.type("layout");
  await page.waitForTimeout(350);
  const main = await page.locator("main.main").boundingBox();
  await snap(page, `find-${theme}.png`, {
    clip: { x: main.x + main.width - 700, y: main.y, width: 700, height: 150 },
  });
  await page.locator('.find-bar button[aria-label="Close find"]').click();
  await page.waitForTimeout(250);

  // Diff tab, expanded so the lines are not cut.
  await setDock(page, true);
  await page.getByRole("button", { name: "Open changes for apps/desktop/src/App.tsx" }).click();
  await page.waitForTimeout(300);
  await page.locator('button[aria-label="Expand changes"]').click();
  await page.waitForTimeout(450);
  const dock = await page.locator("aside.dock").boundingBox();
  await snap(page, `diff-${theme}.png`, {
    clip: { x: dock.x, y: dock.y, width: 880, height: 400 },
  });
  await page.locator('button[aria-label="Restore split view"]').click();
  await page.waitForTimeout(450);
  await setDock(page, false);

  // Command palette.
  await page.keyboard.press("Meta+k");
  await page.waitForSelector("dialog.palette", { timeout: 5000 });
  await page.waitForTimeout(300);
  await cropShot(page, `palette-${theme}.png`, [page.locator("dialog.palette")], 0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);

  // The running thread: subagents, a background task and a pending approval.
  await setDock(page, true);
  await selectThread(page, "Stream agent events");
  await snap(page, `run-${theme}.png`);
  await selectThread(page, "Command center layout");
  await setDock(page, false);

  // Keyboard shortcuts in Settings.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.waitForSelector("dialog.settings-dialog", { timeout: 5000 });
  await page.locator('dialog.settings-dialog button[aria-label="Shortcuts"]').click();
  await page.waitForTimeout(350);
  await cropShot(page, `shortcuts-${theme}.png`, [page.locator("dialog.settings-dialog")], 0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // A new thread: the welcome art, the starting points and where the thread works.
  await page.locator(".sidebar .workspace-row.active button[aria-label^=\"New thread in\"]").click();
  await page.waitForSelector(".welcome-card", { timeout: 5000 });
  await page.waitForTimeout(500);
  await snap(page, `welcome-${theme}.png`);
  await cropShot(page, `welcome-card-${theme}.png`, [page.locator(".welcome-card"), page.locator(".suggestions"), page.locator(".composer-beam")], 28);
  await page.locator('header.topbar button:has-text("Local")').click();
  await page.waitForTimeout(350);
  const bar = await page.locator("header.topbar").boundingBox();
  await snap(page, `worktree-${theme}.png`, {
    clip: { x: bar.x + bar.width - 640, y: 0, width: 380, height: 200 },
  });
  await page.keyboard.press("Escape");

  await context.close();
}

// channel "chromium" uses the full Chromium build; CHROMIUM_PATH overrides it
// for machines where the bundled build is a different revision.
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chromium" },
);
await mkdir(OUT, { recursive: true });
try {
  if (ONLY.includes("app")) {
    for (const theme of THEMES) {
      for (const accent of ACCENTS) {
        await shootApp(browser, theme, accent);
      }
    }
  }
  if (ONLY.includes("components")) {
    for (const theme of THEMES) await shootComponents(browser, theme);
  }
  if (ONLY.includes("surfaces")) {
    for (const theme of THEMES) await shootSurfaces(browser, theme);
  }
  if (ONLY.includes("window")) {
    for (const theme of THEMES) await shootWindow(browser, theme);
  }
} finally {
  await browser.close();
}
console.log(`\n${results.length} screenshots written to ${OUT}`);
