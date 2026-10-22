# Glitter — Frost & Ember identity

The identity is a matte grey canvas with frosted glass chrome, soft diffuse
elevation, and a warm ember accent (orange → amber → yellow). It is independent
of Meta. The user-supplied October 2026 references are visual style references
only; their copy is not product copy.

## Mark and wordmark

`glitter-mark.svg` is the editable source of the Glitter mark: the Prismatic
Spark Core, fusing a geometric letter G with an illuminated four-pointed diamond
spark (the Glitter Stella). Geometry (viewBox 64):

- Continuous geometric G contour: radius 20 arc centered at (32, 32) sweeping
  from (46, 18) clockwise through the base to (52, 32), turning into a horizontal
  spur ending at x 34. Authored with 8px stroke width and rounded caps.
- Four-pointed faceted diamond spark: centered at (31, 32), top/bottom vertices
  at y 16.5 and y 47.5, horizontal span from x 16.5 to x 43.5 meeting the G's spur.
  Four directional facets capture overhead specular illumination and warm ember
  depth.
- One shared `userSpaceOnUse` ember gradient (#E8730C → #F5A313 → #FFD24A) plus
  an overhead white specular sheen (~35% opacity falling off at 45%).

The mark reads at 16–36px in the interface beside “Glitter” (17px, weight
600, -0.03em tracking) and scales up to 1024px for macOS dock and App Store tiles.
Avoid decorative glyph substitutes.

## Icon generation

Run `npm run icons` after editing the vector source. `scripts/generate-icons.mjs`
copies the mark to `apps/desktop/public/spark.svg` and
`apps/website/public/spark.svg`, then embeds the mark's inner SVG (with unique
gradient ids) at 0.75 scale on a rounded `rx=14` tile:

- `glitter-icon-light.svg` — frosted grey tile (#F2F2F2 → #DADADA, white inner edge)
- `glitter-icon-dark.svg` — graphite tile (#2C2C30 → #18181A, subtle inner edge)

It writes 1024px `glitter-light.png` / `glitter-dark.png` into
`apps/desktop/src-tauri/icons/` and regenerates all native icon formats with
`tauri icon`. The running Mac Dock icon follows OS appearance independently of
the app's theme.

## EmberTiles artwork

Welcome and onboarding art is `apps/desktop/src/components/EmberTiles.tsx`:
a DOM-rendered 4×3 grid of frosted rounded tiles over a blurred ember glow
layer (masked so no glow edge is visible), opacity falling off toward the far
tiles, plus one molded white link shape (goo-filtered rounded rects with a soft
drop shadow). It is static, decorative (`aria-hidden`), and falls back to solid
tile fills when `backdrop-filter` is unavailable or `prefers-reduced-transparency`
is set. The website implements the same recipe in its own markup
(`.hero-tiles`) since it is an independent app.

## Retired assets

`pixel-loop.png`, `pixel-field.png`, `glass-tiles.svg` and `glass-field.svg` in
`apps/desktop/public/brand/` are retired: they remain on disk but are no longer
referenced anywhere.

## UI system

`docs/DESIGN_SYSTEM.md` documents layout and behavior. The sole palette lives in
`apps/desktop/src/styles.css`; `settings.css` uses those same tokens. New installs
start with the `system` theme and the Ember accent; saved choices are preserved.
Semantic status colors are reserved for actionable states and diff direction.
