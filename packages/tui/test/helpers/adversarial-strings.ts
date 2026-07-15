/**
 * Shared adversarial-string generators for the width/render fuzz suites.
 *
 * One home for the fragment pool, the deterministic LCG, and the random-string
 * builder so every fuzzer over the native width primitives (truncateToWidth,
 * visibleWidth, wrapTextWithAnsi, sliceWithWidth, extractSegments) draws from
 * the SAME adversarial surface — lone surrogates, malformed ANSI/OSC, combining
 * / zero-width / wide / ZWJ graphemes, control bytes — instead of each test
 * hand-rolling its own drifting copy.
 */

/** Adversarial fragments assembled into random strings. */
export const FRAGMENTS: readonly string[] = [
	"a",
	"Z",
	"9",
	" ",
	"\t",
	"\n",
	"\r",
	"\x00",
	"\x07",
	"\x08",
	"\x0b",
	"\x1b",
	"\x7f",
	"̀", // combining grave
	"҉", // combining enclosing
	"​", // zero-width space
	"‍", // ZWJ
	"﻿", // BOM
	"⁠", // word joiner
	"一", // CJK (wide)
	"Ａ", // fullwidth A (wide)
	"　", // ideographic space (wide)
	"\u{1f600}", // emoji
	"\u{1f468}‍\u{1f469}‍\u{1f467}", // ZWJ family
	String.fromCharCode(0xd800), // lone high surrogate
	String.fromCharCode(0xdc00), // lone low surrogate
	String.fromCharCode(0xdbff), // lone high surrogate (max)
	"\x1b[31m",
	"\x1b[0m",
	"\x1b[1;32;40m",
	"\x1b[", // truncated CSI
	"\x1b]", // bare OSC intro
	"\x1b]66;s=2;", // unterminated OSC66
	"\x1b]66;s=2;X\x07", // full OSC66 span
	"\x1b\\", // string terminator
];

/** Deterministic 32-bit LCG so any failure reproduces from the printed seed. */
export function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x1_0000_0000;
	};
}

/** Concatenate up to `maxFragments` random fragments into one adversarial string. */
export function buildString(rand: () => number, maxFragments = 24): string {
	const n = Math.floor(rand() * maxFragments);
	let out = "";
	for (let i = 0; i < n; i++) out += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)];
	return out;
}
