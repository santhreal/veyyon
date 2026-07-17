# TUI design language

The terminal-UX conventions Veyyon follows. Implementation lives in `packages/tui` (rendering) and `packages/coding-agent/src/modes/theme/` (themes and tokens).

## Brand palette in the TUI

First-party themes follow [Brand and identity](./brand.md); the website (`website/site.css` `:root`) is the reference token source.

| Role | Titanium (default dark) | Veyyon Dark | Light (default light) |
| --- | --- | --- | --- |
| Surface | Pitch black `#000000` | Pitch black `#000000` | White `#FFFFFF` |
| Primary text | Silver bright `#E6E9EE` | `#FAFAFA` | Terminal default (near-black) |
| Structure / brand | Silver `#C6CBD4` | Silver `#B8BDC7` | Dark silver `#5C6470` |
| Accent | Ember `#F0862E` | Deep blue `#4A84C9` (pre-ember) | Ember `#F0862E` (chrome) / `#B65E14` (links) |

Titanium mirrors the website tokens exactly, and Light is its sanctioned inverse (see `docs/internal/design.md`, "Light ground") — both locked by `packages/coding-agent/test/brand-conformance.test.ts`.

Theme JSON is validated via `getThemeJsonSchema()` (`color.ts`, applied on load in `theme.ts`; built-in themes bypass validation). User overrides live under `~/.veyyon/agent/themes/` (`getCustomThemesDir()`). See [Themes and identity](../handbook/src/using/themes.md) and engine doc `docs/theme.md`.

## Layout and width

Work surfaces are **full-bleed**: the transcript, prompt/composer, status line,
hints, and banners span the terminal width, flush left. There is no shared
centered content column — a terminal is a work instrument, and artificial
margins waste columns on the dense tool output this product lives in.

The one exception is the **hero moment**: the startup welcome card centers
horizontally on the empty home screen — header lines center on the full terminal
width (`centerLine` in `welcome.ts`), the `/welcome` menu column centers at a
56-column maximum (`Math.min(56, termWidth - 4)`), and the card hides entirely
below 30 columns. Once real work starts, everything is full-bleed.

Overlays (settings, pickers, hubs) size themselves from the modal sizing
tokens, not ad-hoc widths.

## Spacing scale

Use a 4-cell rhythm:

| Token | Cells | Use |
| --- | ---: | --- |
| `space-0` | 0 | Flush edges |
| `space-1` | 1 | Inline gap, chip padding |
| `space-2` | 2 | Between stacked rows |
| `space-3` | 3 | Section break inside a pane |
| `space-4` | 4 | Pane padding from terminal edge |

Prefer `space-1` / `space-2` in dense tool UIs. One-off paddings are bugs.

## Color and emphasis

| Role | Rule |
| --- | --- |
| Primary text | Theme `text` token |
| Secondary / meta | `dim` or `muted` tokens |
| Emphasis | Bold on primary; silver accent for focus and selection |
| Links | Theme `link` / `mdLink` (ember in titanium, matching website link color) |
| Focus / selected surface | `borderAccent` (ember) + `selectedBg` (ember glow `#241510`) — the TUI's analog of the website `:focus-visible` ember ring |
| Danger / deny | Theme `error` (red) |
| Success / approved | Theme `success` (green) |
| Warning | Theme `warning` (yellow) |
| MCP / external tools | Distinct marker glyph; consistent hue within MCP cells |

Never rely on color alone. Pair hue with a glyph or word (`ok`, `err`, `mcp`). Respect `NO_COLOR` / `--no-color`.

Call sites route through `packages/coding-agent/src/modes/theme/theme.ts` helpers — not raw ANSI literals at widget sites.

## Motion

| Kind | Budget |
| --- | --- |
| Spinner / shimmer | Low effective FPS; no 30 FPS frames for short blinks |
| Cursor blink | Hardware cursor — the terminal's own blink cadence; no software blink loop |
| Status pulse | Slow, interruptible |

No gratuitous animation on static content.

## Empty / loading / error

- **Empty:** one quiet hint + example prompts; hide once the user types.
- **Loading:** spinner + short verb (`thinking`, `running`, `compacting`).
- **Error:** cause first, remediation second. No stack dumps in the composer.

## Tool-call rendering

1. Header: glyph + tool name + status word.
2. Arguments: syntax-aware JSON when applicable; wrap with expand affordance for large bodies.
3. Output: collapse large bodies; keep a one-line summary visible.
4. MCP tools: visually distinct from local shell/file tools.

## Iconography

Prefer ASCII-safe glyphs with Unicode upgrades when width is known (`theme.symbols` presets: `unicode`, `nerd`, `ascii`). Width math uses grapheme-aware helpers in `@veyyon/pi-tui`, not byte length.

## Voice register

The website nav speaks lowercase terse ("docs install models changelog") — a display-typography choice for the marketing surface. The TUI deliberately does **not** copy it: menu items, action rows, and settings labels use sentence case ("Resume session", "Settings") because terminal UIs carry no font-weight hierarchy and lowercase labels read as unfinished next to command literals (`/resume`, `ctrl+d`). Command names, flags, and paths stay verbatim lowercase everywhere. Do not mix registers within one surface.

## Composer and chrome

- Empty composer hints `?` for shortcuts and `/` for commands.
- Mid-turn: `esc to interrupt` while a turn runs.
- Picker gutters use `› ` (not `>`) for the selected row caret.
- Tree connectors (`├─`, `└─`) use theme `tree.*` symbols consistently in session tree and tool groups.

## Conformance

When touching TUI polish, name the token (spacing, theme color, motion budget). Hardcoded hex or ANSI at call sites outside `theme.ts` is a design-system bug.

*Verified against `7ca44d3` on 2026-07-17.*
