/**
 * Fuzz seeds vary between runs and replay exactly from the one line the run printed.
 *
 * WHY THIS SUITE EXISTS. Every hand-rolled fuzzer in this workspace hardcoded its seed, so each run
 * replayed the identical inputs. That is a large table-driven suite wearing a fuzzer's name: it
 * covers whatever the first run happened to cover and will never reach input 8,001, however many
 * times CI runs it. Mixing the call site's constant with a per-run nonce is what turns it back into
 * a fuzzer.
 *
 * The obvious objection is reproducibility, and these cases are mostly about answering it. The
 * nonce is printed once per process, setting `VEYYON_FUZZ_SEED` to it replays every suite in that
 * run, and `VEYYON_FUZZ_SEED=0` is the fully deterministic mode a bisect wants. A malformed value
 * throws rather than falling back to a random nonce, because silently ignoring the seed you were
 * handed reports "the bug is gone" after running different inputs than the ones being reproduced.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { FUZZ_SEED_ENV, fuzzSeed, lcg, resetFuzzSeedForTest } from "@veyyon/utils/adversarial-strings";

/** Run `body` with the seed environment set to `value`, or unset when it is undefined. */
function withSeedEnv<T>(value: string | undefined, body: () => T): T {
	const previous = process.env[FUZZ_SEED_ENV];
	if (value === undefined) delete process.env[FUZZ_SEED_ENV];
	else process.env[FUZZ_SEED_ENV] = value;
	resetFuzzSeedForTest();
	try {
		return body();
	} finally {
		if (previous === undefined) delete process.env[FUZZ_SEED_ENV];
		else process.env[FUZZ_SEED_ENV] = previous;
		resetFuzzSeedForTest();
	}
}

afterEach(() => {
	resetFuzzSeedForTest();
});

describe("fuzzSeed", () => {
	/**
	 * The deterministic mode returns the constant untouched, so a bisect runs exactly the inputs the
	 * suites ran before this mechanism existed.
	 */
	it("returns the call site's constant verbatim under seed 0", () => {
		withSeedEnv("0", () => {
			expect(fuzzSeed(0x9e37_79b9)).toBe(0x9e37_79b9);
			expect(fuzzSeed(0x0bad_f00d)).toBe(0x0bad_f00d);
		});
	});

	/** A pinned nonce reproduces its seeds exactly, which is what the printed line promises. */
	it("is a pure function of the nonce and the constant", () => {
		const first = withSeedEnv("0x1234abcd", () => fuzzSeed(0x9e37_79b9));
		const second = withSeedEnv("0x1234abcd", () => fuzzSeed(0x9e37_79b9));

		expect(first).toBe(second);
	});

	/** Accepts decimal as well as hex, since the printed form is hex but a script may pass either. */
	it("accepts a decimal nonce", () => {
		const hex = withSeedEnv("0x0000002a", () => fuzzSeed(0x1111_2222));
		const decimal = withSeedEnv("42", () => fuzzSeed(0x1111_2222));

		expect(decimal).toBe(hex);
	});

	/**
	 * Two call sites keep separate streams under every nonce, so one suite's seed can never collide
	 * with another's and quietly halve the surface the run explores.
	 */
	it("keeps different call sites on different streams", () => {
		withSeedEnv("0x1234abcd", () => {
			expect(fuzzSeed(0x9e37_79b9)).not.toBe(fuzzSeed(0x0bad_f00d));
		});
	});

	/**
	 * Adjacent nonces give unrelated seeds. Without the finalizer, a nonce one higher would seed the
	 * LCG one step over and consecutive runs would explore nearly the same inputs, which defeats the
	 * point of varying at all.
	 */
	it("turns adjacent nonces into unrelated streams", () => {
		const from = (nonce: string) =>
			withSeedEnv(nonce, () => {
				const rand = lcg(fuzzSeed(0x9e37_79b9));
				return [rand(), rand(), rand()];
			});

		const [a] = [from("100")];
		const [b] = [from("101")];

		expect(a).not.toEqual(b);
		// Not merely different: not close either. Adjacent LCG seeds produce first draws that differ
		// by a fixed small step, which this asserts against directly.
		expect(Math.abs((a[0] ?? 0) - (b[0] ?? 0))).toBeGreaterThan(0.001);
	});

	/**
	 * A malformed value is an error, never a silent fall back to a random nonce.
	 *
	 * The failure it prevents is specific: you paste the seed from a failing CI log, mistype it, and
	 * the run explores a different input set and reports success.
	 */
	it("refuses a malformed nonce instead of ignoring it", () => {
		for (const bad of ["0xdeadbeff_", "nonsense", "-1", "1.5", "0x1_0000_0000"]) {
			expect(() => withSeedEnv(bad, () => fuzzSeed(1))).toThrow(FUZZ_SEED_ENV);
		}
	});

	/** The boundary values are accepted, so a legitimate nonce is never rejected as out of range. */
	it("accepts the whole unsigned 32-bit range", () => {
		expect(() => withSeedEnv("0", () => fuzzSeed(1))).not.toThrow();
		expect(() => withSeedEnv("4294967295", () => fuzzSeed(1))).not.toThrow();
	});

	/** The nonce is resolved once per process, so every suite in a run shares it and replays together. */
	it("resolves the nonce once per process", () => {
		withSeedEnv(undefined, () => {
			const first = fuzzSeed(0x9e37_79b9);
			const second = fuzzSeed(0x9e37_79b9);

			expect(second).toBe(first);
		});
	});
});
