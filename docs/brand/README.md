# Glitter — Frost & Ember identity

The identity is a matte grey canvas with frosted glass chrome, soft diffuse
elevation, and a warm ember accent (orange → amber → yellow). It is independent
of Meta. The user-supplied October 2026 references are visual style references
only; their copy is not product copy.

## Mark and wordmark

`glitter-mark.svg` is the editable source of the Glitter mark: The Obsidian Monolith,
a standalone, non-alphabetical geometric emblem inspired by precision luxury hardware
(Teenage Engineering meets Apple Pro industrial design). Geometry (viewBox 64):

- Left Monolith Slab (faceted titanium/obsidian): Chamfered prism wing spanning
  (14, 18) to (28, 57), rendered in deep space-titanium and obsidian gradients
  (#5A5A66 → #363640 → #202026 → #141418) with specular rim chamfer highlights.
- Right Monolith Slab (faceted smoky obsidian): Symmetrical chamfered wing spanning
  (36, 7) to (50, 46) in warm smoky obsidian tones (#463E36 → #2D2520 → #140F0D)
  catching amber edge bounce light.
- Fissure Chamfer Lips: Recessed bevels flanking the central fissure that catch
  molten incandescent reflections (#FFA826 → #FF7A00 → #D94800).
- Central Molten Plasma Fissure: A vertical hairline laser channel glowing from
  pure white to blazing golden amber (#FFF8E7 → #FFD680 → #FFA019 → #FF6A00),
  anchored by a central concentrated spark node at (32, 32).
- Ambient Plasma Radiance: 26px radial caustic glow (#FF9E1A at 45% falling off to
  transparent) delivering rich optical presence across light and dark surfaces.

The mark reads cleanly at 16–36px in the interface beside “Glitter” (17px,
weight 600, -0.03em tracking) and scales up to 1024px for macOS dock and App Store tiles.
Avoid decorative glyph substitutes.

## Icon generation

Run `npm run icons` after editing the vector source. `scripts/generate-icons.mjs`
copies the mark to `apps/desktop/public/spark.svg` and
`apps/website/public/spark.svg`, then embeds the mark's inner SVG (with unique
gradient ids) at 0.75 scale on a rounded `rx=14` tile:

- `glitter-icon-light.svg` — frosted silver tile (#F8F8FA → #DCDCE2, specular rim highlight)
- `glitter-icon-dark.svg` — space-black brushed titanium tile (#24242C → #121216, specular rim highlight)

It writes 1024px `glitter-light.png` / `glitter-dark.png` into
`apps/desktop/src-tauri/icons/` and regenerates all native icon formats with
`tauri icon` using the dark titanium tile for macOS Dock.

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
