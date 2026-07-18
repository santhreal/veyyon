# ModalShell SPEC

Shared floating overlay chrome for Veyyon TUI surfaces.

**Structure** mirrors Grok Build `ModalWindow` (sizing, tip gap, footer chips,
fold glyphs, Esc peel, search row, mouse chrome). **Visual brand** is Veyyon:
sharp silver borders on pitch black — not Grok colors, not orange fills, not
rounded corners. Idle session stays transcript + bottom composer; overlays float.

Source: `src/modes/components/modal-shell.ts`. Brand SoT: `docs/internal/design.md`.

## Sizing presets

| Preset | width_pct | max_width | min_width | v_margin | h_pad | v_pad | footer_lines |
|---|---:|---:|---:|---:|---:|---:|---:|
| LARGE | 0.90 | 140 | 60 | 7 | 2 | 2 | 2 |
| MEDIUM | 0.60 | 120 | 44 | 4 | 2 | 1 | 2 |
| SETTINGS | 0.70 | 110 | 44 | 3 | 2 | 1 | 2 |

- `withCompact(true)` → `v_margin=0`, `h_pad=1`, `v_pad=0`
- `computeModalDims`: preferred = `area.w * width_pct`, clamp to `[min_width, min(area.w-4, max_width)]`; height = `area.h - 2*v_margin`
- Abort (null geometry, clear hit-rects) when `w < 20` or `h < 6`
- Center card; blank underpaint so transcript does not bleed through

## Chrome anatomy

1. Title inset on top border (`─ Title ─`); leading decoration width = 2
2. Close `[x]` on top-right border (mouse dismiss)
3. Click-outside card → close
4. Optional search line + divider at body top
5. Body inset (`h_pad` / `v_pad`)
6. Optional tip via `fitTipLine` + tip/footer gap when height ≥ 6
7. Footer: centered chips, key bold silver / label muted, sep `  |  `, wrap, bottom-aligned; clickable vs inert; hover + hit-rects
8. Optional breadcrumb suffix on title (`Settings › Label`); clickable peels sub-pane

## Fold / disclosure

- Fold glyph always **2 columns** (`foldCollapsedGlyph` / `foldExpandedGlyph`)
- Descriptions expand on demand — never a permanent empty description band

## Esc layering

FilterFocused → Browse → close modal. Sub-pane Esc → Browse. Close glyph / outside always closes.

## Paint tokens (brand)

| Element | Token | Notes |
|---|---|---|
| Card border / box-drawing | `borderAccent` (silver `#c6cbd4`) | Structural — never muddy `border` gray, never sun |
| Title / chip keys | `accent` (silver) | Bold for title and key token |
| Chip labels / tip | `muted` / `dim` | Secondary only |
| Close glyph | `accent` | Visible silver, not dim soup |
| Underpaint | empty / black | Clear pads around card |

Sun/ember (`#f0862e` / `#fb9e44`) is reserved for caret, focus ring, and links elsewhere — never modal borders or fills.

## Hosting

Prefer `SelectorController.showModalSelector` / fullscreen overlay (`fullscreen: true`) so underpaint clears. Editor-slot hosts remain only where scrollback or long multi-step flows require (agent-hub, login, large wizards).

## Surfaces on ModalShell

Settings, session resume, model picker/hub, extensions, copy, ask, plan-review, move, history, oauth/logout/reset-usage pickers, theme/thinking/queue via `ModalSelectListComponent`, agent-dashboard.

## Contract tests

`test/modal-shell.test.ts` — sizing abort, compact, tip gap, footer wrap, close/outside/shortcut hits, short-terminal border integrity. Per-surface suites assert chrome grammar and Esc peel.
