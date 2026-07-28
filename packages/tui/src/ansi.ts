/**
 * The ANSI escape primitives, in the one place their bytes are written.
 *
 * WHY THIS MODULE EXISTS. Five byte strings were declared sixteen times across `@veyyon/tui` and
 * `@veyyon/coding-agent` under eleven different names: `\x1b[0m` as `SEGMENT_RESET` twice, `RESET` twice and
 * `RESERVED_IMAGE_ROW` once, `\x1b[39m` as `FG_RESET` three times and `ANSI_FG_RESET` once, `\x1b\\` as `ST`,
 * `OSC_TERMINATOR_ST` and `SIXEL_END_SEQUENCE`, `\x1b]` as `OSC` and `OSC_INTRODUCER`, and `\x1b` as `ESC`
 * twice.
 *
 * Eleven names for five values is worse than eleven copies of five names. A reader who greps `SEGMENT_RESET`
 * finds two of the five sites that emit the same bytes and has no way to learn the other three exist, so
 * "where is the reset written" has no answer a grep can give. That is what this module fixes: the bytes have
 * one name each, and a name has one spelling.
 *
 * WHAT BELONGS HERE. Only the primitives, meaning the introducers, the terminator and the two resets that
 * more than one module needs. A sequence specific to one feature stays with that feature: the mouse tracking
 * mode strings live with the mouse handling, the kitty graphics sequences with the graphics code, the
 * bracketed-paste markers with `bracketed-paste.ts`, which owns the paste protocol including its byte cap.
 * Composing a feature-specific sequence FROM these primitives is the intended use.
 *
 * This module has NO imports and must keep it that way, so that reaching for a primitive is always cheaper
 * than retyping it. Every duplicate above existed because the value was one character to type and its owner,
 * where there was one at all, sat behind a module worth importing for nothing else.
 *
 * ONE DELIBERATE EXCEPTION. `@veyyon/coding-agent`'s `utils/qrcode.ts` keeps its own `ANSI_RESET`. That
 * module's own doc states it is dependency-free so the collab join-code command can render without pulling
 * anything into the bundle, and importing even a zero-import leaf would end that property for five bytes.
 * The exemption is recorded in `packages/tui/test/ansi-owner.test.ts` so it stays a decision rather than
 * becoming the precedent for the next copy.
 */

/** The escape byte every sequence below starts with. */
export const ESC = "\x1b";

/**
 * Control Sequence Introducer, `ESC [`. Starts every cursor move, erase, and SGR attribute change.
 *
 * Named CSI, its actual ANSI name, and not `ESC`. `packages/metaharness/src/runner.ts` called this `ESC`, so one
 * name meant `\x1b` in this module and `\x1b[` in that one, and `${ESC}0m` there read as an escape byte followed
 * by `0m` when it was really a full SGR sequence.
 */
export const CSI = `${ESC}[`;

/** Operating System Command introducer, `ESC ]`. Starts a hyperlink, a title change, a progress report. */
export const OSC = `${ESC}]`;

/**
 * Bell, `0x07`. The legacy OSC terminator, which every terminal still accepts in place of {@link ST}.
 *
 * Emitters in this tree use both, deliberately: some terminals historically only accepted BEL, so a few call
 * sites end an OSC with it. A PARSER must accept either, and that is why this needs a name and a home: it was
 * declared three times in `@veyyon/coding-agent` as `BEL`, `OSC_TERMINATOR_BEL` and `SIXEL_END_BELL`, so the
 * sixel scanner and the paste decoder each decided independently what closes a sequence.
 */
export const BEL = "\x07";

/**
 * String Terminator, `ESC \`. Ends an OSC, DCS or APC payload.
 *
 * Some terminals also accept a bare BEL to close an OSC, which is why several call sites emit BEL instead;
 * this is the standard form and the one a parser must always accept.
 */
export const ST = `${ESC}\\`;

/** SGR reset, `ESC [ 0 m`. Clears every attribute: colour, weight, italics, inverse. */
export const SGR_RESET = `${CSI}0m`;

/**
 * The parameterless spelling of the reset, `ESC [ m`, which means exactly `ESC [ 0 m`.
 *
 * A terminal treats an omitted parameter as zero, so both forms clear every attribute, and a
 * PARSER has to accept both while an emitter should pick one. This tree emits {@link SGR_RESET}
 * and reads either: `utils.ts` looks for the short form when it compacts a carried style run,
 * and `coding-agent/src/tui/output-block.ts` has to re-apply a block background after any reset
 * in the content, which is wrong if it sees only the long one. Both had the bytes inline.
 */
export const SGR_RESET_SHORT = `${CSI}m`;

/**
 * Foreground-colour reset, `ESC [ 39 m`. Restores the default foreground and leaves every other attribute
 * alone, which is why a gradient or shimmer closes with this rather than with {@link SGR_RESET}: a full reset
 * would also drop the bold or inverse the surrounding text set.
 */
export const SGR_FG_RESET = `${CSI}39m`;

/**
 * Background-colour reset, `ESC [ 49 m`. The counterpart of {@link SGR_FG_RESET}, restoring the default
 * background and leaving every other attribute alone.
 *
 * Two modules in two packages each had a copy, `ANSI_BG_RESET` in `tui/src/latex-to-unicode.ts` and `BG_RESET`
 * in `coding-agent/src/modes/components/segment-track.ts`. Both close a run of coloured cells, and a run left
 * open bleeds its background across the rest of the row.
 */
export const SGR_BG_RESET = `${CSI}49m`;

/**
 * Intensity reset, `ESC [ 22 m`. Cancels BOTH bold and dim, which is the part worth stating plainly.
 *
 * It was declared under two names that each claimed half of it: `BOLD_CLOSE` in `modes/theme/shimmer.ts` and
 * `DIM_OFF` in `modes/components/diff.ts`. Neither is accurate, and the inaccuracy is a real trap: emitting
 * "DIM_OFF" after dim text nested inside a bold run also cancels the bold, so the rest of the line silently
 * loses weight. There is no sequence that turns off only one of the two.
 */
export const SGR_INTENSITY_RESET = `${CSI}22m`;

/**
 * OSC 66 introducer, `ESC ] 66 ;`. Kitty's text-sizing protocol, which wraps a grapheme so the terminal can
 * scale or width-correct it.
 *
 * Both a writer and a detector need these exact bytes: `tui/src/utils.ts` scans for the sequence while
 * `tui/src/components/markdown.ts` decides whether a line contains one, and each had its own copy
 * (`OSC66_PREFIX`, `OSC66_LINE_PREFIX`). A detector that stopped matching what the writer emits would silently
 * mis-measure every wide grapheme on the line.
 */
export const OSC66 = `${OSC}66;`;

/**
 * The body of an SGR sequence, `ESC [ <params> m`, with the parameters captured.
 *
 * A pattern rather than a `RegExp`, because the four call sites need three different flag
 * sets and a shared `RegExp` object carries `lastIndex` between them: `tui.ts` strips with
 * `g`, `utils.ts` collects with `g`, `markdown.ts` scans with `y`, and
 * `coding-agent/src/tools/terminal-output.ts` reads the parameters out. Each builds its own
 * through {@link sgrSequence}.
 *
 * WHY IT IS HERE. Those four spelled it out themselves, under four names, and the fourth had
 * already drifted: it wrote the parameter class as `[0-9;]` with no colon, so a truecolor SGR
 * written with colon subparameters (`ESC [ 38:2:255:0:0 m`, which libvte and several test
 * runners emit) did not match at all and its colour was dropped from the re-rendered row. A
 * grep for any one of the four names finds a quarter of the code that parses an SGR.
 *
 * The class stops at `0x30-0x3a` (digits, `;`, `:`) rather than the spec's full `0x30-0x3f`
 * parameter range, which is what `@veyyon/utils/strip-ansi` accepts for a general CSI. That
 * is deliberate and narrow on purpose: `<`, `=`, `>` and `?` are private-use parameter bytes
 * and an `ESC [ ? ... m` is not an SGR, so widening the class here would make these four
 * sites treat a private-mode sequence as a colour change.
 */
export const SGR_SEQUENCE_PATTERN = "\\x1b\\[([0-9;:]*)m";

/**
 * A fresh `RegExp` over {@link SGR_SEQUENCE_PATTERN} with the flags the caller needs.
 *
 * Fresh each call, so a sticky or global scan in one module cannot leave `lastIndex` set for
 * another. Callers that scan repeatedly should hoist the result to module scope, which is
 * what all four do.
 */
export function sgrSequence(flags: string): RegExp {
	return new RegExp(SGR_SEQUENCE_PATTERN, flags);
}
