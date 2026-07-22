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

Titanium mirrors the website tokens exactly, and Light is its sanctioned inverse (see `docs/internal/design.md`, "Light ground"), both locked by `packages/coding-agent/test/brand-conformance.test.ts`.

Theme JSON is validated via `getThemeJsonSchema()` (`color.ts`, applied on load in `theme.ts`; built-in themes bypass validation). User overrides live under `~/.veyyon/profiles/default/agent/themes/` (`getCustomThemesDir()`). See [Themes and identity](../handbook/src/using/themes.md) and engine doc `docs/theme.md`.

## Layout and width

Work surfaces are **full-bleed**: the transcript, prompt/composer, status line,
hints, and banners span the terminal width, flush left. There is no shared
centered content column, a terminal is a work instrument, and artificial
margins waste columns on the dense tool output this product lives in.

The one exception is the **hero moment**: the startup welcome card centers
horizontally on the empty home screen, header lines center on the full terminal
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

### Separator grammar

The TUI has one separator dialect: the middle dot `·` with two spaces on each side (`  ·  `). It joins footer chips, status line segments, keybinding hints, and metadata runs (`v1.2.3 · gpt-5 · openai`). The dot is dim; the terms around it carry the emphasis. Do not introduce a second separator (`|`, `/`, `>`) for the same job: two dialects on one screen read as unfinished. Modal footers were the last `|` holdout; they now route through the shared `SHORTCUT_SEP = "  ·  "` in `modal-shell.ts`, locked by a conformance test (`modal-shell.test.ts`). The dense `theme.sep.dot` (` · `, one space each side) is the tighter variant for inline runs where two-space air is too loose.

## Color and emphasis

| Role | Rule |
| --- | --- |
| Primary text | Theme `text` token |
| Secondary / meta | `dim` or `muted` tokens |
| Emphasis | Bold on primary; silver accent for focus and selection |
| Links | Theme `link` / `mdLink` (ember in titanium, matching website link color) |
| Focus / selected surface | `borderAccent` (ember) + `selectedBg` (ember glow `#241510`), the TUI's analog of the website `:focus-visible` ember ring |
| Danger / deny | Theme `error` (red) |
| Success / approved | Theme `success` (green) |
| Warning | Theme `warning` (yellow) |
| MCP / external tools | Distinct marker glyph; consistent hue within MCP cells |

Never rely on color alone. Pair hue with a glyph or word (`ok`, `err`, `mcp`). Respect `NO_COLOR` / `--no-color`.

Call sites route through `packages/coding-agent/src/modes/theme/theme.ts` helpers, not raw ANSI literals at widget sites.

## Motion

| Kind | Budget |
| --- | --- |
| Spinner / shimmer | Low effective FPS; no 30 FPS frames for short blinks |
| Cursor blink | Hardware cursor, the terminal's own blink cadence; no software blink loop |
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

Prefer ASCII-safe glyphs with Unicode upgrades when width is known (`theme.symbols` presets: `unicode`, `nerd`, `ascii`). Width math uses grapheme-aware helpers in `@veyyon/tui`, not byte length.

### Blockiness (house glyph style)

The default surface leans on **block glyphs** (`▌▐█▄▀░▒▓ ▪▫ ▁▂▃▄▅▆▇█`) over circles (`●○◌◆◇`) and technical dots (`·•`). Blocks carry the square, engineered character the brand wants; a field of soft circles reads as generic terminal chrome. The rule is a lean, not an absolute: the middle-dot separator (see [Separator grammar](#separator-grammar)) stays a dot because a run of squares between words would fight the text, and a checkmark/cross for pass/fail stays a checkmark/cross because those glyphs are unambiguous.

Where a status marker is a bare presence dot, it is a **square**, not a circle:

| Role | Was | Now |
| --- | --- | --- |
| `status.enabled` / `status.done` | `●` `•` | `▪` (filled square) |
| `status.shadowed` (auto/off) | `○` | `▫` (hollow square) |
| `radio.selected` / `radio.unselected` | `◉` `○` | `▣` `□` (square-in-square vs open square, kept distinct from the `■`/`□` checkbox) |
| `thinking.minimal…max` | `o ◔ ◑ ◒ ◕ ◉` | `▁ ▂ ▃ ▅ ▆ █` (an eighth-block level gauge, so effort reads as magnitude) |

These live in the `unicode` preset (`symbols.ts`), the base the default Titanium theme inherits, and are locked by `symbols-blockiness.test.ts`. The `nerd` and `ascii` presets keep their own icon/text vocabularies. **Named themes may override the house set** when circles are part of their identity (the poimandres themes keep their circular glyphs deliberately); the block style is the Veyyon default, not a constraint on every theme.

## Voice register

The website nav speaks lowercase terse ("docs install models changelog"), a display-typography choice for the marketing surface. The TUI deliberately does **not** copy it: menu items, action rows, and settings labels use sentence case ("Resume session", "Settings") because terminal UIs carry no font-weight hierarchy and lowercase labels read as unfinished next to command literals (`/resume`, `ctrl+d`). Command names, flags, and paths stay verbatim lowercase everywhere. Do not mix registers within one surface.

## Composer and chrome

- Empty composer hints `?` for shortcuts and `/` for commands.
- Mid-turn: `esc to interrupt` while a turn runs.
- Picker gutters use `› ` (not `>`) for the selected row caret.
- Tree connectors (`├─`, `└─`) use theme `tree.*` symbols consistently in session tree and tool groups.
- **Active profile indicator.** The `profile` status line segment names the live profile (`work`, `rec`, a client sandbox) so you always know which config, sessions, and keys are in play. It hides on the built-in `default` profile, so a vanilla status line is unchanged, and it leads the metadata run on the welcome hero the same way. The single owner is `getActiveProfileOrDefault()` in `@veyyon/utils`; the icon is `icon.profile` across the three symbol presets. See [the status line reference](../handbook/src/features/cockpit.md#status-line).

## Conformance

When touching TUI polish, name the token (spacing, theme color, motion budget). Hardcoded hex or ANSI at call sites outside `theme.ts` is a design-system bug.

*Verified against `7ca44d3` on 2026-07-21.*
