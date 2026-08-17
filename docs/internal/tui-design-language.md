# TUI design language

The terminal-UX conventions Veyyon follows. Implementation lives in `packages/tui` (rendering) and `packages/coding-agent/src/modes/theme/` (themes and tokens).

## Brand palette in the TUI

First-party themes follow [Brand and identity](./brand.md); the website (`website/site.css` `:root`) is the reference token source.

| Role | Titanium (default dark) | `dark` (legacy) | `light` |
| --- | --- | --- | --- |
| Surface | Terminal's own ground (see [Terminal ground](#terminal-ground)) | Explicit `#000000` component fills | Explicit `#FFFFFF` fills on the same surfaces titanium leaves transparent |
| Primary text | The terminal's own foreground (`text` is `""`) | `#FAFAFA` | The terminal's own foreground (`text` is `""`) |
| Bright text | Silver bright `#E6E9EE` on `mdHeading`, `mdCode`, `syntaxFunction`, `statusLineModel` (website `--silver-hi`) | `#E1E4E9` on `mdHeading` | `#343B45` on `mdHeading` |
| Structure / brand (`accent`) | Silver `#C6CBD4` | Silver `#B8BDC7` | Dark silver `#5C6470` |
| Ember | `borderAccent`, `link`, `mdLink`, `mdListBullet` `#F0862E` | not used; `link`/`mdLink` are deep blue `#4A84C9` | `borderAccent` `#F0862E`, `mdLink` `#B65E14` (no `link` key, so it inherits `mdLink`) |

The `accent` token is silver in all three and is never ember: ember is the highlight, carried by links
and the accent border. `brand-conformance.test.ts` asserts both halves, including that titanium's
`accent` is NOT `#F0862E`.

Titanium mirrors the website tokens exactly, and `light` is its sanctioned inverse. Both are locked by `packages/coding-agent/test/brand-conformance.test.ts`, which is the shipped source of truth for every brand color: the brand notes it was written from are local to the maintainer's machine and are not distributed, so a doc that points a reader at them points at nothing.

`dark` is the legacy exception. Its selected rows, message and tool surfaces, and status line use
explicit `#000000` fills, and its export surfaces are black as well. Titanium is the default dark theme
(the `theme` setting defaults to `titanium`) and follows the transparent-ground rules below. Outside
`dark`, pitch-black `#000000` reaches an in-terminal token in exactly one bundled theme, `dark-midnight`'s
`userMessageBg`; everywhere else it stays on controlled grounds such as the HTML export
(`export.pageBg`/`cardBg`/`infoBg`, which titanium and `dark` both set to black) and the website. The rule
holds with that one exception named: nothing enforces it beyond titanium and `light`, which
brand-conformance locks.

## Terminal ground

The terminal's background is not ours to paint in Titanium or a new theme. An in-terminal component
must not fill an explicit page-ground color (`#000000`, `#0C0E12`, or any absolute dark hex): the
mockups those hexes came from sit on a controlled page ground, but a real terminal can be grey, blue,
or light, and an absolute fill renders as a foreign slab there. This shipped once (2026-07-22):
titanium filled user rows, tool boxes, the footline, and the composer card with absolute darks. On a
grey terminal they appeared as harsh black rectangles, with row-open fills bleeding to the line edge
via clear-to-EOL.

The rules:

- In-terminal background tokens default to `""` (transparent, inherit the real ground). Titanium ships this way.
- A raised surface or hairline must be a RELATIVE tint derived from the detected terminal background, never an absolute hex. The ONE owner is `modes/theme/ground-tints.ts`: it takes the OSC 11 hex (`terminal.backgroundColor` / `onBackgroundColorChange`) and offsets it a fixed contrast step toward the pole: 12% for hairlines and card outlines (`groundHairlineHex()`), 5% for raised grounds (`groundRaisedHex()`, which has no consumer today, because the raised composer ground was deleted). Two surfaces derive from it: the composer hairline (`ComposerHairline` in `composer-chrome.ts`) and `cardOutlineColor()` in `message-frame.ts`, which is what every `Box.setBorder` in `modes/components` passes (`message-frame.ts:91`, `skill-message.ts:48`). `BorderedLoader`'s full-width `DynamicBorder` rules are not outlines and still paint the static `border` token. Without detection, the static token is the exact fallback; do not paint what you cannot derive.
- A background fill must close before the row ends. A bg attribute left open at end-of-line paints the remainder of the row on clear-to-EOL: that is the "leaking everywhere" bug class.
- Never validate a background change in tmux. tmux panes sit on a pure-black default ground, so an absolute dark fill is invisible there and a transparent regression looks identical to a fix. Evidence for any visual change is a real-render PNG of the shipped component on BOTH a grey (`#1e2127`-class) and a black ground, plus exact-byte test assertions. The user's own screenshots outrank everything.

## Gauges

A gauge (context bar, effort ladder, any meter) uses exactly **two glyphs and two tones**: one filled cell (`▰`) in the semantic hue, one rest cell (`▱`) in `dim`. Sub-cell precision belongs to the adjacent text (`42%`), never to the glyph track: mixing shaded partials (`░▒▓`) into an outlined track reads as a rendering artifact, not data (the "random rectangle" report, 2026-07-22). The same goes for accent sprinkling: recoloring individual cells (gold "majors") reads as random paint, one hue per fill.

A gauge that reports what is LEFT drains: the filled cells are the remainder, so the track empties as the resource is spent, and the adjacent text names the quantity (`76% left`). A gauge whose bar grows while its label says "left" contradicts itself, and a bare `76%` beside a meter is read as consumption by default, which is why the word is part of the string.

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

**The conversation hugs the composer.** Once a conversation exists, ALL the
home-anchor slack routes ABOVE the transcript (`home-anchor-layout.ts`): the
first prompt renders directly above the composer at the viewport bottom and
content climbs upward as replies land. There is no latch. The routing is
recomputed every frame from the measured content height, so a full screen
simply means zero slack and the composer sits at the natural bottom, and a
transient tall frame followed by a collapse can never strand it mid-screen.
Never reintroduce a flexible fill BETWEEN the transcript
and the composer once a conversation exists: that layout painted the prompt at
the top and the loader at the bottom with a void of blank rows between, and
when a reply landed the void overflowed the screen and pushed the prompt into
scrollback while the viewport was mostly empty (locked by the routing tests in `home-anchor-layout.test.ts`). The hero split
(2/5 above, rest below) and the empty-at-rest composer pin are unchanged.

**Bordered cards hug their content.** A framed card (skill, extension, hook
message) shrinks its outline to the widest line via `Box.setHugContent(true)`;
the terminal width stays the wrap limit. A frame stretched to the terminal edge
around three short lines reads as a wall, not a card. Full-bleed stays the rule
for unframed work surfaces; hugging applies to outlined cards only.

## Spacing scale

Use a 4-cell rhythm:

| Cells | Use |
| ---: | --- |
| 0 | Flush edges |
| 1 | Inline gap, chip padding |
| 2 | Between stacked rows |
| 3 | Section break inside a pane |
| 4 | Pane padding from terminal edge |

The scale has no `space-*` tokens in the code; these are cell counts you write directly. The two named
constants the code does own are `COMPOSER_INSET_COLS` (2) and `COMPOSER_BOTTOM_MARGIN_ROWS` (1), both in
`composer-chrome.ts`. Prefer 1 or 2 cells in dense tool UIs. One-off paddings are bugs.

### Separator grammar

Modal footer chips use the middle dot `·` with two spaces on each side (`  ·  `). The dot is dim; the
terms around it carry the emphasis. These footers route through the shared
`SHORTCUT_SEP = "  ·  "` in `modal-shell.ts`, locked by `modal-shell.test.ts`. The dense
`theme.sep.dot` (` · `, one space each side in the `unicode` and `nerd` presets, ` - ` in `ascii`) joins
compact inline metadata. The status-line footline is NOT configurable: it joins every segment with its
own fixed `theme.fg("dim", "  ·  ")` (`status-line/component.ts:1455` and `:1592`), and the wider gap
before the run clock is `SESSION_CLOCK_GAP`, six spaces and no dot. The `statusLine.separator` enum still
exists with its seven values, but nothing renders it: `status-line/separators.ts` was deleted along with
the powerline top border it belonged to, the key has no settings row, and it survives only for two reads
in `modes/controllers/selector-controller.ts` (the comment on `statusLine.separator` in
`config/settings-domains/appearance.ts` says to delete the key with those reads). Use the owner for the
surface instead of pasting a separator literal into a widget.

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
| MCP / external tools | Accent `server/tool` title (`mcp/render.ts`); the `tool.mcp` marker is blank in `unicode`, `\uEB2D` in `nerd`, `<>` in `ascii` |

Never rely on color alone. Pair hue with a glyph or word. Color-off is environment-driven and owned by `detectAnsiPolicy` / `detectStreamAnsiPolicy` in `packages/tui/src/terminal-capabilities.ts`: a non-empty `NO_COLOR` yields `noColor`, `TERM=dumb` yields `plain`, `FORCE_COLOR` yields `full`. There is no `--no-color` flag anywhere in the CLI; do not document one.

A block's `state` is not a signal by itself. `renderOutputBlock` turns `state` into a rail tint and a plate behind the block and nothing else, so passing `state: "error"` and stopping there leaves the outcome carried by hue alone. This shipped in the bash renderer (2026-07-25): `showHeader: false` suppressed the title, correctly, and suppressed the failure marker with it, so with SGR sequences stripped a failed command rendered byte-identically to a clean one. A failed run now draws its own `✗ failed` header. When you pass a state to a block, ask what a reader sees with every color removed, and assert it with the styling stripped — a test that reads the ANSI is testing the tint, not the signal.

A modal never gets smaller when the terminal gets bigger. `computeModalDims` takes its vertical margin off both ends, and `sizingForArea` sheds padding on a card that has no room to spare, and those two rules used to meet in the middle of ordinary window sizes: a 24-row terminal gave a full-screen card, a 25-row terminal gave an 11-row one, and a list surface opened on a split pane showed an empty box. Card height is floored, the floor rises with the padding the card carries so switching the padding on cannot cost the body a row, and compact mode sheds padding only. A card that asks for `preferredBodyRows` still shrinks to its content, so the floor gives a LIST more room without inflating a short dialog into an empty box. If you add a sizing or a chrome band, re-run `modal-shell-height-is-monotonic.test.ts`: it scans every terminal height from 8 to 120 and fails on any step DOWN, which is the only way to catch a discontinuity that lives between the sizes anyone thinks to test.

A selection band fills the ROW, not the text. `theme.bg("selectedBg", line)` wrapped around a row's content tints only as far as that row happens to reach, so the band stops mid-row and changes shape as the cursor moves; the eye reads that ragged edge as the end of something rather than as "you are here". Call `selectionBand(line, rowWidth)` from `modes/components/selector-helpers.ts`: it pads first and tints second, which is the whole rule, and it is the one place that rule lives. The Agent Control Center shipped the ragged version and it was caught by looking at a render proof, not by a test, because with color off the fill is not there either way. `test/modes/components/agent-dashboard-selection-fill.test.ts` shows the shape of the lock: force color on with `setAnsiPolicy("full")`, then assert the tinted span reaches the pane edge and that the scrollbar sits outside it.

A row's width comes from the view that will render it. `renderScrollableList` takes a `buildRows(rowWidth)` callback rather than a finished array, and hands it `ScrollView.contentWidth(width)` from the very view it is about to render through. That shape exists because the alternative kept going wrong: the helper it replaced reserved ONE column for the scrollbar while `ScrollView` reserves TWO, a gutter plus the glyph, so every row was built one column too wide and silently truncated on the way out. A row that was merely padded lost a space and nobody noticed; a row that was FILLED lost the escape that closes the fill, and the bar and every cell after it came out painted. Do not recompute the reserve, and do not pass a width you measured yourself.

The compact decision has one owner, and no card can restate it. `sizingForArea(sizing, areaHeight, forceCompact?)` in `modal-shell.ts` is the only way to reach the compact strip: it takes the AREA HEIGHT and asks `modalNeedsCompactPadding(areaHeight, sizing)` itself, so the answer always depends on that sizing's own margin and padding rather than on a number someone read off the terminal. Its remaining boolean can only compact a card EARLIER than the rule would (the session selector uses it when it is not filling the height), never later, which is the one direction the cliff lives in. It replaced `withCompact(sizing, decision)`, whose decision parameter is exactly what let `model-picker.ts` ship `termRows < 24` and keep its padding across every height from 24 to 32 where MEDIUM is still pinned to its floor. The ownership test no longer scans the source for a spelling, because the scan it used (`/\b(?:term)?[Hh]eight\s*[<>]=?\s*24\b/`) could not see a variable named `termRows` and so never reported that copy. It now asserts the property over every exported sizing plus a synthetic grid of margins and paddings, and enforces the precondition the guarantee rests on: a sizing whose `vMargin` is thinner than twice its `vPad` cannot be continuous at its own boundary, so declaring one fails and names it.

Ordinary widget call sites route colors and attributes through theme helpers. Raw ANSI is limited to
named component or terminal-protocol owners when a theme token cannot express the required SGR
semantics. Examples include diff indentation and composer row-state resets. Do not duplicate those
bytes in leaf widgets.

## Motion

| Kind | Budget |
| --- | --- |
| Spinner glyph | One frame per 80 ms (~12.5 fps), phase-locked across live tool blocks by `sharedSpinnerFrame` (`tool-execution.ts`). `Loader` ticks at 1000/30 ms only when its message color is animated, and that faster tick repaints the shimmer without advancing the glyph (`packages/tui/src/components/loader.ts`) |
| Cursor | No blink loop and no SGR blink attribute. The hardware cursor keeps the terminal's own cadence; the software cursor glyph renders steady, because Ghostty and cmux leave afterimages for SGR-blink cells during rapid input-row repaints (`#getStyledInputCursor` in `packages/tui/src/components/editor.ts`) |
| Gauge frontier | Live turns only, same-vocabulary `▰`↔`▱` pulse (see [Gauges](#gauges)). The frontier cell steps every 1000 ms, halving to 500 ms past the error threshold (`CONTEXT_BAR_TIP_STEP_MS` / `CONTEXT_BAR_TIP_STEP_URGENT_MS`) |
| Goal spinner | One frame per 120 ms of ACTIVE time (`GOAL_SPINNER_PERIOD_MS` in `status-line/segments.ts`), steady while idle or paused |

No gratuitous animation on static content. Motion is a semantic signal (the model is working); an idle screen is byte-stable.

## Empty / loading / error

- **Empty:** the composer's ghost hint, which hides once the user types, plus the welcome hero's single rotating tip (`renderWelcomeTip`, prefixed `Tip: ` and centered under the hero). No example-prompt list.
- **Loading:** spinner + a capitalized verb phrase carrying its cancel key: `Working…` with the bracketed `[esc]` hint from `interruptHint()`, `Running… (esc to cancel)` for a shell block, `Compacting context... (esc to cancel)`.
- **Error:** cause first, remediation second. No stack dumps in the composer.

## Transcript roles

Every transcript block declares its role visually, never by content alone: a past prompt carries the dim `›` gutter with BRIGHT text (titanium `userMessageText` is full silver; the dim tone rendered prompts gray-on-gray and unreadable), a visible reasoning trace opens with a muted `Thinking` heading (the same word the hidden-thinking pulse uses) and renders italic in `thinkingText`, and the answer is plain primary text. The failure mode this prevents: reasoning that reads as the answer until you have read half of it. While a turn runs, the prompt being worked flips its `›` glyph to ember (`UserMessageComponent.setWorking`, armed by the event controller from `agent_start` to `agent_end`), so the transcript always shows WHICH message the agent is on. The indicator is STATIC by contract: an animated per-frame paint here either pins the live-region seam open (unfinalized block near the transcript top = a committed blank hole below it — shipped regression) or churns the committed-prefix audit. Bytes change only at arm/disarm, surfaced via `getTranscriptBlockVersion`; the turn's end restores byte-exact idle rows (locked by `user-message-working-glow.test.ts`).

## Tool-call rendering

1. Header: glyph + tool name + status word.
2. Arguments: syntax-aware JSON when applicable; wrap with expand affordance for large bodies.
3. Output: collapse large bodies; keep a one-line summary visible.
4. MCP tools: titled `server/tool` in accent, so the origin is in the words. The `tool.mcp` marker adds a glyph only under the `nerd` and `ascii` presets; under `unicode` it is a deliberate blank.

**A block hangs its output on a rail, not in a box.** `renderOutputBlock` draws the title on a line of its own and one thin glyph (`block.rail`, U+258F) down the left of the output, in the state's colour. Nothing sits above the title, below the last row, or to the right of anything, so a result with no body is one line where a box spent three. The rail costs the two columns the two walls cost, which is why `outputBlockContentWidth` is unchanged and every renderer that budgets rows against it counts the rows it always counted; the block is still as wide as its own widest row plus that chrome and one column of air, and a state background is a plate that size rather than a band across the screen. `tools/bash-interactive.ts` is the one renderer that keeps its own frame, deliberately: it mirrors a live PTY whose width is the terminal's.

## Iconography

Prefer ASCII-safe glyphs with Unicode upgrades when width is known (`theme.symbols` presets: `unicode`, `nerd`, `ascii`). Width math uses grapheme-aware helpers in `@veyyon/tui`, not byte length.

### Glyph width contract

Every `unicode`-preset symbol must be narrow-safe: a glyph the TUI counts as one cell but a common font renders as two swallows its following space and overlaps the label (`ⓘwaiting on 1 job`, live report 2026-07-22). Banned outright, locked by `symbol-presets.test.ts`:

- Enclosed alphanumerics `U+2460–U+24FF` (`ⓘ ① Ⓒ …`), East-Asian-ambiguous width.
- Watch/hourglass/media keys `U+231A/B`, `U+23E9–U+23FA` (`⏳ ⏹ ⏸ …`), default emoji presentation.
- The `U+FE0F` variation selector and every emoji plane above `U+1F000`.
- `U+25CC` DOTTED CIRCLE (`◌`): a width-safe glyph banned for a different reason. Fonts use it as the placeholder base under combining marks, so standalone it reads as a rendering artifact (the "stray ◌ in the footline" report). Use `▫` for ephemeral/shadowed, `◦` as the unfilled pair of `●`.

When you want a richer icon, pick from ranges the width helpers agree on (`⋯ ∎ ‖ ▪ ▫ › ⌕`-class), or leave it to the `nerd` preset, which targets fonts with known metrics.

### Glyph font-coverage contract

Narrow is not enough: the glyph also has to EXIST in the font the terminal falls back to. The
`unicode` preset is what a user sees with no Nerd Font installed, which is the default state of a
fresh machine, and six of its picks were absent from the fonts such a machine actually has. `⟳`
(U+27F3) was the running status and is missing from DejaVu Sans Mono, so every busy row in the Agent
Control Center drew a tofu box. `⤵` and `⤴` (U+2935/U+2934) were the token in/out icons in the
status line and exist in none of the three fonts measured.

The bar is **DejaVu Sans Mono and FreeMono**, the two broad-repertoire monospace faces shipped nearly
everywhere. Noto Sans Mono is deliberately not the bar: its repertoire stops at Latin, Greek and
Cyrillic, so it lacks even `✓` and `✗` and relies on fontconfig falling back to Noto Sans Symbols.
Holding the preset to Noto's own `cmap` would mean giving up the check mark, which is making the
product worse to satisfy a gate.

In practice this means picking from Arrows (`U+2190–U+21FF`), Mathematical Operators
(`U+2200–U+22FF`), Miscellaneous Technical (`U+2300–U+23FF`), Box Drawing, Block Elements, Geometric
Shapes (`U+25A0–U+25FF`) and Dingbats, and it means a glyph outside those ranges needs measuring
before it ships. `test/modes/theme/every-unicode-glyph-exists-in-a-plain-monospace-font.test.ts`
holds the measurement, one row per codepoint, and fails on a codepoint nobody has checked. A test
cannot read fonts (CI has no guaranteed font set, and a gate that silently finds none and passes is
worse than no gate), so the measurement is checked in and its `cmap` command is in the suite header.

This is also why an icon belongs to the symbol preset and never to the call site. A hard-coded glyph
follows neither the `ascii` nor the `nerd` preset and skips this check entirely, which is exactly how
the `⧉` in the agent roster's unread badge survived.

### An empty icon is a normal icon

A preset may leave an icon blank, and the `unicode` preset leaves thirty-one of them blank on purpose: no glyph is better than a wrong one. That makes "icon, then label" a join with a condition, not a template. Build it with `withIcon(icon, text)` from `modes/theme/icon-label.ts`, which emits the separating space only when there is an icon:

```ts
withIcon(theme.icon.job, `${runningJobs}`); // "⚙ 5", or "5" when icon.job is empty
```

Writing `` `${theme.icon.job} ${runningJobs}` `` instead renders ` 5` under such a preset: a leading space, and a number with nothing saying what it counts. Written by hand across the status line's segments, that showed the gap in some and not others on the same line. `test/modes/theme/an-empty-icon-leaves-no-gap.test.ts` fails if the template is written by hand again.

Those blanks were treated as an unfinished task for a while, so the reason is worth stating.
The obvious glyph for a cache, a job, a camera, a roster of agents or a lightning-fast mode is
pictographic, and every pictographic codepoint is a width risk: a font may give it emoji
presentation and draw it two cells while the TUI counts one, which is the overlap the width contract
above exists to prevent. `⌚` and `⏱` fail the font-coverage contract on top of that. What is left
inside the safe ranges is arbitrary geometry, `▣` for a cache or `⇢` for throughput, which carries
no meaning a reader recovers. So a `nerd` user gets the real icon, a `unicode` user gets the label
with no decoration, and an `ascii` user gets `cache`, `tok/s:`, `bg`. Blank is the answer here, not
a gap.

### Blockiness (house glyph style)

The default surface leans on **block glyphs** (`▌▐█▄▀░▒▓ ▪▫ ▁▂▃▄▅▆▇█`) over circles (`●○◌◆◇`) and technical dots (`·•`). Blocks carry the square, engineered character the brand wants; a field of soft circles reads as generic terminal chrome. The rule is a lean, not an absolute: the middle-dot separator (see [Separator grammar](#separator-grammar)) stays a dot because a run of squares between words would fight the text, and a checkmark/cross for pass/fail stays a checkmark/cross because those glyphs are unambiguous.

Where a status marker is a bare presence dot, it is a **square**, not a circle:

| Role | Was | Now |
| --- | --- | --- |
| `status.enabled` / `status.done` | `●` `•` | `▪` (filled square) |
| `status.shadowed` (auto/off) | `○` | `▫` (hollow square) |
| `radio.selected` / `radio.unselected` | `◉` `○` | `▣` `□` (square-in-square vs open square, kept distinct from the `■`/`□` checkbox) |
| `thinking.minimal…max` | `o ◔ ◑ ◒ ◕ ◉` | text labels `min` `low` `med` `high` `xhigh` `max` (a deliberate exception: the gauge-bar glyphs `▁▂▃…` were retired because they rendered as stray solid rectangles) |

These live in the `unicode` preset (`symbols.ts`), the base the default Titanium theme inherits, and are locked by `test/modes/theme/symbol-presets.test.ts` (with `test/tools/ask.test.ts` pinning the radio/checkbox distinction). The `nerd` and `ascii` presets keep their own icon/text vocabularies. **Named themes may override the house set** when circles are part of their identity (the poimandres themes keep their circular glyphs deliberately); the block style is the Veyyon default, not a constraint on every theme.

## Voice register

The website nav speaks lowercase terse ("docs install models changelog"), a display-typography choice for the marketing surface. The TUI deliberately does **not** copy it: menu items, action rows, and settings labels use sentence case ("Resume session", "Settings") because terminal UIs carry no font-weight hierarchy and lowercase labels read as unfinished next to command literals (`/resume`, `ctrl+d`). Command names, flags, and paths stay verbatim lowercase everywhere. Do not mix registers within one surface.

## Composer and chrome

- **The composer has no box. Ever.** The final ruling, after three shipped attempts: every painted composer ground, the absolute `#0C0E12` hex AND the OSC 11-derived raised tint AND the theme `composerBg` token, read as a gray slab on the real terminal. The composer is hairline + text + footline rendered directly on the terminal's own background; nothing paints behind the input. `CardPadRow` survives only as a blank spacer row (mount order stability) and must emit zero escape bytes; `composerCardGround()` is deleted, and `composerBg` survives only as a theme-schema key that defaults to `""` and that nothing reads. Regression locks: `ground-tints.test.ts` (the pad row paints nothing even with a detected ground) and `composer-hairline.test.ts` (one row, exact visible width at every size, `borderMuted` and no other token, byte-identical across wall time and shimmer states, and the pad row rendering `""`). Neither is a source lock: nothing bans a `48;2` write or a `composerBg` read in `composer-chrome.ts`. The editor's own ground is cleared at `interactive-mode.ts:1957` with `setRowBackground(undefined)`, and only `packages/tui/test/editor-row-background.test.ts` asserts what clearing does; no test asserts that the app clears it. Do not pitch a tinted prompt surface again; spend composer identity on the glyph morphs and the hairline instead.
- **One left rail, with named exceptions.** Everything in the composer zone shares the inset `COMPOSER_INSET_COLS` (2, owned by `composer-chrome.ts`): the composer prompt gutter is `"  " + glyph + " "` (resolved by `resolveComposerAccents`, the one pure owner of the DS-6 glyph morph), the metadata footline uses the same inset (`QuietZoneLine` indent), and so does the transcript: past-prompt gutters sit their `›` at column 2 (`user-message.ts`, children width-4), assistant prose and the Thinking label render at paddingX 2 (`assistant-message.ts:919`), and bash/eval headers, output, and footers sit at paddingX 2 with NO full-width border rules (`execution-shared.ts` builds no `DynamicBorder`; the mode color lives on the `$`/`>>>` header). Framed tool cards obey the same rule: `tool-execution.ts` gives its content box `COMPOSER_INSET_COLS`, so a card's border starts at column 2 and ends the same distance from the right edge. The framed MESSAGE cards do not: `skill-message.ts:21`, `custom-message.ts:24`, `hook-message.ts:26`, `todo-reminder.ts:29`, `ttsr-notification.ts:29` and `compaction-summary-message.ts:100` all build `new Box(1, 1)`, whose outline draws at column 0. The rail is the rule and those six are the outstanding violation, not a second convention. `test/transcript-one-left-rail.test.ts` measures the rendered column rather than the source padding, but it covers only the composer, tool cards and bash blocks, which is how they stayed unnoticed. When adding any transcript or chrome line, give it the shared inset; a flush-left line next to inset ones reads as a misalignment, not a choice. `scripts/demos/render-transcript-rail.ts | scripts/demos/render-proof.ts` renders the stack with a column ruler when you need to see it.
- **The footline's live value comes last.** Everything in the metadata footline's right group is standing state you set once (session name, model, mode); the context gauge is the one value that moves every turn, so it ends the line. Order comes from the preset's segment lists, with one rule enforced by the assembly: a `context_pct`/`context_total` configured in `leftSegments` is held aside and appended AFTER the right group rather than ahead of it, because a left-configured gauge belongs in the right group but must not jump the segments configured there (it used to, purely because that push happened in the first of two loops, and the default preset read `model · gauge · session-name`). A gauge placed explicitly in `rightSegments` keeps the position it was given. The rule lives in `#gatherQuietSegments` (`status-line/component.ts:1347-1357`). No test asserts the gauge's index in the rendered line; what IS locked is `status-line-footline-width-budget.test.ts`, which pins that the gauge survives the width shed on every preset at every realistic width, and that below 80 columns the protected parts degrade in rank order (gauge, then approval rung, then owner zone), since appending last and shedding from the end had together made the live value the first thing dropped. `scripts/demos/render-status-footline.ts | scripts/demos/render-proof.ts` renders every preset at one width when you need to compare them.
- **The zone mounts in one order, from one place.** The composer zone's vertical order (working loader, hook status, the above-composer hook widgets, hairline, air/input/air rows, metadata footline, shortcuts, the below-composer hook widgets, one bottom-margin row) is a design contract, not incidental `addChild` sequencing. Its single owner is `mountComposerZone(ui, parts)` in `composer-chrome.ts`, which also owns `COMPOSER_BOTTOM_MARGIN_ROWS` and returns the child count (11) that scroll isolation pins as its live footer; `interactive-mode.ts` only supplies the parts. Never mount a composer-zone row inline in the host: a second mount site is where sandwich and margin regressions come from. Locked by `composer-zone-mount.test.ts`.
- **Derived tints are wired, not assumed.** `setDetectedTerminalGround` is fed from `terminal.onBackgroundColorChange` in interactive-mode setup (which also replays the current value on subscribe). A ground-relative color that is never fed detection silently degrades to its static fallback forever; if you add a derived-tint consumer, verify the app actually seeds the detection, not just the tests.
- The empty composer carries the ghost placeholder and nothing else. There is no `?` hint and no chip band at rest: `buildComposerShortcuts` emits chips only when there is a live action (interrupt, background a running command, dequeue).
- The ghost placeholder uses the dense separator variant (`ask anything · / for commands`, ONE space each side of the dot). The two-space chip dialect inside ghost text read as uneven double-wide gaps; there is one definition site (`COMPOSER_PLACEHOLDER` in `interactive-mode.ts`), never a pasted literal.
- One blank cell always separates the cursor cell from ghost hint text, in every cursor mode (software `▏`, hardware, override glyph). Flush hint text puts the cursor visually on top of the placeholder's first character. Locked by `editor-placeholder-cursor-gap.test.ts`.
- Mid-turn: the chip band shows `<key> interrupt` (`escape interrupt` with the default binding, built in `composer-shortcuts.ts:51`), and only while the agent is streaming and the view is not focused on a subagent, where `esc` returns to the main session instead of interrupting. The working loader carries the bracketed `[esc]` hint from `interruptHint()`.
- Picker gutters draw the selected-row caret from `theme.nav.cursor` (`›` in the `unicode` and `nerd` presets, `>` in `ascii`). No call site pastes the literal.
- Tree connectors (`├─`, `└─`) use theme `tree.*` symbols consistently in session tree and tool groups.
- **Active profile indicator.** The `profile` status line segment names the live profile (`work`, `rec`, a client sandbox) so you always know which config, sessions, and keys are in play. It hides on the built-in `default` profile, so a vanilla status line is unchanged, and it leads the metadata run on the welcome hero the same way. The single owner is `getActiveProfileOrDefault()` in `@veyyon/utils`; the icon is `icon.profile` across the three symbol presets. See [the status line reference](../handbook/src/features/cockpit.md#status-line).

## Conformance

When touching TUI polish, name the token (spacing, theme color, motion budget). A hardcoded hex or ANSI
sequence in an ordinary widget is a design-system bug. Keep any required raw sequence in one named
component or terminal-protocol owner.

*Verified against `19234e94d39e` on 2026-08-07.*
