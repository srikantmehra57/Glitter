# Muse Code Desktop — Design System

Implementation must follow this document. Tokens live in
`apps/desktop/src/styles.css`; where this document and the stylesheet disagree,
the stylesheet wins and this document should be corrected.

---

## Product principles

1. **Protocol-honest.** Show what Muse is doing. Never invent chain-of-thought. Prefer host todos, goals, tool names, and exit codes.
2. **Frost and ember.** Matte grey canvas, frosted glass panels, soft diffuse elevation, an ember glow as the brand signal. Transcripts, code and diffs always sit on solid surfaces; glass is for chrome (composer, popovers, dialogs), and the sidebar sits on the shell, which can show the window's own material. Live agent state uses `thinking-orbs` (`components/Orb.tsx`) and a restrained pulsing composer rule.
3. **Desktop, not web.** System type, overlay titlebar, dense lists, real menus/palettes, no remote fonts.
4. **Density with hierarchy.** Developer sessions are long. Prefer 13px body, tight rows, collapsed tools. Hierarchy from contrast and spacing, not cards.
5. **One vocabulary.** Workspace, Thread, Agent, Run, Plan, Changes, Terminal.
6. **Every control is real.** Hidden > disabled > fake.

---

## Terminology

| Use | Do not use |
|---|---|
| Workspace | Project (UI may say “Open a workspace”; “Add project” is retired) |
| Thread | Chat, conversation, session (except protocol errors) |
| Agent / Run | Task, job (unless quoting a host field) |
| Plan | Todo list (internal only) |
| Changes | Review dock, git panel |
| Terminal | The integrated terminal pane: the user's own shell on a PTY. Not the shell card in a run (a “command” step) and not the composer's `!` escape (a “shell command”) |
| Local / Worktree | Where a thread works: the workspace folder, or its own checkout on a `muse/` branch. Not “sandbox”, “copy” or “isolated mode” |
| Stop | Cancel turn (button label: Stop) |

Copy: short, present tense, no “successfully been executed.”

- Bad: “There are currently no previous conversations.”
- Good: “No threads yet”

Errors always answer: what happened, whether work was lost, what to do, whether we can recover.

---

## Color

The source of truth for every value is the token block at the top of
`apps/desktop/src/styles.css`. Don't copy hex values into components or into
this document; reference the token.

**Themes.** `:root` holds the dark theme, **Smoke** — a matte near-black canvas
with smoked glass — and `html[data-theme="light"]` overrides it with **Frost** —
a matte light-grey canvas with frosted-white glass. New installations default to
`system` (follows the OS); existing preferences remain intact.

| Token | Role |
|---|---|
| `--bg` | Window under-layer |
| `--shell`, `--shell-opacity` | The surface behind the sidebar and the gutter around the main panel: `--bg`, or `--bg` tinted with the accent. `lib/theme.ts` sets the opacity (0–1) of the layer that paints it; below 1 the window's material shows through |
| `--surface`, `--surface-2`, `--surface-3` | Solid panels, raised rows, wells, from lowest to highest — where transcript, code and diff content lives |
| `--ink` | Primary text |
| `--secondary` | Secondary text |
| `--tertiary` (alias `--muted`) | Meta, timestamps, captions only |
| `--border`, `--border-heavy` | Subtle dividers; composer and dialogs |
| `--hover`, `--active`, `--fog` | Row hover, pressed, selected |
| `--glass` | Frosted panel fill (boot panel, settings rail) with `backdrop-filter` |
| `--glass-strong` | Near-opaque popover/menu fill — nested `backdrop-filter` cannot blur, so the fill must carry the obscuring |
| `--glass-edge` | 1px inner top highlight on glass surfaces |
| `--glass-blur` | Shared `backdrop-filter` recipe for glass chrome |
| `--well` | Recessed track under segmented controls and inputs |
| `--raised` | Raised tile: the selected segment, an active row, secondary buttons |
| `--glow-a`, `--glow-b`, `--glow-c` | Ambient accent-derived glow colors (app corner glow, EmberTiles art) |
| `--accent`, `--accent-hover`, `--accent-soft`, `--accent-text`, `--accent-contrast` | Focus, selection and links; tinted backgrounds; text on accent fills |
| `--accent-fill` | Primary button/handle fill — flat accent, or a gradient under the ember accent |
| `--focus` | Focus ring color (accent-derived, ≥3:1 against `--bg`) |
| `--success`, `--warning`, `--danger` | Status |
| `--diff-add`, `--diff-del` | Diff gutters and counts |
| `--syntax-keyword`, `--syntax-string`, `--syntax-literal`, `--syntax-comment` | Code token colours (per theme) |
| `--on-ink` | Text on `--ink` fills |
| `--shadow-sm`, `--shadow`, `--shadow-pop` | Soft diffuse elevation (overlays only) |

**Accents.** `ember` (Ember) is the default: primary actions use `--accent-fill`
(an ember gradient) with `--accent-contrast` text. `mono` (Monochrome) keeps the
flat ink-on-inverse treatment, and seven optional palettes (`blue`, `violet`,
`pink`, `orange`, `yellow`, `green`, `teal`) remain available under Appearance;
existing selections are preserved. Set the palette on
`html[data-accent]`; components never pick their own brand accent. Diff direction,
errors, and approval warnings retain their semantic status colors and labels.

**Contrast is enforced.** `npm run check:contrast` reads the actual token blocks
in `styles.css` and measures text/background, semantic, syntax, diff, and accent
pairs in both themes and all eight accents against WCAG AA (4.5:1). It must not
carry a second hardcoded color palette.

---

## Typography

```
--font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", system-ui, sans-serif;
--font-mono: "SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace;
```

No Google Fonts. No webfont download.

| Role | Size | Weight | Tracking |
|---|---|---|---|
| Display (welcome titles) | 34–38px (30px at compact widths) | 400 | -0.035em |
| Settings page title | 28px | 500 | -0.04em |
| Brand wordmark | 17px | 600 | -0.03em |
| Title (thread name) | 13px | 600 | -0.01em |
| Body | 13px | 400 | -0.01em |
| Compact | 12px | 400 | 0 |
| Caption | 10–11px | 400 | 0.02em |
| Mono | 12px | 400 | 0 |

---

## Spacing

Scale: 2, 4, 6, 8, 10, 12, 16, 20, 24, 32.

- Sidebar row padding: 6×8
- Conversation column: `min(720px, 100% - 40px)`
- Inspector width: 360 default, user-resizable from 300 up to the smaller of 60% of the window or the space that leaves the thread 336
- Title bar height: 52 (the window controls sit on its centre line; 50 in compact browser windows)

---

## Radius

Use the tokens, not literal pixel values:

| Token | Value | Use |
|---|---|---|
| `--r-sm` | 12px | Detail elements: menu and option items, key caps, inline code, progress tracks, rename inputs |
| `--r-md` | 18px | Inputs, cards in the transcript, code blocks |
| `--r-lg` | 20px | Cards, popovers, dialogs |
| `--r-xl` | 24px | The composer, the command palette |
| `--r-pill` | 999px | Capsule ends on single-line controls and rows: buttons, chips, icon buttons, sidebar and file rows, picker and menu triggers |
| `--r-panel` | `--r-lg` | The main panel |

Section surfaces run round: the composer and palette take the full 24px, and
every clickable row, chip and button is a capsule on `--r-pill`. Menu items and
multi-line options stay on `--r-sm`, where a capsule would read as a bubble.

The window's own corner radius is 16pt on macOS 26 and later; `--shell-gap` is
the gutter between the window edge and the main panel. The panel takes the
section scale's `--r-lg` rather than nesting inside the window corner, where the
8px carve read sharper than every other surface.

Circles are allowed for status dots, spinners, radio knobs and avatars-as-dots;
switches are pill tracks with round knobs.

---

## Borders and elevation

Hierarchy from background + 1px border plus soft diffuse shadows. Use
`--shadow-sm` for hairline lift, `--shadow` for cards and panels, and
`--shadow-pop` for popovers, the palette and dialogs. Each theme defines its own
values.

Popovers and menus are near-opaque glass (`--glass-strong` + `--glass-blur` +
`--glass-edge`): a popover nested inside another backdrop-filtered surface (the
composer) cannot blur what's behind it, so its fill must be opaque enough that
content never stays legible through it.

---

## Iconography

One set: `lucide-react`, 13–16px, 1.75–2 stroke, monochrome `currentColor`.
Status uses a 6px dot: muted idle, accent unread, success running, danger error.

Rounded-square icon wells (`--well` fill, 28px in suggestion tiles and 26px
in the settings navigation) may hold icons in list rows and navigation; never in
transcript rows.

---

## Motion

Every state change eases; nothing snaps and nothing lingers. Use the tokens,
not literal milliseconds:

| Token | Value | Use |
|---|---|---|
| `--dur-1` | 120ms | Hover, press and colour changes |
| `--dur-2` | 180ms | Popovers, menus, switches, small reveals |
| `--dur-3` | 240ms | Panels, dialogs, page changes, the sidebar column |
| `--ease` | standard | Colour and opacity |
| `--ease-out` | decelerate | Anything that enters or changes size |
| `--ease-spring` | slight overshoot | Switch knobs, radio dots and check marks only |

- **Rows and controls.** Hover, selected and focus states transition over
  `--dur-1`. Buttons scale down slightly while pressed.
- **Accent fills.** A control filled with `--accent-fill` keeps that fill in
  every state. Under the ember accent it is a gradient, and a gradient cannot
  ease into a flat colour: the image drops out at once and the colour fades up
  from nothing, which flickers. The hover colour is a `::before` layer that
  fades in over the fill.
- **Popovers** enter from the side they are anchored to: `pop-in` opens
  downward, `pop-up` upward, `pop` where the side is chosen at runtime. Set
  `transform-origin` to the anchor corner.
- **Dialogs** use `dialog-in`, with the backdrop fading in alongside.
- **Disclosure.** Content a user opens grows in and shrinks out with
  `<Collapse>` (height and opacity). Pass `animate={false}` for content the
  virtual list restores rather than the user opens, so scrolling cannot shift.
- **Layout.** The sidebar column and the Changes pane animate their width; the
  transcript gives way instead of jumping.
- **Arrivals.** New blocks in the live turn rise in with `rise-in`.
- **Exits.** Whatever animates in also animates out, faster than it came:
  sections shrink with `.reveal.closing`, popovers use `pop-out` over
  `--dur-1`, dialogs `dialog-out` and the Changes pane `dock-out` over
  `--dur-2`. Keep the element mounted for the exit with `usePresence`,
  `<Presence>` or `<Collapse>` and add the `closing` class; never delay the
  state change itself (see DECISIONS.md). Lists whose content disappears with
  the query, like the composer's mention and slash menus, close at once.

Honor `prefers-reduced-motion: reduce` — no transitions, no pulse.

Settings → Appearance offers the nine `thinking-orbs` animations with a live
preview in the current accent, neutral by default. The saved choice applies to Muse's live thinking
indicator; Automatic uses Working normally and Solving at peak effort. Paused,
connecting and empty states retain their existing treatment.

Do not animate decorative blobs.

---

## Component behavior

### Thread row

Shows title, relative time, status dot. Running is a success pulse (disabled if reduced motion). Unread is accent, never the same as running. Hover reveals pin. Context menu: Rename, Pin, Archive.

### Agent step / tool card

One line by default: icon, verb, path or command, status, duration. Expand for output/error. Routine completed reads/searches start collapsed. Failures start expanded.

### Plan

Checklist. `completed` check, `inProgress` filled current, `pending` empty, `cancelled` muted strike.

### Composer

Attached to the thread, not a floating island. Enter sends, Shift+Enter newline. Stop replaces send while running. Context chips are removable.

The writing area sits on `--surface`, above a fine divider and a quiet toolbar.
Attach and mention share a group, separated from the run settings by a rule;
context usage and Send form the trailing group. Max keeps the same composer
surface and changes the effort control's tone.

The toolbar is one row that reads left to right: what to add (attach, mention),
how to run it (model and reasoning, permissions), then status and action
(context meter, Send). The selectors are one family of 28px outlined controls
(`.picker-trigger`, and `.select-trigger` inside `.composer-foot`). The model
control combines the agent mark, model name and effort in one trigger.
A mode never changes its shape, only its tone: Max takes the peak palette and
Unrestricted the warning colour for as long as it is selected. When the composer
narrows, the model name truncates first, then labels fold to their icons; the
row never wraps.

Keep a 16px clear buffer above the composer. It is the final surface in the
thread column: nothing may render below it, including warnings, capabilities,
worktree details, status lines or the terminal. Status and recovery controls
belong inside the input frame; worktree details sit above its writing area.
The terminal sits above the buffer. While a setting is applied the controls
are locked but keep their look (`.settling`), so the toolbar does not blink.

The thread column is one width: transcript content, the pinned plan, the
terminal pane and the composer share `--composer-inset` and a 720px
`--content-max` on `.thread-main`, so every edge lines up at any width. Edge
chrome follows the column — the prompt rail hugs the panel's left edge,
vertically centred, and the find bar sits just inside its right edge.

Third-party capabilities open in a dismissible dialog once per agent during
the app session, with a persisted "Don’t show again" choice. The model picker's
header has a Capabilities action to reopen the dialog at any time.

The model picker opens above the composer and stays within the window, with
two views. When the selected model takes reasoning effort the picker lands on
a compact effort card: a head row with the Fast-mode toggle (a Zap that pairs
a model with its `-fast`/`-build-fast` sibling, when the catalog lists one), a
centre button naming the tier in accent colour over the model's name, and a
reset button that returns to the model default. The Models view holds the
agent switcher, a scrollable catalog with provider groups, search when there
are more than six models, and the contributor disclosures. Choosing a model
with effort returns to the effort card; Escape from the catalog goes back to
it too, and closes otherwise.

Reasoning effort rides a thin rail in the effort card — Muse's own slider,
not a borrowed one: a hairline track with a tick notch per tier the model
supports, an accent-gradient fill that glows up to a small orb thumb, and the
tier's own words underneath. Drag or click the rail and the pick commits on
release; arrow keys, Home and End work on the focused slider. Commits keep
the picker open so tiers can be compared in place; Escape, the close button
or clicking outside dismiss it. The peak tier turns the fill into a drifting
turbo gradient and the orb warm, pulsing. Picks during an apply merge into a
trailing request, and a rejected pick returns the thumb to the session's
applied value. The model and
effort commands open the same picker on the catalog or the card.

In the model list a check trails the selected capsule row, a Zap marks the
base row while its fast variant is selected, and price sits right of the name,
so rows compare at a glance.

### Completion

Completed turns use a compact strip separated from the reply by a fine rule:
Done, duration, output tokens and estimated cost share a row with Undo and Fork.
File changes and snapshot notices sit underneath. Usage stays attached to the
matching latest turn; estimates retain their `~` or `≈` marks. Failed, stopped
and interrupted turns retain their explicit state and recovery controls.

### Settings

Select menus portal directly into their enclosing dialog, outside its body
scroller. Their positions use the dialog's padding box, accounting for borders
and animation scale; viewport coordinates belong only to menus outside a
dialog. Keep every option within the dialog and choose the side with room.

New-thread defaults query the preferred new-thread agent's current catalog
when Models opens. They never reuse or replace a conversation's model list.
Show loading or query errors, and identify unlisted saved selections explicitly;
preserve the preference until the user chooses another model or the host default.

A two-pane glass dialog (`--glass-strong`): categories on a frosted rail at the
left — each a `--r-sm` row with a 26px `--well` icon well, the active one a
`--raised` tile — and the page at the right on `--surface-2` cards. Every page
uses one column (`.settings-column`, 680px) so cards line up from tab to tab.

- A setting is a row in a card (`.setting-row`): name and one line of help on
  the left, the control on the right. Selects and text fields are 240px wide.
- A group of rows gets a heading (`.settings-card-heading`); a sentence that
  qualifies a card sits under it (`.settings-note`); context that needs a box
  uses `.settings-callout`.
- Switches use `.toggle`: a 36×22 pill track in `--accent-fill` when on, with a
  round knob in `--accent-contrast`. Exclusive choices use the radio list.
- A continuous value uses `.slider`: a thin track filled to a round thumb, with
  the value beside it. It repaints while it is dragged and saves once, when the
  gesture ends.
- The footer shows connection state and, for host settings, the restart action.

### Prompt rail

A dash per message the user sent, at the left edge of the transcript, with the
current one longer and at full ink. Hover or keyboard focus opens it into a list
of first lines; choosing one scrolls to that message. It appears once a thread
has two prompts.

### Title bar

The title bar is one strip of the shell across the top of the window
(`--titlebar-height`). The window controls, the sidebar's buttons, the thread
title and the panel's actions all sit on its centre line, in that order. It has
no fill and no edge of its own, so the accent tint and the window's translucency
reach it as they reach the sidebar. The main panel starts below it and holds
only the thread; the title bar is never drawn inside the panel. Its title lines
up with the panel's left edge and its last action with the panel's right edge.

Show/Hide sidebar is one button, straight after the window controls whichever
way the sidebar is, so it never moves under the pointer. Toggling the sidebar
moves the rest of the title bar sideways only. Nothing in the panel shifts up or
down.

### Collapsed sidebar

The sidebar gives up its column entirely. New thread, Open workspace and
Settings join Show sidebar in the title bar after the window controls
(`--window-controls`), and the title starts after them. Nothing may sit under
the window controls.

Clicking Show sidebar expands the sidebar again; hovering the toggle does
nothing. Only an explicit toggle — the button or the keyboard shortcut —
changes the saved layout.

### Inspector

Appears when the user opens Changes or when the workspace is dirty *and* they have not dismissed it. Not a permanent third column on clean trees after first dismiss.

It is a real pane beside the transcript, not an overlay: a left-edge separator resizes it with pointer or arrow keys (24px, Shift 96px, Home/End to the bounds), and the saved width persists across launches without following window resizes. An expand action swaps the transcript for the pane — the composer stays visible — and at ≤1000px the same focused layout applies with an explicit Thread / Changes toggle instead of a floating panel. The header folds its counts and stats first so it fits at 300px (dock container query, no overflow).

The Diff tab renders structured rows — an old/new line-number gutter (full `--ink`, never the faint tertiary on tinted rows), a sign column, then code — with changed-word marks at `--diff-add`/`--diff-del` alpha .18 over the .11 row tint. A Unified/Split preference only takes effect when the pane's rendered width reaches 640px (measured, not the saved value); long lines scroll horizontally rather than wrapping. The same row renderer backs edit-approval previews, without numbers when the source positions are unknown.

**Syntax colouring.** Code gets theme-aware token colours from four tokens — `--syntax-keyword`, `--syntax-string`, `--syntax-literal`, `--syntax-comment` — applied as `.syntax-*` classes; everything else stays `--ink`. Mark direction still comes from row tint + word marks, which compose with token colours. Highlighting is lazy (highlight.js core + per-language grammar chunks), debounced and bounded — unknown languages, oversized sources and any failure render the exact same text uncoloured; no highlighter theme CSS is imported. The renderer is shared between the Diff tab, approval previews and Markdown code blocks.

### Palette

Centered, 420px, search field + command rows with shortcut glyphs. Arrow keys + Enter. Esc closes.

### Dialogs

`<dialog>` with backdrop. Esc = cancel (discard drafts). Do not persist on backdrop without an explicit Done.

---

## State patterns

| State | Treatment |
|---|---|
| Empty | Title + one next action |
| Loading | Named status (“Opening thread…”) not a mystery spinner |
| Running | Timeline + plan + Stop |
| Waiting | Approval / question card, focus moved, `alertdialog` |
| Failed | Banner + retry/settings |
| Interrupted | Receipt on the run + Continue |
| Offline | Top banner, composer disabled |
| Preview | Badge on sidebar; no live host commands |

---

## Accessibility

- Visible 2px `--focus` rings, 2px offset (inset on rows)
- Icon-only buttons have `aria-label`
- Transcript `role="log"`; running status `aria-live="polite"`
- Contrast ≥ 4.5:1 for all text, enforced by `npm run check:contrast` (`--tertiary` is for captions only)
- Tab order: sidebar → thread → composer → inspector
- Skip link retained
- Minimum hit target 28px (32px preferred for primary)

---

## macOS

- Overlay titlebar, `hiddenTitle`, traffic lights inset (18, 28). macOS 27
  centres them 2pt above that inset, on the title bar's centre line (y 26)
- Drag regions on titlebar and sidebar top
- No custom window controls
- `⌘,` Settings, `⌘N` new thread, `⌘K` palette — do not steal `⌘Q` / `⌘W` / `⌘H` / `⌘M`
- Reduced transparency: `prefers-reduced-transparency` swaps glass fills for
  solid surfaces so contrast stays predictable, and keeps the shell opaque
- The window is transparent over the system `sidebar` material. Only the shell
  lets it show; the main panel, dialogs and the boot screen are opaque. The
  window takes the interface's light or dark appearance so the material matches
  an explicit theme (Appearance → Sidebar → Translucency sets how much shows)

---

## Brand

The identity combines the five-tile ember M mark, frosted glass surfaces,
system sans typography, and a warm ember accent.
`docs/brand/muse-mark.svg` is the editable source: two pillars of two stacked
rounded tiles each, with a rounded downward-pointing wedge (▽) between them —
the silhouette reads `|▽|`. All tiles share one ember gradient plus a white top
sheen. Use it at 16–36px beside “Muse Code”; it reads on both light and dark UI
without theme switching. App icons embed the mark on a frosted-grey tile
(light) or a graphite tile (dark); the running Mac Dock icon follows
the OS appearance, independently of an explicit interface theme selection.
Footer/About: **Not affiliated with Meta.** No Meta wordmark.


## Frost & Ember identity and welcome panels

Shared radii use `--r-sm` through `--r-xl` (12/18/20/24px). Status dots, spinners
and radio knobs retain circles for recognition; switches are pill tracks. The
main pane is a floating rounded panel (`--r-panel`) on the shell, below the
title bar. With "Tint
the sidebar" on, the shell takes the accent and a subtle accent-derived glow
sits under the sidebar's rows in the top-left corner; with it off the sidebar
carries no accent colour.

The sidebar has no fill, blur or edge of its own. It and the gutter around the
main panel are one surface, the shell, so the accent tint and the window's
translucency reach both alike and no seam separates them. The sidebar's rows
are New thread, the workspaces and their threads, then the account button;
Settings and its pages open from the account menu, the shortcut or the palette.
The list scrolls vertically only — never sideways — and a thread name that does
not fit rolls to its tail on hover instead of leaving a scrollbar.

The welcome state sits on the main panel itself, with a sans eyebrow and a
display heading in a column up to 540px wide. Its suggestion tiles — a 2×2
grid of raised tiles, each with a 28px icon well — ride the composer's top
edge, spanning its width and keeping the 16px buffer; centred on the empty
stage they read as decoration and go unnoticed. Empty workspace and thread
states have no decorative artwork or glow. At short heights the welcome
region scrolls while the composer stays visible. The connecting orb appears
only while a thread is actually opening or restoring. `EmberTiles` remains in
onboarding, separate from the workspace's empty state.

Smart suggestions (opt-in, Settings → General) replace the static tiles with
predicted starters an agent drafts from project state — file names, branch and
thread titles, never file contents. Predicted tiles carry a sparkle icon and a
"Predicted from project state by {agent}" note spanning the grid; a fresh
prediction re-pops the grid so the swap-in is seen. Everything falls back to
the static set when the feature is off, the agent is unreachable, or the reply
doesn't parse.

`apps/desktop/public/brand/pixel-loop.png`, `pixel-field.png`,
`glass-tiles.svg` and `glass-field.svg` are retired: they remain on disk but are
no longer referenced.
