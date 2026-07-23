# TUI design language

The terminal-UX conventions Veyyon follows. Implementation lives in `packages/tui` (rendering) and `packages/coding-agent/src/modes/theme/` (themes and tokens).

## Brand palette in the TUI

First-party themes follow [Brand and identity](./brand.md); the website (`website/site.css` `:root`) is the reference token source.

| Role | Titanium (default dark) | Veyyon Dark | Light (default light) |
| --- | --- | --- | --- |
| Surface | Terminal's own ground (see [Terminal ground](#terminal-ground)) | Terminal's own ground | Terminal's own ground |
| Primary text | Silver bright `#E6E9EE` | `#FAFAFA` | Terminal default (near-black) |
| Structure / brand | Silver `#C6CBD4` | Silver `#B8BDC7` | Dark silver `#5C6470` |
| Accent | Ember `#F0862E` | Deep blue `#4A84C9` (pre-ember) | Ember `#F0862E` (chrome) / `#B65E14` (links) |

Titanium mirrors the website tokens exactly, and Light is its sanctioned inverse (see `docs/internal/design.md`, "Light ground"), both locked by `packages/coding-agent/test/brand-conformance.test.ts`.

The pitch-black `#000000` surface still applies to CONTROLLED grounds only: the HTML export (`export.pageBg`/`cardBg`/`infoBg`) and the website, where we own every pixel.

## Terminal ground

The terminal's background is not ours to paint. An in-terminal component must never fill an explicit page-ground color (`#000000`, `#0C0E12`, or any absolute dark hex): the mockups those hexes came from sit on a controlled page ground, but a real terminal can be grey, blue, or light, and an absolute fill renders as a foreign slab there. This shipped once (2026-07-22): titanium filled user rows, tool boxes, the footline, and the composer card with absolute darks, and on a grey terminal every one of them appeared as a harsh black rectangle, with row-open fills bleeding to the line edge via clear-to-EOL.

The rules:

- In-terminal background tokens default to `""` (transparent, inherit the real ground). Titanium ships this way.
- A raised surface or hairline must be a RELATIVE tint derived from the detected terminal background, never an absolute hex. The ONE owner is `modes/theme/ground-tints.ts`: it takes the OSC 11 hex (`terminal.backgroundColor` / `onBackgroundColorChange`) and offsets it a fixed contrast step toward the pole (12% for hairlines and card outlines, 5% for raised grounds). The composer hairline and every outlined card route through it. Without detection, the static token is the exact fallback; do not paint what you cannot derive.
- A background fill must close before the row ends. A bg attribute left open at end-of-line paints the remainder of the row on clear-to-EOL: that is the "leaking everywhere" bug class.
- Never validate a background change in tmux. tmux panes sit on a pure-black default ground, so an absolute dark fill is invisible there and a transparent regression looks identical to a fix. Evidence for any visual change is a real-render PNG of the shipped component on BOTH a grey (`#1e2127`-class) and a black ground, plus exact-byte test assertions. The user's own screenshots outrank everything.

## Gauges

A gauge (context bar, effort ladder, any meter) uses exactly **two glyphs and two tones**: one filled cell (`▰`) in the semantic hue, one rest cell (`▱`) in `dim`. Sub-cell precision belongs to the adjacent text (`42%`), never to the glyph track: mixing shaded partials (`░▒▓`) into an outlined track reads as a rendering artifact, not data (the "random rectangle" report, 2026-07-22). The same goes for accent sprinkling: recoloring individual cells (gold "majors") reads as random paint, one hue per fill.

Motion in a gauge follows the spinner's contract, motion means the model is working right now:

- At rest the gauge is byte-identical at any wall time. No breathing on an idle screen.
- Live, the frontier cell pulses between the SAME two glyphs (`▰`↔`▱`). Never introduce a foreign glyph family for motion.
- Urgency is cadence, not new vocabulary: the error level halves the pulse period.

Locked by `status-line-context-bar.test.ts` (bans any glyph outside `▰▱` across every ratio, level, live state, and wall time).

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

**Bordered cards hug their content.** A framed card (skill, extension, hook
message) shrinks its outline to the widest line via `Box.setHugContent(true)`;
the terminal width stays the wrap limit. A frame stretched to the terminal edge
around three short lines reads as a wall, not a card. Full-bleed stays the rule
for unframed work surfaces; hugging applies to outlined cards only.

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
| Gauge frontier | Live turns only, same-vocabulary `▰`↔`▱` pulse (see [Gauges](#gauges)) |

No gratuitous animation on static content. Motion is a semantic signal (the model is working); an idle screen is byte-stable.

## Empty / loading / error

- **Empty:** one quiet hint + example prompts; hide once the user types.
- **Loading:** spinner + short verb (`thinking`, `running`, `compacting`).
- **Error:** cause first, remediation second. No stack dumps in the composer.

## Transcript roles

Every transcript block declares its role visually, never by content alone: a past prompt carries the dim `›` gutter with BRIGHT text (titanium `userMessageText` is full silver; the dim tone made the operator's own words gray-on-gray and unreadable, user report 2026-07-22), a visible reasoning trace opens with a muted `Thinking` heading (the same word the hidden-thinking pulse uses) and renders italic in `thinkingText`, and the answer is plain primary text. The failure mode this prevents: reasoning that reads as the answer until you have read half of it. While a turn runs, the prompt being worked carries the follow's sheen (`UserMessageComponent.setWorking`, armed by the event controller from `agent_start` to `agent_end`), so the operator always sees WHICH message the agent is on; the glow ends byte-exact back at the idle rows (locked by `user-message-working-glow.test.ts`).

## Tool-call rendering

1. Header: glyph + tool name + status word.
2. Arguments: syntax-aware JSON when applicable; wrap with expand affordance for large bodies.
3. Output: collapse large bodies; keep a one-line summary visible.
4. MCP tools: visually distinct from local shell/file tools.

## Iconography

Prefer ASCII-safe glyphs with Unicode upgrades when width is known (`theme.symbols` presets: `unicode`, `nerd`, `ascii`). Width math uses grapheme-aware helpers in `@veyyon/tui`, not byte length.

### Glyph width contract

Every `unicode`-preset symbol must be narrow-safe: a glyph the TUI counts as one cell but a common font renders as two swallows its following space and overlaps the label (`ⓘwaiting on 1 job`, live report 2026-07-22). Banned outright, locked by `symbol-presets.test.ts`:

- Enclosed alphanumerics `U+2460–U+24FF` (`ⓘ ① Ⓒ …`), East-Asian-ambiguous width.
- Watch/hourglass/media keys `U+231A/B`, `U+23E9–U+23FA` (`⏳ ⏹ ⏸ …`), default emoji presentation.
- The `U+FE0F` variation selector and every emoji plane above `U+1F000`.
- `U+25CC` DOTTED CIRCLE (`◌`): a width-safe glyph banned for a different reason. Fonts use it as the placeholder base under combining marks, so standalone it reads as a rendering artifact (the "stray ◌ in the footline" report). Use `▫` for ephemeral/shadowed, `◦` as the unfilled pair of `●`.

When you want a richer icon, pick from ranges the width helpers agree on (`⋯ ∎ ‖ ▪ ▫ › ⌕`-class), or leave it to the `nerd` preset, which targets fonts with known metrics.

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

- **The composer has no box. Ever.** The final ruling (user, 2026-07-22, after three shipped attempts): every painted composer ground, the absolute `#0C0E12` hex AND the OSC 11-derived raised tint AND the theme `composerBg` token, read as a gray slab on the real terminal. The composer is hairline + text + footline rendered directly on the terminal's own background; nothing paints behind the input. `CardPadRow` survives only as a blank spacer row (mount order stability) and must emit zero escape bytes; `composerCardGround()` is deleted. Regression locks: `ground-tints.test.ts` (pad row paints nothing even with a detected ground; source lock bans `48;2` and `composerBg` reads in composer-chrome) and `composer-hairline.test.ts` (editor rows carry `setRowBackground(undefined)`). Do not pitch a tinted prompt surface again; spend composer identity on the glyph morphs and the hairline instead.
- **One left rail.** The composer content is inset `COMPOSER_INSET_COLS` (2, owned by `composer-chrome.ts`) from the terminal edge: the prompt gutter is `"  " + glyph + " "` (resolved by `resolveComposerAccents`, the one pure owner of the DS-6 glyph morph), and the metadata footline uses the same inset (`QuietZoneLine` indent). Nothing in the composer zone sits at column 0. When adding a chrome line, give it the shared inset; a flush-left line next to inset ones reads as a misalignment, not a choice.
- **The zone mounts in one order, from one place.** The composer zone's vertical order (working loader, hook status, hairline, air/input/air rows, metadata footline, shortcuts, one bottom-margin row) is a design contract, not incidental `addChild` sequencing. Its single owner is `mountComposerZone(ui, parts)` in `composer-chrome.ts`, which also owns `COMPOSER_BOTTOM_MARGIN_ROWS`; `interactive-mode.ts` only supplies the parts. Never mount a composer-zone row inline in the host: a second mount site is where sandwich and margin regressions come from. Locked by `composer-zone-mount.test.ts`.
- **Derived tints are wired, not assumed.** `setDetectedTerminalGround` is fed from `terminal.onBackgroundColorChange` in interactive-mode setup (which also replays the current value on subscribe). A ground-relative color that is never fed detection silently degrades to its static fallback forever; if you add a derived-tint consumer, verify the app actually seeds the detection, not just the tests.
- Empty composer hints `?` for shortcuts and `/` for commands.
- The ghost placeholder uses the dense separator variant (`ask anything · / for commands`, ONE space each side of the dot). The two-space chip dialect inside ghost text read as uneven double-wide gaps; there is one definition site (`COMPOSER_PLACEHOLDER` in `interactive-mode.ts`), never a pasted literal.
- One blank cell always separates the cursor cell from ghost hint text, in every cursor mode (software `▏`, hardware, override glyph). Flush hint text puts the cursor visually on top of the placeholder's first character. Locked by `editor-placeholder-cursor-gap.test.ts`.
- Mid-turn: `esc to interrupt` while a turn runs.
- Picker gutters use `› ` (not `>`) for the selected row caret.
- Tree connectors (`├─`, `└─`) use theme `tree.*` symbols consistently in session tree and tool groups.
- **Active profile indicator.** The `profile` status line segment names the live profile (`work`, `rec`, a client sandbox) so you always know which config, sessions, and keys are in play. It hides on the built-in `default` profile, so a vanilla status line is unchanged, and it leads the metadata run on the welcome hero the same way. The single owner is `getActiveProfileOrDefault()` in `@veyyon/utils`; the icon is `icon.profile` across the three symbol presets. See [the status line reference](../handbook/src/features/cockpit.md#status-line).

## Conformance

When touching TUI polish, name the token (spacing, theme color, motion budget). Hardcoded hex or ANSI at call sites outside `theme.ts` is a design-system bug.

*Verified on 2026-07-22.*
