import { makeExpander } from "./codec.js";
import { HANDLE_NAME_CHAR_RE } from "./constants.js";
import type { Vocabulary } from "./types.js";

/** Whether `ch` is a handle-name character (the class the boundary guard uses). */
function isNameChar(ch: string): boolean {
	return HANDLE_NAME_CHAR_RE.test(ch);
}

/**
 * A stateful decoder for text that arrives in pieces, so a harness can expand
 * handles in a live token stream without ever showing a raw one.
 *
 * The problem it solves is the one thing plain {@link makeExpander} cannot: a
 * handle can be split across chunk boundaries. A model streaming `§dbconn` may
 * deliver it as `§db` then `conn`, and expanding each chunk on its own would
 * either leak the raw `§db…` to the screen or expand a shorter handle (`§db`)
 * before the rest of the name arrives and changes which handle matches. Longest
 * match (`§dbconn` beats `§db`) is only decidable once the whole name and its
 * trailing boundary are in hand.
 *
 * So this decoder buffers exactly the trailing fragment that could still become,
 * or still change, a handle, and emits everything before it already expanded.
 * The retained fragment is at most a sigil plus the longest handle name, so the
 * buffer is bounded no matter how the stream is chunked. Feed every chunk to
 * {@link push} and render only what it returns; call {@link flush} once at end of
 * stream to release the final fragment. The concatenation of every `push` return
 * plus the `flush` return is byte-identical to expanding the whole text at once,
 * for any chunking of that text. That is the contract a streaming display rests
 * on: the viewer never sees a `§handle`, and never sees a handle expanded to the
 * wrong string because the stream happened to break mid-name.
 *
 * A decoder built from a vocabulary with no handles is a pure pass-through: it
 * holds nothing and returns each chunk verbatim, so a session with nothing loaded
 * streams with zero added latency.
 *
 * The vocabulary is a snapshot taken at construction. A stream decoder is meant
 * to live for one message; build a new one per message (or per subagent stream)
 * from the session's current vocabulary, and it will reflect whatever is loaded
 * when the message begins.
 */
export class StreamDecoder {
	private readonly expand: (text: string) => string;
	private readonly sigil: string;
	private readonly maxNameLen: number;
	private readonly active: boolean;
	private held = "";

	constructor(vocab: Vocabulary) {
		this.expand = makeExpander(vocab);
		this.sigil = vocab.sigil;
		this.active = vocab.handles.size > 0;
		let max = 0;
		for (const name of vocab.handles.keys()) {
			if (name.length > max) max = name.length;
		}
		this.maxNameLen = max;
	}

	/**
	 * Feed the next chunk of streamed text. Returns the newly decodable text: every
	 * handle that is now fully determined, expanded, with any trailing fragment that
	 * could still grow into a handle held back for the next chunk. The return is
	 * always safe to display as-is; it never contains a raw handle and never a
	 * handle expanded under an incomplete name.
	 */
	push(chunk: string): string {
		// No handles loaded: nothing can ever match, so stream every chunk straight
		// through and never buffer. This is the inert-session fast path.
		if (!this.active) {
			return chunk;
		}
		if (chunk === "") {
			return "";
		}
		const buf = this.held + chunk;
		const retain = this.retainStart(buf);
		this.held = buf.slice(retain);
		return this.expand(buf.slice(0, retain));
	}

	/**
	 * Release the buffered tail at end of stream. The tail is now final, so a
	 * complete handle in it expands and a dangling fragment (a bare sigil, or a
	 * name that never completed into a known handle) passes through verbatim, which
	 * is correct: at end of stream that fragment is the literal text the model
	 * wrote. Leaves the decoder empty so it can be reused.
	 */
	flush(): string {
		const tail = this.held;
		this.held = "";
		if (!this.active) {
			return tail;
		}
		return this.expand(tail);
	}

	/** Drop any buffered tail without emitting it (e.g. on an aborted stream). */
	reset(): void {
		this.held = "";
	}

	/** The buffered tail not yet emitted. For tests and diagnostics only. */
	get pending(): string {
		return this.held;
	}

	/**
	 * The index in `buf` from which the tail must be held: the earliest position
	 * where a handle could still be forming as more text arrives. Everything before
	 * it is fully determined and safe to expand now.
	 *
	 * Two things at the end of the buffer are ambiguous:
	 *
	 * - **A sigil with an all-name-character tail running to the end.** The next
	 *   char could extend the name (changing which handle matches, or refusing the
	 *   match) or end it (completing the match), so the region from that sigil on is
	 *   held. Only the last sigil can qualify: a non-name character anywhere after
	 *   an earlier sigil both terminates that earlier handle and disqualifies it.
	 *   The tail is held only while it is still short enough to be a known name
	 *   (`<= maxNameLen`); once the run of name characters is longer than the
	 *   longest handle, no known handle can start there — the character right after
	 *   any known name would be a name character and fail the boundary guard — so it
	 *   is released and never held unbounded.
	 * - **A trailing partial sigil**, for a multi-character sigil whose last bytes
	 *   are only a prefix of it. The next chunk could complete the sigil into a
	 *   handle start, so it is held. (A single-character sigil never hits this.)
	 */
	private retainStart(buf: string): number {
		let holdAt = buf.length;

		const sigilLen = this.sigil.length;
		const lastSigil = buf.lastIndexOf(this.sigil);
		if (lastSigil >= 0) {
			const tailStart = lastSigil + sigilLen;
			let allName = true;
			for (let k = tailStart; k < buf.length; k++) {
				if (!isNameChar(buf.charAt(k))) {
					allName = false;
					break;
				}
			}
			if (allName && buf.length - tailStart <= this.maxNameLen) {
				holdAt = lastSigil;
			}
		}

		if (sigilLen > 1) {
			// The longest trailing fragment that is a proper prefix of the sigil.
			for (let k = sigilLen - 1; k >= 1; k--) {
				if (buf.endsWith(this.sigil.slice(0, k))) {
					holdAt = Math.min(holdAt, buf.length - k);
					break;
				}
			}
		}

		return holdAt;
	}
}

/** Build a {@link StreamDecoder} for `vocab`. */
export function makeStreamDecoder(vocab: Vocabulary): StreamDecoder {
	return new StreamDecoder(vocab);
}
