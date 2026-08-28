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

export function lcgUint32(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s;
	};
}

export function lcg(seed: number): () => number {
	const next = lcgUint32(seed);
	return () => next() / 0x1_0000_0000;
}

export function buildString(rand: () => number, maxFragments = 24): string {
	const n = Math.floor(rand() * maxFragments);
	let out = "";
	for (let i = 0; i < n; i++) out += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)];
	return out;
}

export const FUZZ_SEED_ENV = "VEYYON_FUZZ_SEED";

let runNonce: number | null = null;

function resolveRunNonce(): number {
	if (runNonce !== null) return runNonce;

	const pinned = process.env[FUZZ_SEED_ENV];
	if (pinned === undefined) {
		runNonce = (Math.random() * 0x1_0000_0000) >>> 0;
		console.log(`fuzz seeds: ${FUZZ_SEED_ENV}=0x${runNonce.toString(16).padStart(8, "0")} replays this run`);
		return runNonce;
	}

	const parsed = Number(pinned);
	if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
		throw new Error(
			`${FUZZ_SEED_ENV} must be an unsigned 32-bit integer (decimal or 0x-prefixed hex), got ${JSON.stringify(pinned)}`,
		);
	}
	runNonce = parsed >>> 0;
	return runNonce;
}

export function fuzzSeed(base: number): number {
	const nonce = resolveRunNonce();
	if (nonce === 0) return base >>> 0;

	let mixed = (base ^ nonce) >>> 0;
	mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0_aaad) >>> 0;
	mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a_2d97) >>> 0;
	return (mixed ^ (mixed >>> 15)) >>> 0;
}

export function resetFuzzSeedForTest(): void {
	runNonce = null;
}

export interface FuzzStringsOptions {
	readonly seed: number;
	readonly iterations: number;
	readonly corpus?: readonly string[];
	readonly maxFragments?: number;
	readonly build?: (rand: () => number) => string;
}

export type FuzzCheck = (input: string, rand: () => number) => void;

interface ShrinkResult {
	readonly input: string;
	readonly error: unknown;
}

export interface FuzzCasesOptions<T> {
	readonly seed: number;
	readonly iterations: number;
	readonly corpus?: readonly T[];
	readonly build: (rand: () => number) => T;
	readonly simplify?: (input: T) => readonly T[];
	readonly describe?: (input: T) => string;
}

export type FuzzCaseCheck<T> = (input: T, rand: () => number) => void;

export function fuzzCases<T>(options: FuzzCasesOptions<T>, check: FuzzCaseCheck<T>): void {
	const streamSeed = fuzzSeed(options.seed);
	const describe = options.describe ?? ((input: T) => JSON.stringify(input));
	const corpus = options.corpus ?? [];

	for (let i = 0; i < corpus.length; i++) {
		const entry = corpus[i] as T;
		const caseCheck = boundCaseCheck(check, mix32(streamSeed ^ ~i));
		try {
			caseCheck(entry);
		} catch (error) {
			throw caseFailure(describe(entry), describe(entry), error, true);
		}
	}

	const rand = lcg(streamSeed);
	for (let i = 0; i < options.iterations; i++) {
		const input = options.build(rand);
		const caseCheck = boundCaseCheck(check, mix32(streamSeed ^ (i + 1)));
		try {
			caseCheck(input);
		} catch (error) {
			const minimal = shrinkCase(input, error, caseCheck, options.simplify);
			throw caseFailure(describe(input), describe(minimal.input), minimal.error, false);
		}
	}
}

function boundCaseCheck<T>(check: FuzzCaseCheck<T>, caseSeed: number): (input: T) => void {
	return input => check(input, lcg(caseSeed));
}

function shrinkCase<T>(
	input: T,
	error: unknown,
	check: (input: T) => void,
	simplify: ((input: T) => readonly T[]) | undefined,
): { readonly input: T; readonly error: unknown } {
	if (!simplify) return { input, error };

	const MAX_ATTEMPTS = 10_000;
	let best = { input, error };
	let attempts = 0;
	const seen = new Set<string>([JSON.stringify(input)]);

	for (let progressed = true; progressed && attempts < MAX_ATTEMPTS; ) {
		progressed = false;
		for (const candidate of simplify(best.input)) {
			if (attempts >= MAX_ATTEMPTS) break;
			const key = JSON.stringify(candidate);
			if (seen.has(key)) continue;
			seen.add(key);
			attempts += 1;
			try {
				check(candidate);
			} catch (thrown) {
				best = { input: candidate, error: thrown ?? new Error("check threw a falsy value") };
				progressed = true;
				break;
			}
		}
	}

	return best;
}

function caseFailure(original: string, minimal: string, error: unknown, fromCorpus: boolean): Error {
	const origin = fromCorpus
		? "corpus case failed"
		: minimal === original
			? "generated case failed (did not shrink)"
			: `generated case failed (shrunk from ${original.length} to ${minimal.length} characters)`;
	const message = [
		`${origin}: ${minimal}`,
		`replay this run with ${FUZZ_SEED_ENV}=0x${resolveRunNonce().toString(16).padStart(8, "0")}`,
		`corpus entry: ${minimal}`,
	].join("\n");
	return new Error(message, { cause: error });
}

export function fuzzStrings(options: FuzzStringsOptions, check: FuzzCheck): void {
	const streamSeed = fuzzSeed(options.seed);
	const corpus = options.corpus ?? [];

	for (let i = 0; i < corpus.length; i++) {
		const entry = corpus[i] as string;
		const caseCheck = boundCheck(check, mix32(streamSeed ^ ~i));
		try {
			caseCheck(entry);
		} catch (error) {
			throw fuzzFailure({ input: entry, error }, entry.length, true);
		}
	}

	const build = options.build ?? (draw => buildString(draw, options.maxFragments));
	const rand = lcg(streamSeed);
	for (let i = 0; i < options.iterations; i++) {
		const input = build(rand);
		const caseCheck = boundCheck(check, mix32(streamSeed ^ (i + 1)));
		try {
			caseCheck(input);
		} catch (error) {
			throw fuzzFailure(shrink(input, error, caseCheck), input.length, false);
		}
	}
}

function boundCheck(check: FuzzCheck, caseSeed: number): (input: string) => void {
	return input => check(input, lcg(caseSeed));
}

function mix32(value: number): number {
	let mixed = value >>> 0;
	mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0_aaad) >>> 0;
	mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a_2d97) >>> 0;
	return (mixed ^ (mixed >>> 15)) >>> 0;
}

function shrink(input: string, error: unknown, check: (input: string) => void): ShrinkResult {
	let best: ShrinkResult = { input, error };
	let units = Array.from(best.input);

	const fails = (candidate: string): unknown | undefined => {
		if (candidate === best.input) return undefined;
		try {
			check(candidate);
			return undefined;
		} catch (thrown) {
			return thrown ?? new Error("check threw a falsy value");
		}
	};

	for (let chunk = Math.max(1, Math.floor(units.length / 2)); chunk >= 1; chunk = Math.floor(chunk / 2)) {
		let progressed = true;
		while (progressed) {
			progressed = false;
			for (let start = 0; start + chunk <= units.length; start += chunk) {
				const candidate = units
					.slice(0, start)
					.concat(units.slice(start + chunk))
					.join("");
				const thrown = fails(candidate);
				if (thrown === undefined) continue;
				best = { input: candidate, error: thrown };
				units = Array.from(candidate);
				progressed = true;
				break;
			}
		}
	}

	return best;
}

function fuzzFailure(result: ShrinkResult, originalLength: number, fromCorpus: boolean): Error {
	const origin = fromCorpus
		? "corpus entry failed"
		: `generated input failed (shrunk from ${originalLength} to ${result.input.length} code units)`;
	const message = [
		`${origin}: ${JSON.stringify(result.input)}`,
		`replay this run with ${FUZZ_SEED_ENV}=0x${resolveRunNonce().toString(16).padStart(8, "0")}`,
		`corpus entry: ${JSON.stringify(result.input)}`,
	].join("\n");
	return new Error(message, { cause: result.error });
}
