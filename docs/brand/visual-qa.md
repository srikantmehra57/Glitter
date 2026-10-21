# Frost & Ember visual verification

final result: passed

## Scope and references

This redesign replaced the earlier monochrome pixel identity with Frost &
Ember across the desktop app and the website. The reference images (art
direction only, not Muse screens or instructions) showed, in words:

1. A matte light-grey canvas carrying a cluster of large frosted rounded-square
   tiles with an orange → amber → yellow glow bleeding through them and fading
   to grey with distance; a pure-white luminous rounded link shape with a soft
   glow overlapping the tiles; small grey sans-serif text.
2. The same cluster with a brighter yellow core.
3. A frosted translucent card (~16px radius, 1px light inner edge) over a vivid
   blurred orange/violet/blue field with a fine dot grid; light-weight large
   display text.
4. A smoked dark translucent popover (~24px radius) with a translucent-well
   segmented control and raised selection, an input row, list rows with
   rounded-square icon wells, a light raised "Invite" button, rounded-square
   avatars, and a dotted canvas grid.

## What shipped

- Tokens: Frost (light, matte #E6E6E6 canvas) and Smoke (dark, near-black #0A0A0B)
  plus glass/well/raised/glow/focus tokens; radii 8/16 with circles kept
  for dots, spinners, radios and switch knobs.
- A five-tile ember M mark (two tile pillars + a rounded ▽ wedge) shared
  across the sidebar, settings, onboarding, favicon and generated app icons
  (frosted-grey light tile / graphite dark tile).
- EmberTiles artwork on welcome and onboarding, and a matching tile cluster
  behind the website hero.
- Ember as the default accent; `system` as the default theme for new installs,
  with saved preferences untouched.
- Popovers/menus use near-opaque `--glass-strong` so content behind nested
  glass is never legible; light dialogs sit on a light veil backdrop.

## States captured and inspected

Desktop (1440×900, ember accent): new-thread welcome, welcome, transcript with
tool cards, approval card with pinned plan, composer with model menu, command
palette, Changes dock, terminal pane, onboarding, boot screen, and settings
(General/Appearance/Models) — each in both Frost and Smoke — plus transcript
passes in blue and mono accents. Website (1440×900 and 390×844): hero, pinned
tour stops, features, agents, effort dial, run, themes preview, install, and
footer in both themes. Mark renders were checked at 16/24/32/36/128px and as
the generated 1024px app icons.

## Gates run

- `npm run typecheck` — clean
- `npm test` — 551/551
- `npm run test:ui` — 175/175
- `npm run check:a11y` — passed (66 components)
- `npm run check:contrast` — 348/348 pairs meet WCAG AA 4.5:1 (light syntax
  tokens and the light teal accent text were darkened to get there)
- `npm run icons` — regenerated all icon formats
- `npm run build:website` — clean
- `node apps/website/scripts/verify-site.mjs` — full scroll-through of both
  breakpoints with zero console errors

Findings fixed during the pass: the mark's middle tile read as an "H" (replaced
with the rounded wedge), the link shape's three pills were merged into one
goo-molded path, the ember glow's hard rectangle was masked away, popover fills
were raised until transcript text could not be read through them, light dialog
backdrops became a light veil, and the pinned plan gained a solid strip with a
bottom fade.
