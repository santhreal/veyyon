/**
 * The streaming tail a tool card shows while the tool runs.
 *
 * The card displays the last [`VISIBLE_CHARS`] characters of the output with
 * tabs expanded and ANSI stripped. Doing that by re-stripping the whole
 * accumulated buffer on every arrival pays for bytes already stripped: a 1MiB
 * stream delivered as 256 arrivals scanned 128MiB and grew from 0.23ms at the
 * first arrival to 2.06ms at the last, all to show 2048 characters.
 *
 * This keeps the stripper's state instead, so each arrival scans only what
 * arrived, and keeps only the visible window plus whatever sequence is still
 * open. The displayed text is the same text: the stripper is exact, and what
 * the whole-buffer pass would have shown for bytes that end mid-sequence is
 * what [`AnsiStripper.pending`] shows.
 */

import { AnsiStripper } from "@veyyon/utils/strip-ansi";
import { replaceTabs } from "./util";

/** Characters of tail the card shows. Longer output is elided from the left. */
export const VISIBLE_CHARS = 2048;

export class PartialTail {
	#stripper = new AnsiStripper();
	/** Raw bytes pushed so far, so the next arrival can be read as a delta. */
	#raw = "";
	#settled = "";
	#dropped = false;

	/**
	 * Take the accumulated raw output. The same value twice is a no-op, so a
	 * re-render costs nothing and a double render cannot double-count.
	 *
	 * Whether this arrival extends the last one is decided by comparing it
	 * against the bytes already consumed. That comparison is a memcmp of a
	 * string the caller already holds — no copy, and about 0.05ms per MiB — and
	 * it is what makes a rewind exact rather than guessed: a host sending a
	 * sliding window, or a second tool call reusing the card, does not extend
	 * what was shown and must start over.
	 */
	push(raw: string): void {
		if (raw === this.#raw) return;
		if (!raw.startsWith(this.#raw)) this.#restart();
		const delta = raw.slice(this.#raw.length);
		this.#raw = raw;
		this.#settled += replaceTabs(this.#stripper.push(delta));
		if (this.#settled.length <= VISIBLE_CHARS) return;
		this.#settled = this.#settled.slice(-VISIBLE_CHARS);
		this.#dropped = true;
	}

	/** What to render, elided from the left when anything was cut. */
	get text(): string {
		// `pending` is the sequence still arriving, rendered the way a
		// whole-buffer strip renders an input that ends inside one.
		const shown = this.#settled + replaceTabs(this.#stripper.pending);
		if (shown.length <= VISIBLE_CHARS) return this.#dropped ? `…${shown}` : shown;
		return `…${shown.slice(-VISIBLE_CHARS)}`;
	}

	/**
	 * Characters this holds, which a stream cannot grow: the visible window plus
	 * whatever sequence has not closed. It does not count the raw buffer, which
	 * is the caller's own string handed in by reference and never copied.
	 */
	get retained(): number {
		return this.#settled.length + this.#stripper.held;
	}

	#restart(): void {
		this.#stripper = new AnsiStripper();
		this.#raw = "";
		this.#settled = "";
		this.#dropped = false;
	}
}
