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
 * browser-bundled renderers (`packages/collab-web/src/tool-render/lib`, via its `util.ts`), so
 * this file must never pull in Node built-ins.
 *
 * 8-bit C1 control characters (0x90 DCS, 0x98 SOS, 0x9B CSI, 0x9C ST, 0x9D OSC,
 * 0x9E PM, 0x9F APC) canonicalize to their two-byte 7-bit equivalents (`ESC P`,
 * `ESC X`, `ESC [`, `ESC \`, `ESC ]`, `ESC ^`, `ESC _`) before the grammar
 * runs. This covers both representations without duplicating the sequence
 * parser. Non-introducer C1 controls are not escape sequences and are left
 * untouched for downstream handling.
 */

const HAS_ESCAPE_OR_C1 = /[\x1b\x90\x98\x9b-\x9f]/;
const C1_INTRODUCERS = /[\x90\x98\x9b-\x9f]/g;
const C1_MAP: Record<string, string> = {
	"\x90": "\x1bP",
	"\x98": "\x1bX",
	"\x9b": "\x1b[",
	"\x9c": "\x1b\\",
	"\x9d": "\x1b]",
	"\x9e": "\x1b^",
	"\x9f": "\x1b_",
};

/**
 * One well-formed sequence of any kind.
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
 * (`ESC \`). Terminals accept both terminators and real programs use both. DCS
 * (`ESC P`), SOS (`ESC X`), PM (`ESC ^`) and APC (`ESC _`) frame their payloads
 * the same way, so they share that body rule: `ESC P tmux; … ST` is tmux
 * passthrough, `ESC P q …` a sixel image, `ESC _ G … ST` a kitty graphic, and
 * with the grammar missing the whole payload was published as visible text.
 *
 * The last two alternatives are the short sequences, which are the ones a
 * capture holds most of: nF is `ESC` plus intermediates plus a final byte
 * (`ESC ( B`, the ASCII charset select every editor sends on the way out), and
 * the single-byte class is Fp, Fe and Fs — `ESC 7` and `ESC 8` park and reclaim
 * the cursor for every progress bar, `ESC =` and `ESC >` bracket an ncurses
 * run, `ESC c` is `reset`. That class is `0x30-0x7e` minus the six introducers
 * `[ ] P X ^ _`, which belong to the alternatives above; matching one here
 * would eat the introducer and publish its parameters as text.
 */
const ESCAPE_SEQUENCE =
	/\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)|[\x20-\x2f]+[\x30-\x7e]|[\x30-\x4f\x51-\x57\x59-\x5a\x5c\x60-\x7e])/g;

/**
 * The same grammar, sticky, for asking whether one complete sequence starts at
 * a given offset. Built from [`ESCAPE_SEQUENCE`]'s source so the two can never
 * drift: a second copy of this grammar is how the Rust and TypeScript halves
 * came to disagree.
 */
const SEQUENCE_AT = new RegExp(ESCAPE_SEQUENCE.source, "y");

/**
 * How much of an unterminated sequence is held before its payload is treated as
 * text. A stream can carry a clipboard write or a sixel image, so the limit is
 * generous, and it is a limit rather than an absence of one so a consumer's
 * buffer cannot grow with the stream.
 */
const OPEN_FRAGMENT_LIMIT = 64 * 1024;

export function stripAnsi(s: string): string {
	if (!HAS_ESCAPE_OR_C1.test(s)) return s;
	const normalized = s.replace(C1_INTRODUCERS, ch => C1_MAP[ch] ?? ch);
	// An escape that opened no sequence of any of those kinds is dropped, and only
	// the escape byte: whatever follows it is text and is kept, which is what a
	// capture cut at a buffer boundary mid-escape looks like. Dropping it is also
	// what makes this a fixed point, by construction rather than by inspection: no
	// escape survives a pass, so a second pass takes the fast path above and cannot
	// change anything. Keeping it as text does not hold up, because removing a
	// sequence can push a stray escape against a following `[` and MAKE a
	// sequence that was not there before, so the same string strips to two
	// different results depending on how many times it has been through. Found by
	// the Rust half's fuzzer, `fuzz/fuzz_targets/minimizer_filters.rs`.
	return normalized.replace(ESCAPE_SEQUENCE, "").replaceAll("\x1b", "");
}

/**
 * Strip the same grammar from a stream, one chunk at a time.
 *
 * A consumer that re-strips the whole accumulated output on every arrival pays
 * for the bytes it already stripped: 256 arrivals of 4KiB scanned 128MiB and
 * cost 0.23ms at the first arrival against 2.06ms at the last, all of it to
 * display the tail. This scans each byte once.
 *
 * It is exact rather than a bounded-window approximation, and what makes that
 * affordable is that each push scans only the new chunk plus whatever sequence
 * was still open when the previous one ended. The scan is the same
 * left-to-right one [`stripAnsi`] performs: sequences are dropped as they
 * close, and a trailing escape that has not closed is held. [`pending`]
 * renders that held fragment the way a whole-string strip renders an input
 * ending mid-sequence — the escape dropped, the rest kept as text — so a
 * consumer showing `settled + pending` shows what `stripAnsi` of the bytes so
 * far shows, at every arrival and not only at the last.
 *
 * One sequence kind has no length limit — `OSC`, `DCS`, `SOS`, `PM` and `APC`
 * run until their terminator, and a clipboard write or a sixel image is how
 * that gets large — so a fragment that stays open past
 * [`OPEN_FRAGMENT_LIMIT`] is settled as text rather than held. That is what a
 * whole-string strip shows for a sequence whose terminator never arrives; a
 * terminator that arrives after the limit is the one case the two disagree, and
 * the alternative is a buffer a stream can grow without bound.
 */
export class AnsiStripper {
	/** The sequence that had not closed when the last chunk ran out. */
	#open = "";

	/**
	 * Text that is settled: nothing arriving later can change it. The
	 * unclosed remainder stays in [`pending`].
	 */
	push(chunk: string): string {
		const buffer = this.#open + chunk.replace(C1_INTRODUCERS, ch => C1_MAP[ch] ?? ch);
		this.#open = "";
		let settled = "";
		let cursor = 0;
		while (cursor < buffer.length) {
			const introducer = buffer.indexOf("\x1b", cursor);
			if (introducer === -1) {
				settled += buffer.slice(cursor);
				break;
			}
			settled += buffer.slice(cursor, introducer);
			SEQUENCE_AT.lastIndex = introducer;
			if (SEQUENCE_AT.test(buffer)) {
				cursor = SEQUENCE_AT.lastIndex;
				continue;
			}
			if (buffer.length - introducer > OPEN_FRAGMENT_LIMIT) {
				// Past the limit this is text, which is also what a whole-string
				// strip makes of an escape that opened nothing: drop the escape
				// and keep scanning, because a later sequence may still close.
				cursor = introducer + 1;
				continue;
			}
			this.#open = buffer.slice(introducer);
			break;
		}
		return settled;
	}

	/**
	 * What the unterminated remainder looks like on screen right now. It is
	 * provisional: the next chunk may complete the sequence and remove it.
	 */
	get pending(): string {
		return stripAnsi(this.#open);
	}

	/**
	 * Characters held back waiting for a terminator. Bounded by
	 * [`OPEN_FRAGMENT_LIMIT`], which is what makes a stream unable to grow this.
	 */
	get held(): number {
		return this.#open.length;
	}
}
