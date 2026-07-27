/** The one home for every Argot constant. */

/** Format major this loader understands. A file targeting a newer major is refused loudly. */
export const SUPPORTED_VERSION = 1;

/** Sigil used when a dict omits the `sigil` field. */
export const DEFAULT_SIGIL = "§";

/**
 * Token budget a generated dictionary must itself fit under, when the caller
 * names none. This is the ONE home for that number: the generator falls back to
 * it, and a harness that surfaces the budget as a setting uses it as the default
 * and as the "unchanged" sentinel, so the compiled default and the configured
 * default can never drift apart.
 */
export const DEFAULT_TOKEN_BUDGET = 1000;

/**
 * The fraction of achievable savings a generated dictionary aims to capture,
 * after which it stops adding handles even with budget left over.
 *
 * WHY A DICTIONARY STOPS EARLY. Handles are ranked by value and the ranking is
 * steep: measured over three unrelated corpora in this repository, the top ten
 * handles carry about two thirds of the estimated savings for well under a
 * twentieth of the budget, and the top thirty carry roughly 86% for about a
 * sixth of it. Filling the rest of the budget therefore spends around 83% of the
 * dictionary on the last 14% of the value. That trade runs the wrong way,
 * because the dictionary is INPUT carried on every turn while the savings are
 * OUTPUT produced once, so a long tail is a standing cost against a one-off
 * gain.
 *
 * The rule is a coverage fraction rather than a smaller token budget on purpose.
 * A budget is an absolute quantity, so any number picked here would bind
 * differently on a small repository than on a large one, and would need
 * retuning every time the corpus or the tokenizer moved. Coverage is a ratio of
 * savings to savings, so it means the same thing at every scale.
 */
export const DEFAULT_SAVINGS_COVERAGE = 0.9;

/**
 * A counter bumped whenever a change to the generator would produce a different
 * dictionary from the same corpus and options.
 *
 * WHY THE CACHE KEY NEEDS THIS. A runtime cache entry is keyed on the state of
 * the repository and on the generation options, which is correct only while the
 * function mapping one to the other holds still. It does not. When the ranking,
 * the candidate extractor, or a default changes, every existing entry becomes a
 * dictionary the current generator would never produce, and because the
 * repository has not moved the cache goes on serving it for as long as HEAD
 * stays put. An upgrade would then silently do nothing.
 *
 * So the algorithm is part of the key. Bump this in the same change that alters
 * generated output, and every project regenerates once on next use.
 *
 * Revisions:
 *  1. Initial.
 *  2. `DEFAULT_SAVINGS_COVERAGE`: generation stops at 90% of achievable savings
 *     instead of filling the token budget, which shrinks a typical dictionary by
 *     roughly three quarters.
 *  3. `DEFAULT_TOOL_CALL_STRUCTURE_SHARE`: line structure is priced on the
 *     measured mix of channels instead of on tool-call arguments alone, which
 *     drops shallow indentation handles and re-ranks the rest.
 */
export const GENERATOR_REVISION: number = 3;

/**
 * The share of line structure a real agent emits INSIDE A TOOL-CALL ARGUMENT,
 * where JSON escaping makes it expensive, rather than in plain message text,
 * where it is not.
 *
 * WHY THIS NUMBER EXISTS. A handle for line structure only pays if it is cheaper
 * than the text it replaces, and that text has two prices. Inside a tool call the
 * arguments are JSON, so one newline goes over the wire as the two characters `\`
 * and `n` and a run of tabs is charged one escape at a time. In a plain assistant
 * message, or in thinking, the same run carries real control characters and a
 * tokenizer collapses it to about one token. Pricing every handle at the escaped
 * rate assumes an agent writes only into tool calls; pricing at the raw rate
 * assumes it never does. Neither is true, so the cost is the weighted mix, and
 * this is the weight.
 *
 * MEASURED, not chosen. `packages/deepswe-bench/measure-channel-split.ts` reads
 * recorded veyyon transcripts and sorts every emitted newline-plus-indentation run
 * into the channel it was really written into. Over 307 transcripts and 23,467
 * assistant turns (25,245 tool calls, 18,980 thinking parts, 811 text parts), of
 * 182,307 structure runs 76,129 were inside tool-call arguments: 41.76%. Rerun
 * that instrument to refresh this number, and bump {@link GENERATOR_REVISION} when
 * you do, because it moves generated dictionaries.
 *
 * WHAT IT CHANGES, measured on the two corpora the generator's tests use. The
 * claimed saving for every structure row falls by roughly 3.7x: on a tab-indented
 * TypeScript tree the top row goes from 128 saved tokens to 34.8 and the bottom
 * from 40 to 16.7. Marginal rows go from cut-down to gone: `\n\nfunc` clears the
 * bar on the escaped price and fails it on the mix. And the ranking moves, because
 * structure no longer carries an inflated score into the comparison with paths.
 *
 * The gap it interpolates across is total rather than marginal, which is why the
 * share had to be measured instead of guessed: on that same tree the escaped price
 * earns five structure handles and the raw price earns none at all, since a handle
 * costs at least two tokens and a real indentation run is one.
 */
export const DEFAULT_TOOL_CALL_STRUCTURE_SHARE = 0.4176;

/**
 * How many input tokens one output token is worth, for comparing a dictionary's
 * cost against its saving.
 *
 * WHY A RATIO AT ALL. The two sides of argot's trade are different goods. A
 * dictionary is INPUT, carried on every turn whether it is used or not. Its
 * savings are OUTPUT, produced once per emission. Comparing the raw token counts
 * would treat them as interchangeable, which no provider's price sheet does:
 * output is billed at several times input across every major model.
 *
 * 5 is the conservative end of the range those price sheets span, and
 * conservative is the right direction here. The number appears in the
 * DENOMINATOR of a case argot has to make, so an optimistic value would flatter
 * the feature. If your provider bills output at more than five times input, a
 * dictionary that clears the bar at 5 clears it for you too.
 *
 * It is a shipped constant rather than a hidden literal because it is the one
 * number in the comparison that belongs to the reader's billing rather than to
 * the corpus. See {@link GENERATOR_REVISION} if you change it: it does not move
 * generated output today, since the ratio is used for reporting rather than for
 * selection, and it would need a bump the moment that changes.
 */
export const DEFAULT_OUTPUT_TO_INPUT_PRICE_RATIO = 5;

/** A handle name (the part after the sigil) must match this. */
export const HANDLE_NAME_RE = /^[a-z0-9_]+$/;

/**
 * A single handle-name character. This is the per-character form of
 * {@link HANDLE_NAME_RE} and of the boundary guard `(?![a-z0-9_])` the expander
 * builds (see `buildHandlePattern`). The streaming decoder tests one character at
 * a time to find where a handle-in-progress ends, so it needs the char form; it
 * lives here so the name-character class has one definitional home.
 */
export const HANDLE_NAME_CHAR_RE = /[a-z0-9_]/;

/** Characters a sigil may not contain, so it can never blur into a handle name or whitespace. */
export const SIGIL_FORBIDDEN_RE = /[a-z0-9_\s]/;

/** A handle stands for a recurring string, not a document; an expansion past this is rejected. */
export const MAX_EXPANSION_BYTES = 8192;

/** The committed vocabulary file, resolved at the project root. */
export const DICT_FILENAME = "AGENTS.dict";

/**
 * The canonical name of the agent tool that activates a folder's shorthand in
 * the current context (arms this session's codec and teaches the handles). A
 * harness that exposes the tool registers it under exactly this name, and the
 * preamble names it here, so the model and the harness agree in one place.
 */
export const ARGOT_LOAD_TOOL = "argot_load";

/**
 * The canonical name of the agent tool that stops writing a folder's shorthand.
 * Decoding of that folder stays on regardless (a handle already written must
 * always expand), so this only removes the folder from what the model is taught.
 */
export const ARGOT_UNLOAD_TOOL = "argot_unload";
