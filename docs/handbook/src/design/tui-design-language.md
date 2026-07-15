# TUI design language

North-star for Veyyon Code terminal UX. Implementation lives in `packages/tui` (rendering) and `packages/coding-agent/src/modes/theme/` (themes and tokens).

## Brand palette in the TUI

Veyyon Dark and Veyyon Light follow the [brand system](https://github.com/santhsecurity/veyyon/blob/main/docs/brand-system.md):

| Role | Dark (shipped) | Light (shipped, upstream) |
| --- | --- | --- |
| Surface | `#050505` | Terminal / `#e0e0e0` status chrome |
| Primary text | `#FAFAFA` | Terminal default |
| Brand accent (dark only today) | `#B8BDC7` | Teal `#5a8080` in `light.json` |

Veyyon Dark follows the brand system. Light theme JSON is still the upstream oh-my-pi palette until a silver light theme lands (**Spec — not shipped**).

Theme JSON is validated in `theme.ts` (`themeJsonSchema`). User overrides can live under `~/.veyyon/agent/themes/`. See [Themes and identity](../using/themes.md) and engine doc `docs/theme.md`.

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
| Primary text | Theme `text` token (`#FAFAFA` / `#050505`) |
| Secondary / meta | `dim` or `muted` tokens |
| Emphasis | Bold on primary; silver accent for focus and selection |
| Links / paths | Theme `accent` (silver in first-party themes) |
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
| Cursor blink | ~600ms period |
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

## Composer and chrome

- Empty composer hints `?` for shortcuts and `/` for commands.
- Mid-turn: `esc to interrupt` while a turn runs.
- Picker gutters use `› ` (not `>`) for the selected row caret.
- Tree connectors (`├─`, `└─`) use theme `tree.*` symbols consistently in session tree and tool groups.

## Conformance

When touching TUI polish, name the token (spacing, theme color, motion budget). Hardcoded hex or ANSI at call sites outside `theme.ts` is a design-system bug.
