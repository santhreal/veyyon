/**
 * Strip terminal ANSI escape sequences: CSI (Control Sequence Introducer, which
 * carries colors, styles and cursor movement) and OSC (Operating System
 * Command, which carries hyperlinks and window-title sets). This is the full
 * superset; a narrower SGR-only strip (colors and styles only) is a materially
 * different behavior and must not reuse this name.
 *
 * The contract is shared with the Rust `strip_ansi` in
 * `crates/veyyon-shell/src/minimizer/primitives.rs`, and both are tested against
 * the same cases in `fixtures/ansi-strip-corpus.json`. Read that file before
 * changing anything here: the two implementations used to disagree, and every
 * disagreement was a defect rather than a difference of taste.
 *
 * Dependency-free by design: imported both from Node/Bun contexts and from
 * browser-bundled renderers (`@veyyon/tool-render`, via its `src/util.ts`), so
 * this file must never pull in Node built-ins.
 */

/**
 * One well-formed sequence of either kind.
 *
 * CSI is `ESC [`, then parameter bytes, then intermediate bytes, then one final
 * byte. The parameter class is the spec's full `0x30-0x3f` rather than
 * `[0-9;?]`: `:` `<` `=` `>` are parameter bytes too, and a true-color SGR
 * written with colon subparameters (`ESC [ 38:2:255:0:0 m`, which libvte and
 * several test runners emit) used to leave `38:2:255:0:0m` behind as visible
 * text.
 *
 * The three byte classes are disjoint, so this alternative accepts exactly what
 * a greedy left-to-right scanner accepts: backtracking can never find a final
 * byte among the parameter or intermediate bytes it gave back.
 *
 * OSC is `ESC ]`, then a body holding neither BEL nor ESC, then either BEL or ST
 * (`ESC \`). Terminals accept both terminators and real programs use both.
 */
const CSI_OR_OSC = /\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

export function stripAnsi(s: string): string {
	if (!s.includes("\x1b")) return s;
	// An escape that opened neither sequence is dropped, and only the escape
	// byte: whatever follows it is text and is kept, which is what a capture cut
	// at a buffer boundary mid-escape looks like. Dropping it is also what makes
	// this a fixed point, by construction rather than by inspection: no escape
	// survives a pass, so a second pass takes the fast path above and cannot
	// change anything. Keeping it as text does not hold up, because removing a
	// sequence can push a stray escape against a following `[` and MAKE a
	// sequence that was not there before, so the same string strips to two
	// different results depending on how many times it has been through. Found by
	// the Rust half's fuzzer, `fuzz/fuzz_targets/minimizer_filters.rs`.
	return s.replace(CSI_OR_OSC, "").replaceAll("\x1b", "");
}
