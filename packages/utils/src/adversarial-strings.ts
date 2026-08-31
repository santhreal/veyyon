/**
 * Shared adversarial-string generators for every fuzz suite in the workspace.
 *
 * One home for the fragment pool, the deterministic LCG, and the random-string
 * builder, so every fuzzer draws from the SAME adversarial surface -- lone
 * surrogates, malformed ANSI/OSC, combining / zero-width / wide / ZWJ graphemes,
 * control bytes -- instead of each test hand-rolling its own drifting copy.
 *
 * WHY IT LIVES IN `@veyyon/utils` AND NOT IN A TEST DIRECTORY. It used to sit
 * under `packages/tui/test/helpers/`, which nine tui suites imported by relative
 * path. A test directory is not an API: the coding-agent fuzzer could not import
 * it, so it carried a byte-identical copy of {@link lcg} instead -- same
 * multiplier, same increment, same normalization. A duplicated seeded RNG is the
 * worst kind of copy, because the two stay identical right up until one is tuned
 * and then "the same seed" silently means two different streams in two suites.
 * A dependency every package already has is the only place both can reach, so
 * that is where it is, beside the other cross-package dev utilities
 * (`bench-harness`, `conformance`).
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
 * Deterministic 32-bit LCG, drawing raw `uint32` states.
 *
 * This is the ONE place the recurrence lives. Numerical Recipes' `ranqd1`
 * constants: `s = (s * 1664525 + 1013904223) mod 2^32`. Callers that want a
 * fraction use {@link lcg}, which is this function normalized -- so the two draw
 * the identical state sequence from the identical seed and can never drift apart
 * the way two hand-written copies do.
 *
 * Use this form when you need integers: `next() % n` over raw states costs one
 * operation, where the fraction form would multiply back out and re-floor.
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
 * The nonce every seed in this run is mixed with.
 *
 * Resolved from {@link FUZZ_SEED_ENV} when it is set, and drawn at random otherwise, in which case
 * the value is printed once so the run can be replayed. A malformed value THROWS rather than
 * falling back to a random one: silently ignoring `VEYYON_FUZZ_SEED=0xdeadbeff` would run a
 * different set of inputs than the one being reproduced and report that the bug is gone.
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
 * The seed a fuzz suite should use, given the fixed one written at the call site.
 *
 * WHY THE FIXED SEED IS NOT ENOUGH. Every hand-rolled fuzzer in this workspace hardcoded its seed,
 * so each run replayed the identical inputs: a large table-driven suite rather than a fuzzer, and
 * one that will never reach input 8,001 however long it runs. Mixing the call site's constant with
 * a per-run nonce makes consecutive runs explore different inputs while keeping every suite's
 * streams independent of each other.
 *
 * Reproducibility is preserved rather than traded away. The nonce is printed once per process, and
 * setting {@link FUZZ_SEED_ENV} to it replays every suite in the run exactly. `VEYYON_FUZZ_SEED=0`
 * is the deterministic mode: the nonce is zero and every call site gets back the constant it was
 * written with, which is what a bisect wants.
 *
 * `base` doubles as the call site's identity, so two suites that pass different constants keep
 * different streams under every nonce. That is why the constants stay in the source rather than
 * being replaced by labels: they are already unique, already there, and cost nothing.
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
	 * Inputs that broke this check before, replayed FIRST on every run and under every seed.
	 *
	 * A fuzz find that is not written down is only found again by luck. Each entry is a literal in
	 * the suite's source, copied from the `corpus entry:` line a failure prints.
	 */
	readonly corpus?: readonly string[];
	/** Upper bound on fragments per generated input. Defaults to `buildString`'s own. */
	readonly maxFragments?: number;
	/**
	 * How to build one generated input, when the shared {@link FRAGMENTS} pool is not the right one.
	 *
	 * Several suites need a narrower alphabet than the shared pool: the width-math oracle only holds
	 * for fragments both implementations agree on, the stdin decoder wants raw byte sequences, and
	 * the key parser wants CSI-shaped noise. They each had their own loop over their own pool, which
	 * is exactly how they ended up without shrinking or a corpus. Passing the builder keeps the pool
	 * where it belongs -- next to the invariant that constrains it -- and still gets both.
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
 * The same driver for a case that is a STRUCTURE rather than a string.
 *
 * Two suites could not use {@link fuzzStrings} and said so in their headers: `bracketed-paste-fuzz`
 * generates a pasted stream together with the marker offsets inside it and a chunking of that
 * stream, and `deccara-fuzz` generates a line together with the width it must fill. Shrinking the
 * string alone would report an input that no longer matches its own parameters -- a stream whose
 * recorded marker offsets point past its end -- and a reader would chase that instead of the bug.
 * So they kept hand-written loops, which is exactly how they ended up without shrinking or a
 * corpus, the two gaps `fuzzStrings` exists to close.
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
	 * Every simpler case this one could be reduced to, biggest reduction first.
	 *
	 * Candidates rather than a search, so ONE minimisation strategy serves every domain: the driver
	 * takes the first candidate that still fails and repeats from there. Each candidate must be a
	 * case the builder could itself have produced -- drop a whole paste, drop a segment, merge two
	 * chunks -- because a candidate that is internally inconsistent reports a bug that does not
	 * exist. Omit it and a failure is reported unshrunk, which is still better than a wrong minimum.
	 */
	readonly simplify?: (input: T) => readonly T[];
	/** How the failure names a case. Defaults to `JSON.stringify`. */
	readonly describe?: (input: T) => string;
}

/** One structured fuzz case: the case, plus a generator for anything else the check needs. */
export type FuzzCaseCheck<T> = (input: T, rand: () => number) => void;

/**
 * Run `check` over the corpus and then over generated cases, minimising any failure through
 * `simplify`.
 *
 * The failure report is deliberately identical in shape to the string driver's: what failed, how
 * far it shrank, the seed that replays the run, and a paste-ready corpus line. A reader should not
 * have to know which driver a suite uses to read its output.
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
 * Take the first candidate that still fails and repeat from there.
 *
 * Candidates already tried are remembered, so a `simplify` that can return the case it was given
 * (or cycle between two forms) cannot spin: it runs out of new candidates and stops. The bound on
 * total attempts is the second half of that guarantee, for a `simplify` that generates an unbounded
 * family -- a fuzz run must not become the thing that hangs CI.
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
 * Run `check` over the corpus and then over generated adversarial strings, shrinking any failure.
 *
 * WHY THIS EXISTS RATHER THAN A HAND-WRITTEN LOOP. The ten hand-rolled fuzzers each wrote their own
 * `for` loop over {@link buildString}, which left two gaps that no amount of iterations closes.
 *
 * The first is shrinking. A generated input is up to 24 fragments of lone surrogates, truncated CSI
 * sequences and ZWJ clusters; exactly one of them usually matters. Reporting the whole 300-character
 * string means the first job after every find is to minimise it by hand, which is mechanical work a
 * machine does better and does the same way every time.
 *
 * The second is the corpus. Nothing persisted a failing input, so a find became a hand-written test
 * or was lost, and the fuzzer was as likely to re-find it as it was the first time -- which is to
 * say, by luck. Replaying known-bad inputs before any generated one costs microseconds and makes a
 * regression impossible to miss.
 *
 * Failures are re-thrown with the minimal input, the original length, and a paste-ready corpus line.
 * The original error is kept as `cause`, so its own message and stack survive.
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
 * Pin a case's secondary randomness so shrinking replays the SAME case.
 *
 * A suite that also draws column indices, widths or flags per iteration cannot take them from the
 * generator's shared stream: every shrink attempt would advance it and check a different case than
 * the one that failed, which turns minimisation into a second search. Each case therefore gets its
 * own generator, rebuilt from a fixed per-case seed on every replay.
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
 * Delta-debug `input` down to the shortest string `check` still rejects.
 *
 * Halves first, so a long input collapses in a few passes rather than one code point at a time, then
 * single code points for the last few. Code points rather than UTF-16 units: splitting a surrogate
 * pair would invent an input the generator could not produce and send the reader after a lone
 * surrogate that was never there. Any throw counts as still-failing -- narrowing to the same message
 * sounds stricter but stalls whenever the assertion text quotes the input.
 */
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
