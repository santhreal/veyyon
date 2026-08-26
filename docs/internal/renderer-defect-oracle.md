# Renderer defect oracle

`packages/tui/test/render-stress-harness.ts` executes randomized operation sequences against a TUI instance over a Ghostty WASM VirtualTerminal, evaluates fidelity assertions against a commit ledger, and uses `packages/tui/test/render-stress-reducer.ts` to reduce failing operation logs.

In `packages/tui/test/render-stress.test.ts`, the full render-stress sweep is disabled during CI:

```ts
const SKIP_IN_CI = Boolean(Bun.env.CI);
```

Subprocess pool execution with Ghostty WASM compilation exceeds pull-request time limits.

The render-stress harness evaluates synthetic root components against viewport and scrollback row ledgers. It contains no assertions for pinned footer components (`pinnedFooter`, `composer`, `PinnedFooter`).

## Composer-zone oracles

`mountComposerZone` in `packages/coding-agent/src/modes/components/composer-chrome.ts` mounts the production pinned footer components: `statusContainer`, `statusLine`, `hookWidgetsAbove`, `hairline`, `editorContainer`, `capabilityLine`, `shortcuts`, `hookWidgetsBelow`, and the bottom margin spacer.

Composer defect oracles evaluate the rendered terminal grid:

- One composer prompt row exists in the viewport when visible, and zero when scrolled off.
- No grid row contains both transcript text and chrome tokens.
- Pinned footer rows occupy the bottom physical rows of the viewport when total frame rows equal or exceed viewport height.
- No row of the footer appears above the footer boundary.
- Transcript output rows do not appear below the last footer row or inside the footer region.
- Mouse click events dispatch to the component rendered at the target row.
- The terminal cursor remains within editor boundaries when focused.
- Visible character width on each row does not exceed terminal width.
- Vertical padding rows contain no background styling or text characters.
- Hairline rendering occupies one boundary row.
- Pinned footer row count matches the segment ledger row count sum.
- Virtual scroll isolation retains live footer lines at the bottom of the viewport.

Each oracle evaluates the terminal grid produced by the emitter rather than reading state counters from the rendering engine.

## Defect corpus and replay

Failing test cases are written to `packages/coding-agent/test/corpus/renderer-defect-oracle/<id>.json`. The file id is the SHA-256 hash of the normalized state and failing invariant name.

Each case records:
- `template`: scenario template identifier
- `seed`: numeric seed
- `state`: viewport dimensions, mode configuration, editor text, transcript line count, scroll parameters, and focus state
- `failingOracle`: invariant identifier
- `errorMessage`: failure message string
- `observedGrid`: rendered viewport lines

`packages/coding-agent/test/renderer-defect-corpus-replay.test.ts` executes every case in the committed corpus on pull requests without spawning subprocesses.

Scheduled test workflows run full sweeps against `main` within fixed time limits. Discovered failures write new case files to the corpus.

## Exclusions

The oracles measure character grid cell placement and line boundaries. They do not evaluate color values, styling attributes, image protocol placement, or terminal emulator implementations outside Ghostty WASM.
