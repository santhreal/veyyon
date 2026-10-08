/**
 * WHY: `detectDegenerateRepetition` compared every position against the position one unit later for
 * each of 199 unit lengths, and sliced and regex-tested a candidate unit at the end of every agreeing
 * run, however short. A compaction runs it on each summary it writes, so a 100,000-char summary held
 * the event loop for 45 ms per call. It now compares only positions `floor` apart, where `floor` is
 * the shortest agreement that can clear the four-repeat and 180-char floors, and measures a run only
 * around a probe that agrees.
 *
 * Class closed: any run the probe stride skips, for every unit length. The exhaustive scan below is
 * the scanner as it was, kept as the oracle. Every unit length is swept with a run whose agreement
 * sits on each side of the floors and at every alignment against the probe stride, and random texts
 * mix several runs, token continuations and whitespace, so a probe placed one position late, a run
 * measured from the wrong start or a floor one too high reports differently from the oracle.
 *
 * Not caught: the floors themselves are copied into the oracle, so changing them in the scanner
 * turns this suite red until the oracle is changed with them.
 */
import { describe, expect, test } from "bun:test";
import { detectDegenerateRepetition } from "@veyyon/ai/utils/thinking-loop";

const MIN_REPEATED_CHARS = 180;
const MAX_UNIT = 200;
const UNIT_CONTENT = /[\p{L}\p{Extended_Pictographic}]/u;

/** The scanner before the probe stride: every position, every unit length. */
function exhaustiveScan(text: string): string | null {
	if (text.length < MIN_REPEATED_CHARS) return null;
	for (let len = 2; len <= MAX_UNIT && text.length >= len * 4; len++) {
		let runStart = 0;
		let agreement = 0;
		for (let i = 0; i + len <= text.length; i++) {
			if (i + len < text.length && text.charCodeAt(i) === text.charCodeAt(i + len)) {
				if (agreement === 0) runStart = i;
				agreement++;
				continue;
			}
			if (agreement > 0) {
				const count = Math.floor((agreement + len) / len);
				const unit = text.slice(runStart, runStart + len);
				const continuesToken = !/\s/.test(unit) && runStart > 0 && !/\s/.test(text[runStart - 1] as string);
				if (count >= 4 && count * len >= MIN_REPEATED_CHARS && UNIT_CONTENT.test(unit) && !continuesToken) {
					return `repeated "${unit.trim()}" ${count}× back-to-back`;
				}
				agreement = 0;
			}
		}
	}
	return null;
}

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Text with no periodic run of its own: every char is drawn independently from a wide alphabet. */
function noise(next: () => number, chars: number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,;:-_/";
	let out = "";
	for (let i = 0; i < chars; i++) out += alphabet[Math.floor(next() * alphabet.length)];
	return out;
}

/** `span` chars of text periodic with period `unit.length`, which is `span - len` agreeing positions. */
function periodic(unit: string, span: number): string {
	return unit.repeat(Math.ceil(span / unit.length)).slice(0, span);
}

function unitOf(next: () => number, len: number, alphabet: string): string {
	let unit = "";
	for (let i = 0; i < len; i++) unit += alphabet[Math.floor(next() * alphabet.length)];
	return unit;
}

describe("the completed-text scanner reports what an exhaustive scan reports", () => {
	test("for every unit length, a run on each side of the floors at every alignment", () => {
		const next = random(7);
		const mismatches: string[] = [];
		const missed: number[] = [];
		for (let len = 2; len <= MAX_UNIT; len++) {
			const floor = Math.max(3 * len, MIN_REPEATED_CHARS - len);
			// A word unit: letters and one space, so it carries content and starts a token.
			const unit = `${unitOf(next, len - 1, "abcdefghijklmnopqrstuvwxyz")} `;
			for (const agreement of [floor - 1, floor, floor + 1, floor + len, floor + 2 * len + 1]) {
				// Every alignment of the run against a stride of `floor` within the first stride.
				for (const offset of [0, 1, Math.floor(floor / 2), floor - 2, floor - 1, floor]) {
					const text = `${noise(next, offset)} ${periodic(unit, agreement + len)}${noise(next, 3 + (offset % 5))}`;
					const expected = exhaustiveScan(text);
					const got = detectDegenerateRepetition(text);
					if (got !== expected)
						mismatches.push(`len ${len} agreement ${agreement} offset ${offset}: ${got} vs ${expected}`);
					if (agreement >= floor + len && got === null) missed.push(len);
				}
			}
		}
		expect(mismatches).toEqual([]);
		// A run a full unit past both floors is reported at every length: the sweep is not all clean text.
		expect(missed).toEqual([]);
	});

	test("random texts with several runs, drifted units, token continuations and whitespace", () => {
		const next = random(11);
		const mismatches: string[] = [];
		let reported = 0;
		for (let round = 0; round < 1500; round++) {
			let text = "";
			const pieces = 1 + Math.floor(next() * 4);
			for (let piece = 0; piece < pieces; piece++) {
				text += noise(next, Math.floor(next() * 120));
				if (next() < 0.5) text += next() < 0.5 ? " " : "\n";
				const len = 2 + Math.floor(next() * 60);
				// A narrow alphabet makes accidental agreement common; spaces make some units words.
				const unit = unitOf(next, len, next() < 0.5 ? "ab " : "abcxyz_");
				const floor = Math.max(3 * len, MIN_REPEATED_CHARS - len);
				const span = Math.floor(floor * (0.7 + next() * 0.8)) + len;
				if (next() < 0.4) {
					// The unit drifts by one char and keeps repeating: the agreement breaks at one position
					// and a second run starts at the very next one.
					const at = Math.floor(next() * len);
					const drifted = `${unit.slice(0, at)}${unit[at] === "q" ? "r" : "q"}${unit.slice(at + 1)}`;
					text += unit.repeat(Math.ceil(span / len));
					text += periodic(drifted, Math.floor(floor * (0.7 + next() * 0.8)) + len);
				} else {
					text += periodic(unit, span);
				}
			}
			const expected = exhaustiveScan(text);
			const got = detectDegenerateRepetition(text);
			if (got !== null) reported++;
			if (got !== expected) mismatches.push(`round ${round}: ${got} vs ${expected}`);
		}
		expect(mismatches).toEqual([]);
		// Both verdicts occur: the comparison above covers reported runs, not only clean text.
		expect(reported).toBeGreaterThan(300);
		expect(reported).toBeLessThan(1500);
	});
});
