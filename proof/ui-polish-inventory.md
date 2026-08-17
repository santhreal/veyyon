# UI Polish Inventory — interactive TUI surfaces

Branch `feat/ui-polish`, read-only survey. Line numbers are from the surveyed
tree. "House style" below means the ModalShell standard in
`packages/coding-agent/src/modes/components/modal-shell.ts` plus the canonical
consumer pattern in `packages/coding-agent/src/modes/components/extensions/extension-dashboard.ts`.

## 1. House-style rules (extracted from modal-shell.ts + extension-dashboard.ts)

The shell (`modal-shell.ts`) owns chrome; the host owns body hit-testing.

- **Chrome card**: floating `renderModalShell` card (`boxSharp` frame in
  `theme.fg("borderAccent")`, ember tick after the top-left corner, ` [x] `
  close glyph in `accent`, title in `bold(accent)`).
  `computeModalDims`/`sizingForArea`/`planModalChrome` are the only allowed
  row math; hosts must never restate chrome arithmetic (modal-shell.ts:95-170).
- **Footer chips**: `ModalShortcut[]` rows separated by `"  ·  "`
  (`SHORTCUT_SEP`, modal-shell.ts:305). Chip keys are `bold(accent)`, labels
  `dim` (hovered: `muted`); a hovered chip gets `theme.bg("selectedBg")` wash
  (`styleShortcutChip`, modal-shell.ts:307-317). Only `clickable` chips with an
  `id` get hit rects. A chip click runs the key it names, never a private copy
  (account-manager.ts:518-526 comment).
- **Fold glyphs**: `foldCollapsedGlyph`/`foldExpandedGlyph(hovered)` — dim
  `▸ ` / `▾ `, `bold(accent)` when hovered, always `FOLD_COLS = 2` wide
  (modal-shell.ts:464-474). **Currently exported but unused anywhere.**
- **Breadcrumb**: `breadcrumbClickable` renders the title as
  `bold(underline(accent))`, `selectedBg` wash on hover
  (`breadcrumbHovered`), hit-tested as `{ kind: "breadcrumb" }`
  (modal-shell.ts:615-626, 758-800).
- **Mouse routing**: host keeps `#shellGeometry` from the last render and runs
  `hitTestModalChrome(geo, row, col, { motion, leftClick })` FIRST. Motion →
  `hover-shortcut` updates `#hoveredShortcutId` only on change, then
  `onRequestRender?.()`. Clicks → `close` / `outside` / `shortcut` act; body
  rows are hit-tested against geometry fields (`bodyRowStart`, …).
  (extension-dashboard.ts:239-300.)
- **Row hover**: pointer hover paints a full-width `selectedBg` band via
  `selectionBand(line, width)` (selector-helpers.ts:21-23) or the theme
  `hovered` painter (`getSelectListTheme().hovered = bg("selectedBg")`,
  theme.ts:1057). Keyboard selection stays the cursor glyph + accent text —
  hover never moves the selection (model-browser.ts:863-868). Click selects,
  click-again activates (model-browser.ts:748).
- **Reveal animation**: `ModalRevealDriver` — 130 ms easeOutCubic, 33 ms
  ticks, clock anchored at first paint, self-clearing; applied via
  `applyModalReveal` (bottom border slides down). The SHOW site gates it with
  `modalRevealEnabled()` (`TERMINAL.trueColor && transitionsEnabled()`);
  components honor `options.reveal` blindly (modal-shell.ts:844-931).
- **Tabs**: `TabBar` + `getTabBarTheme()` (modes/shared.ts:24-30): active/hover
  tab = `bold(bg("selectedBg", fg("text")))`; muted tabs dim and unhoverable.
- **SelectList theme** (`getSelectListTheme`, theme.ts:1032-1064): selection
  cursor is `lavaText` molten glyph, selected text `bold(accent)`, hover band
  `selectedBg`, filter hits `matchHighlight`, group headers ember-uppercase
  with rule tail.

## 2. Surface table

Columns: **M**ouse routed (SGR), **H**over highlight, **C**lick activates,
**A**nimation, **HS** house style (shell + chips + theme tokens). `—` = absent.

| Surface | File | M | H | C | A | HS | Gap notes |
|---|---|---|---|---|---|---|---|
| Modal shell (reference) | modes/components/modal-shell.ts | ✓ | ✓ chips/breadcrumb | ✓ | ✓ reveal | ✓ | fold glyph helpers unused (foldCollapsedGlyph/foldExpandedGlyph, :465-474) |
| Extension dashboard (exemplar) | components/extensions/extension-dashboard.ts | ✓ :239 | ✓ tabs+rows :291-293 | ✓ | ✓ reveal :100 | ✓ | reference implementation; inspector pane scroll-only (no hover) |
| Settings overlay | components/settings-selector.ts | ✓ :2493 | ✓ tabs :2568, rows :2575, chips, breadcrumb :2462-2463 | ✓ | ✓ reveal :2200 | ✓ | see submenu rows below |
| └ SelectSubmenu (only) | settings-selector.ts:207 | ✓ :316 routeMouse | ✓ via SelectList | ✓ | — | ✓ | the ONLY submenu with routeMouse |
| └ TextInputSubmenu | settings-selector.ts:163 | — | — | — | — | partial | swallows mouse silently (settings-list.ts:296-299) |
| └ CompactionThresholdSubmenu | settings-selector.ts:374 | — | — | — | — | partial | no routeMouse |
| └ ProviderLimitsSubmenu | settings-selector.ts:590 | — | — | — | — | partial | no routeMouse |
| └ ModelRolesSubmenu | settings-selector.ts:742 | — | — | — | — | partial | no routeMouse; effort step hint says "click pick" but click is dead (effort-picker.ts:77) |
| └ RulesSubmenu | settings-selector.ts:918 | — | — | — | — | partial | no routeMouse |
| └ SubagentAgentsSubmenu | settings-selector.ts:1232 | — | — | — | — | partial | no routeMouse |
| └ DefaultEffortSubmenu | settings-selector.ts:1606 | — | — | — | — | partial | no routeMouse; same dead "click" hint |
| └ DefaultModelSubmenu | settings-selector.ts:1773 | — | — | — | — | partial | no routeMouse (uses ModelSelector/ModelBrowser, not wired) |
| └ ModelChainSubmenu | settings-selector.ts:1844 | — | — | — | — | partial | no routeMouse |
| Model hub (`/models`) | components/model-hub.ts | ✓ :1104 | ✓ sidebar :1609, roles :1670, browser | ✓ chips :1421, rows | ✓ reveal :260 | ✓ | strip chips: click ✓ but NO hover state on chips (:1978-1982, no motion hit-test) |
| Model picker (alt+p) | components/model-picker.ts | ✓ chrome :214 | ✓ chips only | ✓ chips only | ✓ reveal :99 | ✓ | browser body gets NO mouse events — list is keyboard-only (#routeMouse returns true after chrome; contrast model-hub which forwards to browser.routeMouse) |
| Model browser (shared list) | components/model-browser.ts | ✓ routeMouse :733 | ✓ band :865 | ✓ select+activate :748 | — | ✓ | no reveal of its own (host-owned) |
| Agent dashboard | components/agent-dashboard.ts | ✓ :1728 | ✓ roster rows w/ `[x]` overlay :455, chips | ✓ | ✓ reveal :907 + age tick :952 | ✓ | full support |
| └ Termination dialog | agent-dashboard.ts:479 | ✓ :492 | ✓ chips | ✓ | — | ✓ | small confirm card, no reveal (deliberate?) |
| Ask dialog (extension) | components/ask-dialog.ts | ✓ :577 | ✓ chips ONLY | ✓ chips ONLY | ✓ reveal :441 | ✓ | question option rows & tabs never hit-tested — no hover, no click-to-answer; #handleMouse returns true right after chrome (:605) |
| Plan review overlay | components/plan-review-overlay.ts | ✓ :373 | ✓ option rows :704-717, chips | ✓ options+ToC jump | ✓ reveal :135 | ✓ | reference-grade |
| Session selector (`/resume`) | components/session-selector.ts | ✓ :1037 | ✓ chips ONLY | ✓ row click select+confirm :1067-1069 | ✓ reveal :793 | ✓ | no motion hover band on session rows; confirmation dialog eats all mouse (:1038) |
| Account manager | components/account-manager.ts | ✓ :321 | ✓ sidebar rows :661, chips | ✓ sidebar+body target rows | ✓ reveal :222 | ✓ | body rows: no hover band (motion sets #sidebarHover only, :536-539) |
| Modal select list (shared picker) | components/modal-select-list.ts | ✓ :138 | ✓ rows :177 + chips | ✓ clickItem :184 | ✓ reveal :74 | ✓ | reference for simple pickers |
| └ Theme selector | components/theme-selector.ts | ✓ (inner) | ✓ | ✓ | ✓ | ✓ | thin wrapper |
| └ Queue mode / thinking / show-images / subcommand / rollback pickers | queue-mode-selector.ts, thinking-selector.ts, show-images-selector.ts, subcommand-picker.ts, rollback-picker.ts | ✓ | ✓ | ✓ | ✓ | ✓ | wrappers over ModalSelectList |
| History search | components/history-search.ts | ✓ chrome :277 | ✓ chips ONLY | ✓ chips ONLY | ✓ reveal :173 | ✓ | result rows: NO hover, NO click, NO wheel — #routeMouse ends after chrome (:301-303); rows render selection via selectionBand :150 |
| Copy selector | components/copy-selector.ts | ✓ chrome :157 | ✓ chips ONLY | ✓ chips ONLY | ✓ reveal :89 | ✓ | tree rows have cursor+accent but no hit-test/hover/wheel (:182-212) |
| Move overlay (`/move`) | components/move-overlay.ts | ✓ chrome :323 | ✓ chips ONLY | ✓ chips ONLY | ✓ reveal :199 | ✓ | directory result rows not mouse-wired; input cursor is raw `\x1b[7m` reverse video (:355,361) |
| Reset usage selector | components/reset-usage-selector.ts | ✓ chrome :193 | ✓ chips ONLY | ✓ chips ONLY | ✓ reveal :47 | ✓ | account rows: no hover/click/wheel |
| User-message selector (branch) | components/user-message-selector.ts | ✓ chrome :259 | ✓ chips ONLY | ✓ chips ONLY | ✓ reveal :216 | ✓ | message list (SelectList) never receives mouse — no hover/click/wheel |
| OAuth selector | components/oauth-selector.ts | ✓ routeMouse :453 | ✓ band :337 | ✓ :464 | spinner :199 | partial | host-embedded (account manager); no shell/reveal of its own |
| Advisor config overlay | components/advisor-config.ts | ✓ :203 | — (wheel + delegate only, :215-229) | delegate-only | — | ✗ | fullscreen overlay-box chrome (topBorderSplit/dividerSplit), dim `#footerHint` text instead of chips, no reveal, no hover |
| Agent transcript viewer | components/agent-transcript-viewer.ts | wheel only :464-468 | — | — | poll timer :203 | ✗ | DynamicBorder sandwich chrome (:605-612), no hover/click |
| Plugin settings (`/plugins`) | components/plugin-settings.ts | — | — | — | — | ✗ | bare Text/Spacer stack, no chrome at all; footers are dim inline hints "Enter to configure · Esc to go back" (:149,366,457,505,563); SelectList/SettingsList inside get no mouse |
| Plugin selector | components/plugin-selector.ts | ✓ routeMouse :87 | ✓ (SelectList) | ✓ | — | ✗ | DynamicBorder sandwich (:63,80), no shell, no reveal, no chips |
| Tree selector (session tree) | components/tree-selector.ts | — | — | — | — | ✗ | DynamicBorder sandwich (:958-976), keyboard-only, no hover |
| MCP add wizard | components/mcp-add-wizard.ts | — | — | — | health spinner :1174 | ✗ | DynamicBorder sandwich (:170,184), keyboard-only |
| Hook selector (extension ask) | components/hook-selector.ts | — | — | — | countdown | ✗ | DynamicBorder sandwich (:227,271) + OutlinedList with selectedBg focus band (:128-157); no mouse at all |
| Hook input / hook editor | components/hook-input.ts, hook-editor.ts | — | — | — | countdown | ✗ | DynamicBorder sandwich (:61/95, :60/96) |
| Login dialog | components/login-dialog.ts | — | — | — | — | ✗ | DynamicBorder sandwich (:64,81), keyboard-only |
| Effort picker (step renderer) | components/effort-picker.ts | — | — | — | — | ✗ | plain Container + SelectList; footer hint advertises "click pick" (:77) but no host routes clicks to it |
| btw panel (`/btw`) | components/btw-panel.ts | — | — | — | — | partial | transcript-inline, DynamicBorder dim sandwich (:84,92), display+esc only |
| omfg panel | components/omfg-panel.ts | — | — | — | — | partial | transcript-inline DynamicBorder sandwich; footer `theme.fg("muted", "Esc cancel /omfg")` |
| Pause screen (`/pause`) | components/pause-screen.ts | — | — | — | ✓ ember field + 1 s clock :131 | partial | fullscreen scene, keyboard-only; a click does nothing (RESUME_HINT lists keys only) |
| Setup wizard overlay | modes/setup-wizard/wizard-overlay.ts | ✓ :124 (delegated to scenes) | scene-dependent | ✓ splash/outro advance | ✓ scene phase timers :436 | partial | own scene chrome (step trail ` › `, dim footer rows), not ModalShell; no chips |
| Composer editor | components/custom-editor.ts + tui/components/editor.ts | — | — | — | — | ✓ theme | editor is not MouseRoutable: click does not place caret; autocomplete popup not clickable |
| └ Autocomplete popup (slash, @file, :emoji:, #action, URLs) | tui/components/editor.ts:1054-1058 (SelectList); providers: modes/emoji-autocomplete.ts, github-ref-autocomplete.ts, image-references.ts, prompt-action-autocomplete.ts, internal-url-autocomplete.ts | — | — | — | — | ✓ select-list theme | renders inline below editor with no border/chrome, no mouse routing (editor never parses SGR), no appear animation |
| Composer chrome (hairline, gutter, quiet line) | components/composer-chrome.ts | QuietZoneLine leftClick only :197 | — | ✓ quiet segments | — | ✓ | click-only; no hover affordance on clickable footline segments |
| Composer shortcuts bar | components/composer-shortcuts.ts | — | — | — | — | ✓ chips | reuses `layoutShortcutRows` (house chips) but chips are never clickable/hoverable here (no `clickable` ids, no mouse) |
| Status line / quiet footline | components/status-line/component.ts | via QuietZoneLine | — | ✓ quietSegmentAt :1670 | ✓ badge slide :1461, goal spinner, context-bar pulse (segments.ts:276,657-681) | ✓ | clickable segments have zero hover feedback |
| Tool-call widgets (transcript) | components/tool-execution.ts | — | — | — | ✓ spinner :742, todo strike :816 | ✓ theme | expand/collapse is keyboard-only (formatExpandHint text); no fold glyph, no click target, no hover; transcript container routes no mouse (transcript-container.ts) |
| Assistant message / streaming | components/assistant-message.ts | — | — | — | ✓ shimmer timer :460, StreamingRevealController (controllers/streaming-reveal.ts), tool-args-reveal.ts | ✓ | display-only, fine |
| Compaction/handoff/branch summary dividers | components/compaction-summary-message.ts | — | — | — | — | partial | expandable divider (#expanded) is keyboard/command-driven; not clickable |
| Welcome screen | components/welcome.ts | — | — | — | ✓ intro bloom :232 | ✓ | non-interactive by design |
| Error banner | components/error-banner.ts | — | — | — | — | ✓ | DynamicBorder (error) sandwich; dismiss on next message |
| Debug: log viewer / raw SSE | debug/log-viewer.ts, debug/raw-sse.ts | ✓ parseSgrMouse | — | — | — | partial | wheel/scroll only |

## 3. Carried-over omp-fork styling

- **DynamicBorder sandwiches** (one full-width dim rule above and below,
  `dynamic-border.ts`): the pre-ModalShell chrome idiom. Still on:
  plugin-selector, tree-selector, mcp-add-wizard, hook-selector, hook-input,
  hook-editor, login-dialog, agent-transcript-viewer, btw-panel, omfg-panel,
  bordered-loader, error-banner. None reveal, none have chips, most are
  keyboard-only.
- **plugin-settings.ts** has no chrome at all — stacked `Text`/`Spacer` with
  dim inline "Enter to … · Esc to …" hint lines (five copies: :149, :366,
  :457, :505, :563), the oldest idiom in the tree.
- **advisor-config.ts**: fullscreen overlay-box chrome (topBorderSplit /
  splitRow / dividerSplit) + a dim `#footerHint` string, bypassing ModalShell
  entirely.
- **Raw SGR literals in interactive paths** (all deliberate but worth
  auditing during polish): move-overlay cursor `\x1b[7m` (:355,361);
  composer-chrome session-accent open/reset (:71,96,98); segment-track bg
  derived by string-splicing an fg escape (`fg.replace("\x1b[38;", "\x1b[48;")`,
  segment-track.ts:83); welcome/wizard `silverEscape` + `\x1b[39m` resets;
  custom-editor/user-message bold/underline pairs (`\x1b[1m…\x1b[22m`).
- **chalk** survives in every non-interactive CLI surface (`src/cli/*.ts`,
  ~20 files) — outside the TUI but the same package; themes don't apply.
- **Dead house helpers**: `foldCollapsedGlyph`/`foldExpandedGlyph` are
  exported house style with zero call sites; tool output expand affordance is
  instead a dim text hint (`formatExpandHint`) with no mouse target.

## 4. Animation infrastructure inventory

Existing drivers:

| Driver | Where | Used by |
|---|---|---|
| `ModalRevealDriver` (130 ms easeOutCubic unfold, gated by `modalRevealEnabled()` = truecolor + `display.transitions`) | modal-shell.ts:844 | settings, model-hub, model-picker, session-selector, account-manager, extension dashboard, agent dashboard, ask-dialog, plan-review, copy-selector, history-search, modal-select-list (+wrappers), move-overlay, reset-usage, user-message-selector |
| `StreamingRevealController` (30 fps grapheme-paced reveal) | controllers/streaming-reveal.ts | assistant streaming text |
| `ToolArgsRevealController` | controllers/tool-args-reveal.ts | streamed tool-call args preview |
| Hot-tail shimmer (`paintHotTail`, 1.4 s sheen) | components/follow.ts | freshest streaming rows |
| Welcome bloom | components/welcome.ts:232 | welcome screen |
| Ember/sunset fields | components/sun.ts | pause screen, wizard splash/outro |
| Status-line: badge-slot width easing, goal spinner, context-bar pulse | status-line/component.ts:1461, segments.ts:276,657 | quiet footline |
| Spinners | tool-execution.ts:742, model-hub.ts:669, oauth-selector.ts:199, mcp-add-wizard.ts:1174, tui Loader | in-flight states |
| Voice hue sweep / task clock | interactive-mode.ts:1100, 4700 | composer accents |

Surfaces with **no** animation at all: every DynamicBorder surface (plugin
selector/settings, tree selector, mcp wizard, hook trio, login dialog, agent
transcript viewer), advisor-config, the autocomplete popup, the composer, the
editor, tool-call expand/collapse (instant height jump), and all
settings submenus (no transition between Browse → sub-pane beyond the reveal).

## 5. Top-10 highest-traffic gaps (by how often a user sees them)

1. **Autocomplete popup (composer)** — open on every `/`, `@`, `:`, `#`
   keystroke context. No mouse, no hover band (SelectList supports it but the
   editor never routes), no appear animation, no border chrome. The most-seen
   interactive surface after the prompt itself.
2. **Tool-call expand affordance** — every tool result in the transcript.
   Keyboard-only hint text; no fold glyph (house helpers exist unused), no
   click-to-expand, expand is an instant jump.
3. **Model picker (alt+p)** — muscle-memory surface. Chrome chips hover, but
   the model list itself is keyboard-only: the ModelBrowser's
   hover/click/wheel support is never wired in `#routeMouse`
   (model-picker.ts:214-247 returns after chrome).
4. **Status/quiet footline** — always visible. Segments are clickable
   (quietSegmentAt) with zero hover feedback; nothing tells the pointer user a
   segment is a target.
5. **Session selector (`/resume`)** — click selects+confirms, but no motion
   hover band on rows, so pointer users get no pre-click feedback (contrast
   model-browser).
6. **Settings submenus (7 of 9 classes)** — pointer goes dead inside
   Compaction/ProviderLimits/ModelRoles/Rules/SubagentAgents/DefaultEffort/
   DefaultModel/ModelChain/TextInput submenus: `routeSubmenuMouse` consumes
   the event silently (settings-list.ts:296-299). Effort step even advertises
   "click pick" (effort-picker.ts:77) where click cannot work.
7. **Ask dialog (extension questions)** — options and tabs not hit-testable;
   only chips respond. A mouse user must switch to keyboard mid-dialog.
8. **History search (`/history`)** — no row hover, click, or wheel at all;
   the only ModalShell surface whose body ignores the pointer entirely.
9. **Plugin settings (`/plugins`)** — no chrome, no mouse, dim inline hint
   footers; reads as a different (older) product beside the settings overlay.
10. **Hook selector / MCP wizard / login dialog / tree selector** — the
    DynamicBorder cohort: keyboard-only, no reveal, no chips, dim-rule chrome.

## 6. Animation opportunities (ranked: motion that clarifies, not decorates)

1. **Autocomplete popup appear/dismiss** — a 1-2 frame height clip (reuse the
   `applyModalReveal` clip idea) so the popup reads as growing out of the
   prompt instead of teleporting rows into the composer. Highest traffic,
   clearest cause→effect.
2. **Tool-call expand/collapse height ease** — the collapsed↔expanded jump
   currently teleports every row below it; a short (≤130 ms) height
   interpolation would preserve scroll position comprehension. Also the moment
   to put the house fold glyphs (accent-on-hover) on the header.
3. **Settings Browse→sub-pane transition** — the breadcrumb already names the
   level; a lateral slide or quick cross-fade would make the hierarchy legible
   where today the pane just swaps.
4. **Hover wash fade-in on rows/chips** — selectedBg snapping on/off at 60 fps
   pointer motion is harsh; a 60-80 ms fade (truecolor only, same gate as the
   reveal) softens every list surface at once via `selectionBand`.
5. **Model-hub strip chips + session-selector rows hover** — these need the
   hover STATE first (gaps 3/5); once present, the same fade applies.
6. **Status footline segment hover** — selectedBg wash on the segment under
   the pointer; no motion needed, just the affordance.
7. **Wizard scene-to-scene transition** — scenes already carry phase timers;
   a short fade between steps would match the splash/outro polish.
8. **Submenu open in ModelChain/Rules etc.** — skip until mouse support
   lands; motion on a keyboard-only pane is decoration.
