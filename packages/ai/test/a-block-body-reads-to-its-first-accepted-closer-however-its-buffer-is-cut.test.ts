/**
 * `BlockBody` reads a block to its first accepted closer, or at the stream's end to its first rejected one, and the
 * result does not depend on how the scanner's buffer was cut.
 *
 * WHY THIS SUITE EXISTS. The Hermes, Qwen3, Kimi, DeepSeek, Gemini and pi-native scanners read a call body through
 * `BlockBody` in `dialect/coercion.ts`. It searches only the unread buffer, moves the text proven to precede the
 * closer into `text`, and leaves only a suffix that could begin the closer unread, which is what keeps a body of n
 * bytes in k deltas at O(n) instead of O(n·k). Every scanner inherits its defects at once: a closer split across two
 * reads that is never found, a rejected closer counted twice or not at all, `accepts` shown only the buffer instead
 * of the whole body before the closer, a partial closer held back at the stream's end and so dropped, the stream-end
 * fallback closing at the last rejected closer instead of the first or returning the closer as unread text, and
 * `added` left over from an earlier read, which pi-native streams as argument text.
 *
 * CLASS CLOSED. Three closers with different self-overlap (none, a two-character period, one character repeated) are
 * read under three closer predicates (none, never accept, accept by a property of the text before the closer) over
 * seeded random inputs built from the closer's characters, its prefixes and a filler, each fed whole, per character
 * and in random pieces, the way a scanner feeds it: the unread rest plus the next delta, then a final read of the
 * rest. Each run must match a reference read of the whole input: the same text, closed state and unread rest, and
 * the same `accepts` calls in the same order. After every read `added` is what `text` grew by, and empty on the
 * stream-end fallback, which may shorten `text`; between reads the unread buffer is a proper prefix of the closer,
 * which bounds what is copied per delta. The sweep counts each outcome (closed at an accepted closer, closed by the
 * fallback, unclosed at the end with a partial closer held) and fails when one is never reached.
 *
 * NOT CAUGHT. Cost: the suite bounds what stays unread, not how long a read takes, so a reader that rescans `text`
 * on every read passes; `.internal` benchmarks measure that. Inputs are short (at most 48 characters).
 */
import { describe, expect, it } from "bun:test";
import { BlockBody } from "@veyyon/ai/dialect/coercion";

type Accepts = ((before: string) => boolean) | undefined;

interface Outcome {
	text: string;
	closed: boolean;
	rest: string;
	asked: string[];
}

const CLOSERS = ["</call:w>", "abab", "aaa"];

const PREDICATES: Record<string, (asked: string[]) => Accepts> = {
	none: () => undefined,
	never: asked => before => {
		asked.push(before);
		return false;
	},
	"even filler count": asked => before => {
		asked.push(before);
		let fillers = 0;
		for (const ch of before) if (ch === "x") fillers++;
		return fillers % 2 === 0 && before.length > 0;
	},
};

function lcg(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x7fffffff;
	};
}

/** The whole input read at once: the first accepted closer ends the body, else the first rejected one, else nothing. */
function reference(closer: string, input: string, predicate: (asked: string[]) => Accepts): Outcome {
	const asked: string[] = [];
	const accepts = predicate(asked);
	let rejected = -1;
	for (let at = input.indexOf(closer); at !== -1; at = input.indexOf(closer, at + 1)) {
		if (accepts === undefined || accepts(input.slice(0, at))) {
			return { text: input.slice(0, at), closed: true, rest: input.slice(at + closer.length), asked };
		}
		if (rejected === -1) rejected = at;
	}
	if (rejected === -1) return { text: input, closed: false, rest: "", asked };
	return { text: input.slice(0, rejected), closed: true, rest: input.slice(rejected + closer.length), asked };
}

/** Feeds the pieces the way a scanner does, asserting the per-read contract, and reports where the body ended. */
function drive(closer: string, pieces: readonly string[], predicate: (asked: string[]) => Accepts, label: string) {
	const asked: string[] = [];
	const accepts = predicate(asked);
	const body = new BlockBody(closer);
	let unread = "";
	let next = 0;
	while (next < pieces.length && !body.closed) {
		const before = body.text;
		unread = body.read(unread + pieces[next], false, accepts);
		next++;
		expect(body.text, `${label}: added after read ${next}`).toBe(before + body.added);
		if (!body.closed) {
			expect(
				unread.length < closer.length && closer.startsWith(unread),
				`${label}: held ${JSON.stringify(unread)}`,
			).toBe(true);
		}
	}
	let fallback = false;
	let heldAtEnd = false;
	if (!body.closed) {
		heldAtEnd = unread.length > 0;
		const before = body.text;
		unread = body.read(unread, true, accepts);
		fallback = body.closed;
		if (fallback) expect(body.added, `${label}: added on the stream-end fallback`).toBe("");
		else {
			expect(body.text, `${label}: added on the final read`).toBe(before + body.added);
			expect(unread, `${label}: unread after the final read`).toBe("");
		}
	}
	const outcome: Outcome = { text: body.text, closed: body.closed, rest: unread + pieces.slice(next).join(""), asked };
	return { outcome, fallback, heldAtEnd };
}

function randomInput(closer: string, random: () => number): string {
	const parts = [
		closer,
		closer.slice(0, Math.max(1, closer.length - 1)),
		closer.slice(0, 1),
		"x",
		"x",
		closer[1] ?? "",
	];
	let input = "";
	const count = Math.floor(random() * 12);
	for (let i = 0; i < count && input.length < 40; i++) input += parts[Math.floor(random() * parts.length)];
	return input;
}

function randomPieces(input: string, random: () => number): string[] {
	const pieces: string[] = [];
	for (let i = 0; i < input.length; ) {
		const size = 1 + Math.floor(random() * 4);
		pieces.push(input.slice(i, i + size));
		i += size;
	}
	return pieces;
}

describe("a block body reads to its first accepted closer however its buffer is cut", () => {
	for (const closer of CLOSERS) {
		for (const [name, predicate] of Object.entries(PREDICATES)) {
			it(`${JSON.stringify(closer)} with ${name} predicate`, () => {
				const random = lcg(closer.length * 7919 + name.length);
				const reached = { accepted: 0, fallback: 0, heldAtEnd: 0 };
				for (let c = 0; c < 400; c++) {
					const input = randomInput(closer, random);
					const expected = reference(closer, input, predicate);
					for (const pieces of [[input], [...input], randomPieces(input, random)]) {
						const label = `${JSON.stringify(pieces)}`;
						const { outcome, fallback, heldAtEnd } = drive(closer, pieces, predicate, label);
						expect(outcome, label).toEqual(expected);
						if (fallback) reached.fallback++;
						else if (outcome.closed) reached.accepted++;
						if (heldAtEnd) reached.heldAtEnd++;
					}
				}
				expect(reached.accepted > 0 || name === "never", `accepted closes ${reached.accepted}`).toBe(true);
				expect(reached.fallback > 0 || name === "none", `fallback closes ${reached.fallback}`).toBe(true);
				expect(reached.heldAtEnd, "partial closers held at the end").toBeGreaterThan(0);
			});
		}
	}
});
