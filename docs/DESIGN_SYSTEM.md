# Glitter — Design System

This is the one place Glitter's design is decided. Every UI change follows it,
and a change that alters a design decision — a new pattern, a token, a layout
rule, a page's name — updates this document in the same commit. Before UI
work, read the sections for the surfaces you touch; if what you need is not
here, extend this document first rather than inventing a one-off.

Tokens live in `apps/desktop/src/styles.css` (Settings adds `settings.css`);
where this document and the stylesheet disagree, the stylesheet wins and this
document should be corrected.

---

## Product principles

1. **Protocol-honest.** Show what the agent is doing. Never invent chain-of-thought. Prefer host todos, goals, tool names, and exit codes.
2. **Frost and ember.** Matte grey canvas, frosted glass panels, soft diffuse elevation, an ember glow as the brand signal. Transcripts, code and diffs always sit on solid surfaces; glass is for chrome (composer, popovers, dialogs), and the sidebar sits on the shell, which can show the window's own material. Live agent state uses `thinking-orbs` (`components/Orb.tsx`) and a restrained pulsing composer rule.
3. **Desktop, not web.** System type, overlay titlebar, dense lists, real menus/palettes, no remote fonts.
4. **Density with hierarchy.** Developer sessions are long. Prefer 13px body, tight rows, collapsed tools. Hierarchy from contrast and spacing, not cards.
5. **One vocabulary.** Workspace, Thread, Agent, Provider, Model, Run, Plan, Changes, Terminal.
6. **Every control is real.** Hidden > disabled > fake.
7. **Providers first.** Glitter is an agent harness. Its built-in agent and the
   providers you connect come first; an agent CLI such as Muse is one more
   provider, never the frame the app is described in.

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
| Local / Worktree | Where a thread works: the workspace folder, or its own checkout on a `glitter/` branch. Not “sandbox”, “copy” or “isolated mode” |
| Stop | Cancel turn (button label: Stop) |
| Provider | Where models come from, as the model picker and Settings → Models list them: a provider the built-in agent calls with your key (Anthropic, OpenRouter…), or an agent CLI (Muse, Cline CLI…). Not “source”, “lab” or “backend” |
| Built-in agent | Glitter’s own agent (`harness` in code). In copy it is “the built-in agent”; the composer addresses it by its model (“Ask Claude Sonnet 5…”) |
| Allow in thread | An approval that reaches past this one call, for the rest of the thread. Its scope names what it covers (this exact command, a command prefix, one program, a file, a folder, the workspace). Not “session”, “rule” or “whitelist” |

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
| `--shell`, `--shell-opacity` | The surface behind the sidebar: `--bg`, or `--bg` tinted with the accent. `lib/theme.ts` sets the opacity (0–1) of the layer that paints it; below 1 the window's material shows through |
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

**The type scale.** UI text uses these tokens and nothing between them. A new
or changed rule names a token, never a literal size; the only literals left are
reading prose in replies (`.prose`, 14px body with its own heading steps) and
display headings on the welcome stage.

| Token | Size | Use |
|---|---|---|
| `--text-2xs` | 10.5px | Tags, counts, kbd hints, code inside meta lines |
| `--text-xs` | 11px | Captions, section labels in navigation, timestamps |
| `--text-sm` | 12px | Help text, meta lines, small buttons, notes |
| `--text-md` | 13px | Body, row labels, controls, nav rows — the default |
| `--text-lg` | 15px | Panel titles, the Settings navigation title, dialog titles |
| `--text-xl` | 18px | Modal headings |
| `--text-2xl` | 22px | Empty-state headings, the Settings title at phone widths |
| `--text-3xl` | 28px | The Settings page title, onboarding heading |

| Role | Size | Weight | Tracking |
|---|---|---|---|
| Display (welcome titles) | 34–38px (30px at compact widths) | 400 | -0.035em |
| New-thread heading | 26–30px | 400 | -0.03em |
| Settings page title | `--text-3xl` | 600 | -0.035em |
| Section heading in a page | `--text-md` | 600 | -0.01em |
| Brand wordmark | 17px | 600 | -0.03em |
| Title (thread name) | `--text-md` | 600 | -0.01em |
| Body | `--text-md` | 400 | -0.01em |
| Compact | `--text-sm` | 400 | 0 |
| Caption | `--text-xs` | 400 | 0.02em |
| Mono | `--text-sm` | 400 | 0 |

---

## Spacing

Scale: 2, 4, 6, 8, 10, 12, 16, 20, 24, 32.

- Sidebar row padding: 6×8
- Conversation column: `min(860px, 100% - 40px)`
- Inspector width: 360 default, user-resizable from 300 up to the smaller of 60% of the window or the space that leaves the thread 336
- Title bar height: 52 (the window controls sit on its centre line; 50 in compact browser windows)

---

## Radius

Corners are slight, macOS-sized, and grow with the surface. Use the tokens, not
literal pixel values.

| Token | Value | Continuous | Use |
|---|---|---|---|
| `--r-sm` | 6px | 8px | Menu and option items, progress tracks, rename inputs |
| `--r-md` | 8px | 11px | Inputs, cards in the transcript, code blocks |
| `--r-pill` | 8px | 11px | Single-line controls and rows: buttons, chips, icon buttons, sidebar and file rows, picker and menu triggers |
| `--r-lg` | 10px | 14px | Cards, popovers, dialogs |
| `--r-xl` | 12px | 16px | The composer, the command palette, the settings dialog |

A row inside a popover takes a smaller corner than the popover, so the two
curves stay concentric. Sections that nest inside a bordered surface use
`calc(var(--r-*) - 1px)` so their corner follows the parent's edge.

Where the engine supports `corner-shape`, every corner is an Apple-style
continuous curve (`squircle`) and the tokens take the larger "Continuous"
values, since a squircle of the same radius reads tighter. macOS WebKit does not
support it yet, so the app draws circular arcs at the base values. Circles opt
back out with `corner-shape: round`; a new circle needs adding to that list in
`styles.css`.

Micro marks — inline code, key caps, checkboxes, plan marks, chart swatches —
keep their own small radii.

The main pane has no radius of its own: it runs flush to the window's edges,
and the window's 16pt corner (macOS 26 and later) rounds it.

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

Navigation rows (the sidebar, the Settings categories) carry a bare 15px icon
in `--tertiary`, `--accent-text` on the current row; no icon wells.

**Extension thumbnails.** Every skill, plugin and MCP server shows a thumbnail
(`ExtensionThumb`, art from `lib/extensionArt.ts`): a rounded `--r-md` tile
tinted with one of eight tones, holding the Lucide icon for what it does. Store
entries are mapped by id; anything else is matched on its name, then falls back
to its kind (wand, package, server) with a tint hashed from its name so it never
changes between renders. 40px on Store cards, 32px in installed lists. Never
repeat one generic glyph down a list of extensions.

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
surface and the same effort control: no level is singled out.

The toolbar is one row that reads left to right: what to add (attach, mention),
how to run it (model and reasoning, permissions), then status and action
(context meter, Send). The selectors are one family of 28px borderless
controls (`.picker-trigger`, and `.select-trigger` inside `.composer-foot`)
that fill a capsule on hover; short 16px hairlines separate model, effort and
permissions, as one separates attach and mention from them. The model control
pairs the agent mark with the model name; effort is its own control beside it.
Every agent has the permissions control. Muse offers its four modes and the
built-in agent adds Autonomous; an agent CLI offers Read only, Ask me and
Unrestricted, which say how Glitter answers the permission requests that agent
sends (its own configuration decides what it asks about), under the heading
“When {agent} asks permission”. A mode never changes its shape, only its tone: Unrestricted takes the warning
colour for as long as it is selected. When the composer
narrows, the model name truncates first, then labels fold to their icons; the
row never wraps.

Keep a 16px clear buffer above the composer. It is the final surface in the
thread column: nothing may render below it, including warnings, capabilities,
worktree details, status lines or the terminal. Status and recovery controls
belong inside the input frame; worktree details sit above its writing area.
The terminal sits above the buffer. While a setting is applied the controls
are locked but keep their look (`.settling`), so the toolbar does not blink.

The thread column is one width: transcript content, the pinned plan, the
terminal pane and the composer share `--composer-inset` and an 860px
`--content-max` on `.thread-main`, so every edge lines up at any width. Edge
chrome follows the column — the prompt rail hugs the panel's left edge,
vertically centred, and the find bar sits just inside its right edge.

Third-party capabilities open in a dismissible dialog once per agent during
the app session, with a persisted "Don’t show again" choice. The model picker's
rail foot has a Capabilities action to reopen the dialog at any time.

The model picker opens above the composer and stays within the window. It has
exactly two levels: **providers**, then **models**. The rail is a 56px column of
provider icons — no names; a label floats beside the hovered or focused icon,
and the list's header names the open provider. It lists providers —
each provider the built-in agent has a key for (Anthropic, OpenAI, OpenRouter…)
and each other installed agent as a provider of its own (Muse, Cline CLI…), in
a fixed order — with no Agents section and no agent row nested over its
providers. A dot marks the provider the thread's model comes from. The list
shows that provider's models; an agent whose catalog mixes labs groups them
under lab headings inside the list, never as a third level. Search spans every
provider, with provider headings. Picking a model from a provider on another
agent moves the thread to that agent, then sets the model; those rows are off
while the thread cannot switch. Models switched off in Settings → Models leave
the list (the thread's current model stays), and a provider switched off — or
with every model off — leaves the rail unless the thread's model comes from it;
the foot says how many are hidden
and links to Manage models and Manage providers. One click on a row picks it
and closes.

Reasoning effort (`EffortPicker`) is the shared select menu: the chip names
the level, and the menu lists the model's levels from least to most, each with
a line on what it trades and the model's own default tagged Default. One click
picks a level and closes; the left and right arrows on the closed chip step it
without opening anything. No level gets its own colour, bars or effect. A pick
stays drawn while it applies, and a rejected pick returns to the session's
applied value. The model and effort commands open these two controls.

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

Settings is a full-window page, not a dialog. Its categories column is exactly
the sidebar's width (`--sidebar-width`, the width the user dragged it to) with
the sidebar's 12px gutters, so the two line up when one replaces the other.
Opening focuses the page itself, so no control greets it with a focus ring. It takes the place of the app
view: the app steps back (fades and hides) while it is open and fades back as it
closes. The categories sit on the shell where the sidebar sits, so the tint and
the window's translucency reach them, and the page fills the main panel on
`--surface`, split from them by one hairline. The title-bar strip of the
categories holds **Back** after the window controls; the page's own strip holds
the save hint and Close (Esc). Both strips drag the window.

**Information architecture.** Pages are named once, in `lib/settingsNav.ts`,
and the navigation, search and the command palette all read those names.

| Group | Pages |
|---|---|
| AI | Models · Providers · Agents |
| Workspace | Extensions · Permissions · Threads |
| App | General · Appearance · Commands & shortcuts · Usage |
| System | Diagnostics · About |

- **Models**: new-thread defaults, then the model library — every provider as a
  card whose header switch turns the whole provider off (the card dims and
  folds, keeping its model choices for when it returns), and its models, each
  with a switch that keeps it in or out of the picker, and for the
  built-in agent's providers a **Test** icon button (Activity, a spinner while
  it runs) that sends one word and shows the reply time as a chip, or why it
  failed. A search field at the top searches every provider; a provider with
  more than ten models has its own search inside its card. Long lists fold
  after eight rows.
- **Providers**: API keys for the built-in agent.
- **Agents**: the default agent, the built-in agent, the agent CLIs, and the
  Muse connection (credential, API key, binary, Contributor mode) while Muse is
  shown. There is no Account page: Muse is one agent among others.
- **Permissions**: approvals for new threads, then the Muse host sandbox.
- Muse-only content (the subscription meter, the CLI updater, Muse diagnostics)
  appears only while Muse is shown, and after the app's own content.

**Motion.** The category highlight moves on the click; the page renders a beat
later (`useDeferredValue`) and fades up 4px over `--dur-2`, transform and
opacity only. Cards below the fold use `content-visibility: auto`. The app view
steps back through `html[data-settings]`, never an app-wide `:has()`.

**Layout.** One centred column (`.settings-column`, 760px) on every page. The
page head is the title (`--text-3xl`) and one sentence, over a hairline. A
section is a heading (`.settings-card-heading`, `--text-md` 600) with one line
of help, then a card; 32px between sections.

- A setting is a row in a card (`.setting-row`): name and one line of help on
  the left, the control on the right. Selects and text fields are 240px wide.
- A sentence that qualifies a card sits under it (`.settings-note`); context
  that needs a box uses `.settings-callout`; an empty state with a next action
  uses `.settings-empty`.
- Switches use `.toggle`: a 36×22 pill track in `--accent-fill` when on, with a
  round knob in `--accent-contrast`. Exclusive choices use the radio list.
- A continuous value uses `.slider`: a thin track filled to a round thumb, with
  the value beside it. It repaints while it is dragged and saves once, when the
  gesture ends.

**Saving.** Preferences save as they change, and the page strip says so. A
Muse host setting waits for an explicit restart: a bar rises from the foot of
the page with Cancel and Save & restart connection. Messages (copied, signed
out, a failed save) appear as a glass toast at the foot, never as a banner that
shifts the page.

Select menus portal directly into the page, outside its scroller. Their
positions use the page's padding box; viewport coordinates belong only to menus
outside a dialog. Keep every option within the page and choose the side with
room.

New-thread defaults query the preferred new-thread agent's current catalog
when Models opens. They never reuse or replace a conversation's model list.
Show loading or query errors, and identify unlisted saved selections explicitly;
preserve the preference until the user chooses another model or the agent's
default.

At widths under 720px the categories become one scrolling row above the page.

### Extension store

The Store is a grid of cards (two columns, one under 720px): the thumbnail,
the name and kind with its tags, one summary line (the full description is its
tooltip), what a bundle installs, the command a server adds, and Install or
Remove at the card's foot, aligned across a row.

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

**The sidebar group.** Show/Hide sidebar and Search are one group of 28px icon
buttons, in that order, with tooltips and no labels. With the sidebar open the
group sits at the sidebar's right edge (12px in); collapsed, it slides with the
sidebar to just after the window controls. It is one element whose box narrows
with the sidebar, and the toggle is one button throughout, so nothing re-mounts
under the pointer. Search grows the thread search field in under New thread
(`<Collapse>`) and focuses it; Escape, or leaving it empty, folds it away, and
it stays while it holds a query. The search shortcut and the palette open it
the same way. Toggling the sidebar moves the title bar sideways only; nothing in
the panel shifts up or down.

### Collapsed sidebar

The sidebar gives up its column entirely. New thread, Open workspace, Settings
and Usage join the sidebar group after the window controls (`--window-controls`, group width
`--rail-width`), and the title starts after them. Nothing may sit under the
window controls.

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

The identity combines the Glitter mark — a geometric G around a four-pointed
faceted spark — with frosted glass surfaces, system sans typography, and a warm
ember accent. `docs/brand/glitter-mark.svg` is the editable source: a radius-20
G contour stroked at 8px with rounded caps, whose horizontal spur meets a
four-faceted diamond spark centred at (31, 32). The G takes one ember gradient
plus an overhead white sheen; the spark's upper facets are lit and its lower
facets fall to deep ember. Use it at 16–36px beside “Glitter”; it reads on both
light and dark UI without theme switching, and scales to the 1024px icon tile.
App icons embed the mark on a frosted-grey tile (light) or a graphite tile
(dark); the running Mac Dock icon follows the OS appearance, independently of
an explicit interface theme selection.
Footer/About: **Not affiliated with Meta.** No Meta wordmark.


## Frost & Ember identity and welcome panels

Shared radii use `--r-sm` through `--r-xl` (6/8/10/12px). Status dots, spinners
and radio knobs retain circles for recognition; switches are pill tracks. The
main pane is flush with the window, title bar included, on `--surface`; one
`--border` hairline separates it from the sidebar. With "Tint
the sidebar" on, the shell takes the accent and a subtle accent-derived glow
sits under the sidebar's rows in the top-left corner; with it off the sidebar
carries no accent colour.

The sidebar has no fill, blur or edge of its own: it sits on the shell, so the
accent tint and the window's translucency reach it. The main pane is opaque and
takes neither. The sidebar is the session list. Under the title bar it offers
New thread, a search field, and a filter for all threads, live ones, or ones
that need you, then the workspaces and their threads. Each workspace row starts
a thread in that workspace. The foot is a row of icons — Settings, then Usage,
whose card opens upward — under a hairline, with a CLI update, offline, sign-in
and a missing agent each getting a row above it while they last. The Muse subscription meter appears in the Usage card only
while the Muse agent is enabled. The list scrolls vertically only —
never sideways — and a thread name that does not fit rolls to its tail on
hover instead of leaving a scrollbar.

The welcome state sits on the main panel itself. A new thread's empty state is
one centred column: a short heading, the workspace name and branch in a quiet
line under it, the starter chips, then the composer. No eyebrow and no
subtitle. While the thread is empty the composer rides just above the middle of
the column, the space under it being a pseudo-element on `.thread-main` rather
than content, so the composer stays the last surface; sending the first message
eases that space away and the composer settles at the foot. It stays docked
when the terminal is open, at heights under 600px, and when the Changes pane
covers the transcript.

The starter chips are quiet outlined capsules with a 14px icon, wrapped and
centred on the composer's top edge with the 16px buffer under them; they rise
in one after another and fade out when the first message replaces them.
Centred on the empty stage, away from the composer, they read as decoration and
go unnoticed. Empty workspace and thread states have no decorative artwork or
glow. At short heights the welcome region scrolls while the composer stays
visible. The connecting orb appears only while a thread is actually opening or
restoring. `EmberTiles` remains in onboarding, separate from the workspace's
empty state.

Smart suggestions (opt-in, Settings → General) replace the static tiles with
predicted starters an agent drafts from project state — file names, branch and
thread titles, never file contents. Predicted chips carry a sparkle icon and a
"Predicted from workspace state by {agent}" note centred over them; a fresh
prediction re-pops the chips so the swap-in is seen. Everything falls back to
the static set when the feature is off, the agent is unreachable, or the reply
doesn't parse.

`apps/desktop/public/brand/pixel-loop.png`, `pixel-field.png`,
`glass-tiles.svg` and `glass-field.svg` are retired: they remain on disk but are
no longer referenced.
