// Headless visual pass over the site. Start `npm run preview -w @glitter/website` first.
//   node apps/website/scripts/verify-site.mjs [outDir]
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const BASE = process.env.BASE ?? "http://127.0.0.1:4174";
const OUT = process.argv[2] ?? "/tmp/glitter-site-shots";
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: process.env.GPU_ARGS ? process.env.GPU_ARGS.split(" ") : [] });
const errors = [];

async function open({ width = 1440, height = 900, theme = "dark", accent = "blue" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme });
  await context.addInitScript(
    ([t, a]) => localStorage.setItem("glitter-site-theme", JSON.stringify({ theme: t, accent: a })),
    [theme, accent],
  );
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  return { context, page };
}

async function scrollTo(page, fn) {
  await page.evaluate(fn);
  await page.waitForTimeout(1800);
}

const shots = [];
async function snap(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  shots.push(`${OUT}/${name}.png`);
}

const at = (sel, frac = 0) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); const top = el.getBoundingClientRect().top + window.scrollY; window.scrollTo(0, top + ${frac} * (el.offsetHeight - innerHeight)); })()`;

for (const [w, h, tag] of [[1440, 900, "1440"], [390, 844, "390"]]) {
  const { context, page } = await open({ width: w, height: h });
  await snap(page, `${tag}-01-hero`);
  await scrollTo(page, at("#room", 0.02)); await snap(page, `${tag}-02-room-head`);
  await scrollTo(page, at("#tour", 0.05)); await snap(page, `${tag}-03-tour-0`);
  await scrollTo(page, at("#tour", 0.45)); await snap(page, `${tag}-04-tour-2`);
  await scrollTo(page, at("#tour", 0.25)); await snap(page, `${tag}-04a-tour-1`);
  await scrollTo(page, at("#tour", 0.7)); await snap(page, `${tag}-05-tour-3`);
  await scrollTo(page, at("#tour", 0.95)); await snap(page, `${tag}-05b-tour-4`);
  await scrollTo(page, at("#features", 0.15)); await snap(page, `${tag}-06-features`);
  await scrollTo(page, at("#features", 0.7)); await snap(page, `${tag}-07-features-b`);
  await scrollTo(page, at("#agents", 0.05)); await snap(page, `${tag}-07b-agents`);
  await scrollTo(page, at(".orbit", 0.5)); await snap(page, `${tag}-07c-agents-orbit`);
  await scrollTo(page, at(".dial-stage", 0.5)); await snap(page, `${tag}-08-dial`);
  await page.keyboard.press("Tab");
  await page.focus("#scrubber"); await page.keyboard.press("End"); await page.waitForTimeout(1500);
  await snap(page, `${tag}-09-dial-max`);
  await scrollTo(page, at("#run-wrap", 0.5)); await snap(page, `${tag}-10-run`);
  await scrollTo(page, at("#themes", 0.1)); await snap(page, `${tag}-11-themes`);
  await page.click('[aria-label="Rosewater"]'); await page.waitForTimeout(1600);
  await snap(page, `${tag}-12-themes-pink`);
  await page.click('[data-theme-pick="light"]'); await page.waitForTimeout(1600);
  await snap(page, `${tag}-13-themes-light-preview`);
  if (w > 860) { await page.evaluate(() => document.getElementById("theme-toggle").click()); await page.waitForTimeout(1600); await snap(page, `${tag}-13b-site-light`); }
  await scrollTo(page, at("#install", 0.1)); await snap(page, `${tag}-14-install`);
  await scrollTo(page, at(".finale", 0.2)); await snap(page, `${tag}-15-finale`);
  await scrollTo(page, "window.scrollTo(0, document.body.scrollHeight)"); await snap(page, `${tag}-16-footer`);
  await context.close();
}
{
  const { context, page } = await open({ theme: "light", accent: "violet" });
  await snap(page, "1440-17-hero-light");
  await context.close();
}

const { context, page } = await open();
try {
  const body = await page.locator("body").innerText();
  assert.match(body, /Harness is built in\./, "Harness is presented as built in");
  assert.match(body, /macOS 13\+/, "the supported OS is explicit");
  assert.match(body, /View releases|Build from source/, "release and source actions remain available");
  assert.doesNotMatch(body, /macOS and Windows/i, "unsupported platforms are not advertised");
  assert.doesNotMatch(body, /Requires the `muse` CLI/i, "Muse is optional, not required");
  const links = await page.locator("a[href]").evaluateAll((anchors) => anchors.map((anchor) => anchor.href));
  assert.equal(links.some((href) => href.includes("/releases/download/")), false, "download CTAs must not point to a nonexistent release asset");
} finally {
  await context.close();
}
assert.equal(errors.length, 0, `browser console errors:\n${errors.join("\n")}`);
console.log("console errors:", errors.length ? errors : "none");
console.log(shots.join("\n"));
await browser.close();
