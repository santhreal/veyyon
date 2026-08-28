# ModalShell SPEC

Floating overlay chrome specification for Veyyon TUI surfaces.

Idle sessions display transcript and bottom composer; overlays float above the active session surface.

Source: `src/modes/terminal/components/chrome/modal-shell.ts`. Test: `packages/coding-agent/test/brand-conformance.test.ts`.

## Sizing presets

| Preset | width_pct | max_width | min_width | v_margin | h_pad | v_pad | footer_lines |
|---|---:|---:|---:|---:|---:|---:|---:|
| LARGE | 0.90 | 140 | 60 | 7 | 2 | 2 | 2 |
| MEDIUM | 0.60 | 120 | 44 | 4 | 2 | 1 | 2 |
| SETTINGS | 0.70 | 110 | 44 | 3 | 2 | 1 | 2 |

- `withCompact(true)` sets `v_margin=0`, `h_pad=1`, `v_pad=0`.
- `computeModalDims`: preferred width = `area.w * width_pct`, clamped to `[min_width, min(area.w-4, max_width)]`; height = `area.h - 2*v_margin`.
- Returns null geometry and clears hit rectangles when `w < 20` or `h < 6`.
- Card is centered with blank underpaint.

## Chrome anatomy

1. Title inset on top border (`─ Title ─`); leading decoration width = 2.
2. Close button `[x]` on top-right border.
3. Click outside card closes modal.
4. Optional search row and divider at top of body.
5. Body padding (`h_pad` / `v_pad`).
6. Optional tip line via `fitTipLine` when height ≥ 6.
7. Footer with centered chips, bold keys, and separator `  |  `.
8. Optional breadcrumb suffix on title (`Settings › Label`).

## Disclosure

- Fold glyph is 2 columns (`foldCollapsedGlyph` / `foldExpandedGlyph`).
- Descriptions expand on demand without a permanent empty description band.

## Key handling

FilterFocused → Browse → close modal. Sub-pane Esc returns to Browse. Close button or click outside closes modal.

## Theme tokens

| Element | Token | Notes |
|---|---|---|
| Card border / box-drawing | `borderAccent` (silver `#c6cbd4`) | Structural borders |
| Title / chip keys | `accent` (silver) | Bold title and key tokens |
| Chip labels / tip | `muted` / `dim` | Secondary text |
| Close glyph | `accent` | Visible accent |
| Underpaint | black | Clear background padding |

## Hosting

Use `SelectorController.showModalSelector` or fullscreen overlay (`fullscreen: true`).

## Surfaces using ModalShell

Settings, session resume, model picker, extensions, copy, ask, plan-review, move, history, OAuth pickers, theme/thinking/queue selectors, and agent dashboard.

## Contract tests

`test/modal-shell.test.ts` validates sizing aborts, compact mode, tip gaps, footer wrapping, shortcut handling, and border geometry.
