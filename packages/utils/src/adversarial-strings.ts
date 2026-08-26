/**
 * Shared adversarial string generators and deterministic seeded RNG for fuzz suites.
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

/**
 * Deterministic 32-bit linear congruential generator returning raw `uint32` states.
 */
export function lcgUint32(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s;
	};
}

/** Deterministic 32-bit LCG in `[0, 1)`, so any failure reproduces from the printed seed. */
export function lcg(seed: number): () => number {
	const next = lcgUint32(seed);
	return () => next() / 0x1_0000_0000;
}

/** Concatenate up to `maxFragments` random fragments into one adversarial string. */
export function buildString(rand: () => number, maxFragments = 24): string {
	const n = Math.floor(rand() * maxFragments);
	let out = "";
	for (let i = 0; i < n; i++) out += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)];
	return out;
}

/** Environment variable that pins a run's seeds, so a failure can be replayed exactly. */
export const FUZZ_SEED_ENV = "VEYYON_FUZZ_SEED";

/** The run nonce, resolved once per process. */
let runNonce: number | null = null;

/**
 * Resolves the run nonce from {@link FUZZ_SEED_ENV} or draws a random unsigned 32-bit int.
 */
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

/**
 * Mixes a call-site's fixed base seed with the per-run nonce using SplitMix32.
 */
export function fuzzSeed(base: number): number {
	const nonce = resolveRunNonce();
	if (nonce === 0) return base >>> 0;

	// SplitMix32 finalizer, so nonce values one apart give unrelated seeds rather than adjacent
	// LCG streams. An LCG seeded with n and n+1 produces sequences that stay close for a while,
	// which would make consecutive runs explore nearly the same inputs.
	let mixed = (base ^ nonce) >>> 0;
	mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0_aaad) >>> 0;
	mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a_2d97) >>> 0;
	return (mixed ^ (mixed >>> 15)) >>> 0;
}

/** Reset the resolved nonce. Only the suite that tests this module calls it. @internal */
export function resetFuzzSeedForTest(): void {
	runNonce = null;
}

/** How a fuzz run draws its inputs. See {@link fuzzStrings}. */
export interface FuzzStringsOptions {
	/**
	 * The call site's fixed constant, mixed with the run nonce by {@link fuzzSeed}. It doubles as the
	 * suite's identity, so two suites passing different constants keep independent streams.
	 */
	readonly seed: number;
	/** Generated inputs to try, after the corpus. */
	readonly iterations: number;
	/**
	 * Known-failing input strings replayed first on every run before generated inputs.
	 */
	readonly corpus?: readonly string[];
	/** Upper bound on fragments per generated input. Defaults to `buildString`'s own. */
	readonly maxFragments?: number;
	/**
	 * Optional custom generator when the suite requires a specialized alphabet or shape.
	 */
	readonly build?: (rand: () => number) => string;
}

/**
 * One fuzz case: the adversarial string, plus a generator for any other input the check needs.
 *
 * The second argument is rebuilt identically for every replay of the same case, so a check that
 * draws column indices or flags from it stays deterministic under shrinking.
 */
export type FuzzCheck = (input: string, rand: () => number) => void;

/** The shortest input still failing `check`, and how many attempts it took to get there. */
interface ShrinkResult {
	readonly input: string;
	readonly error: unknown;
}

/**
 * Options for structured fuzzing where test cases are complex objects rather than strings.
 */
export interface FuzzCasesOptions<T> {
	/** Same contract as {@link FuzzStringsOptions.seed}: mixed with the per-run nonce. */
	readonly seed: number;
	readonly iterations: number;
	/** Known-bad cases, replayed before any generated one. Checked-in literals, not a directory. */
	readonly corpus?: readonly T[];
	/** Build one case. The generator is the run's stream, so cases stay reproducible in order. */
	readonly build: (rand: () => number) => T;
	/**
	 * Returns candidate simplifications for a failing case, ordered from largest reduction first.
	 */
	readonly simplify?: (input: T) => readonly T[];
	/** How the failure names a case. Defaults to `JSON.stringify`. */
	readonly describe?: (input: T) => string;
}

/** One structured fuzz case: the case, plus a generator for anything else the check needs. */
export type FuzzCaseCheck<T> = (input: T, rand: () => number) => void;

/**
 * Runs `check` over corpus and generated cases, shrinking any failures via `simplify`.
 */
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
			// Already minimal by construction, and shrinking it would report a DIFFERENT case than
			// the one checked in, which reads as a second bug.
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

/** Pin a case's secondary randomness, for the reason {@link boundCheck} documents. */
function boundCaseCheck<T>(check: FuzzCaseCheck<T>, caseSeed: number): (input: T) => void {
	return input => check(input, lcg(caseSeed));
}

/**
 * Shrinks a failing structured case by trying candidates from `simplify` until minimal.
 */
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

/** The string-driver failure shape, for structured cases. */
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

/**
 * Runs `check` over corpus and generated adversarial strings, delta-debugging failures to minimal inputs.
 */
export function fuzzStrings(options: FuzzStringsOptions, check: FuzzCheck): void {
	const streamSeed = fuzzSeed(options.seed);
	const corpus = options.corpus ?? [];

	for (let i = 0; i < corpus.length; i++) {
		const entry = corpus[i] as string;
		const caseCheck = boundCheck(check, mix32(streamSeed ^ ~i));
		try {
			caseCheck(entry);
		} catch (error) {
			// A corpus entry is already minimal by construction, and shrinking it would report a
			// DIFFERENT string than the one checked in, which reads as a second bug.
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

/**
 * Wraps `check` with a per-case deterministic RNG so shrinking replays the exact same secondary choices.
 */
function boundCheck(check: FuzzCheck, caseSeed: number): (input: string) => void {
	return input => check(input, lcg(caseSeed));
}

/** SplitMix32 finalizer, so neighbouring case seeds are unrelated rather than one LCG step apart. */
function mix32(value: number): number {
	let mixed = value >>> 0;
	mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0_aaad) >>> 0;
	mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a_2d97) >>> 0;
	return (mixed ^ (mixed >>> 15)) >>> 0;
}

/**
 * Delta-debugs `input` by binary partitioning down to the shortest string `check` still rejects.
 */
function shrink(input: string, error: unknown, check: (input: string) => void): ShrinkResult {
	let best: ShrinkResult = { input, error };
	let units = [...best.input];

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
				units = [...candidate];
				progressed = true;
				break;
			}
		}
	}

	return best;
}

/** The error a failing fuzz input is reported as: minimal input, scale, and the corpus line. */
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
