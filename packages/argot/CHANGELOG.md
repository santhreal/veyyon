# Changelog

## [Unreleased]

## [1.0.38] - 2026-07-31

### Added

- `GeneratedDict.breakEvenTurns` says how many turns a dictionary has to survive before it pays for itself. `estimatedSavings` alone reads as free money and is not: the dictionary is INPUT, carried on every turn of the session, while the savings are OUTPUT produced once per emission. A dictionary that saves 3,202 output tokens while carrying 2.4M input tokens across a session is a 751:1 loss, and nothing in the old result said so. `breakEvenTurns` divides the two, priced at `DEFAULT_OUTPUT_TO_INPUT_PRICE_RATIO`, and is `Infinity` when the dictionary is empty.
- `DEFAULT_TOOL_CALL_STRUCTURE_SHARE` and `DEFAULT_OUTPUT_TO_INPUT_PRICE_RATIO` are exported, so a host that prices its own traffic can see what the defaults stand for instead of rediscovering them.

### Changed

- `StreamDecoder` and `ArgotSession` use ES `#` private fields instead of the `private` keyword,
  which TypeScript erases and so never actually hid anything at runtime. `fork()` reaches a sibling
  instance's fields through `copy.#entries`, which is the spelling a private name needs when the
  receiver is another object of the same class. No public API changed.
- A dictionary entry is now priced in the channel it is actually emitted in, which changes what the generator selects. Line structure (a newline plus its indentation) costs about one token in a plain message, but a tool call carries its arguments as JSON, where the same run arrives escaped as `\` + `n` and each tab costs an escape of its own. The two prices differ by enough to flip whether a structure run is worth a handle at all, so `emittedTokenCost` blends them at `DEFAULT_TOOL_CALL_STRUCTURE_SHARE`, the measured share of structure runs emitted inside tool-call arguments: 41.76%, over 307 transcripts and 23,467 assistant turns. Pass `toolCallStructureShare` to `generate` if your own harness splits differently.
- `GENERATOR_REVISION` is 3. It is part of the cache key, so the first run after upgrading regenerates every cached dictionary rather than serving one selected under the old prices.
