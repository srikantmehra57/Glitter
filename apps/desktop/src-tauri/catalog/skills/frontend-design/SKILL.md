---
name: frontend-design
description: Give an interface a deliberate visual direction — typography, spacing, color and motion — instead of default UI.
---

# Frontend design

Aim for an interface with a point of view. The result should look intentional at a
glance and stay readable in use.

## Before you style

1. Name the product, the audience and the one feeling the screen should leave:
   calm, precise, playful, editorial, technical.
2. Read the existing design system: tokens, type scale, spacing, radius, motion
   and component primitives. Reuse them before inventing a local language.
3. Decide the layout first with plain boxes and real content. If the structure is
   unclear at low fidelity, color will not save it.

## Direction

- **Typography.** One display face and one text face at most. Set a clear scale
  with intentional line height and tracking; use weight and size for hierarchy
  before color.
- **Color.** A neutral base, one accent with a job, and semantic colors for state.
  Check body text and controls against WCAG AA on every surface.
- **Space.** Use a small set of spacing steps. Let key elements breathe; tighten
  related items. Align everything to a shared edge or grid.
- **Depth.** Prefer borders and surface changes to shadows. Use one elevation
  system and keep corner radii consistent.
- **Motion.** Motion explains a change of state or place, in 120–240ms, with a
  consistent easing. Respect reduced motion and never animate essential content
  out of reach.
- **Detail.** Empty, loading, error and disabled states are part of the design.
  Design them with the same care as the happy path.

## Avoid

Generic gradients, three competing accent colors, placeholder icon soup, rounded
cards inside rounded cards, centered paragraphs of body text, and animation that
delays the user.

## Handoff

State the tokens used, the new tokens introduced (and why), and any state that
still needs design. Keep implementation classes and values tied to the token set.
