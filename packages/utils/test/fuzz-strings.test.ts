/**
 * A failing fuzz input is reported minimal, and a past failure is replayed before any new one.
 *
 * WHY THIS SUITE EXISTS. The workspace's ten hand-rolled fuzzers each wrote their own loop over
 * `buildString`, which left two gaps that more iterations cannot close.
 *
 * Shrinking is the first. A generated input is up to 24 fragments of lone surrogates, truncated CSI
 * sequences and ZWJ clusters, and one of them is the bug. Reporting the whole string means the first
 * job after every find is to minimise it by hand, and a reader looking at a 300-character failure
 * cannot tell which fragment matters.
 *
 * The corpus is the second, and the more valuable. Nothing persisted a failing input, so a find
 * became a hand-written test or was lost, and the fuzzer was as likely to re-find it as it was the
 * first time. These cases pin the contract that makes a corpus worth keeping: entries run FIRST, run
 * under every seed including the deterministic one, and are reported verbatim rather than shrunk to
 * some other string than the one checked in.
 *
 * The surrogate case is not a detail. Shrinking over UTF-16 units would invent inputs the generator
 * cannot produce and send a reader chasing a lone surrogate that was never in the failing string.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { FUZZ_SEED_ENV, fuzzStrings, resetFuzzSeedForTest } from "@veyyon/utils/adversarial-strings";

/** Run `body` with the seed pinned, so every case here explores a fixed input set. */
function withSeed<T>(value: string, body: () => T): T {
	const previous = process.env[FUZZ_SEED_ENV];
	process.env[FUZZ_SEED_ENV] = value;
	resetFuzzSeedForTest();
	try {
		return body();
	} finally {
		if (previous === undefined) delete process.env[FUZZ_SEED_ENV];
		else process.env[FUZZ_SEED_ENV] = previous;
		resetFuzzSeedForTest();
	}
}

/** The error `fuzzStrings` threw, or a failure if it did not throw at all. */
function failureFrom(run: () => void): Error {
	try {
		run();
	} catch (error) {
		return error as Error;
	}
	throw new Error("fuzzStrings did not report a failure");
}

afterEach(() => {
	resetFuzzSeedForTest();
});

describe("fuzzStrings", () => {
	/** The whole point of a corpus: known-bad inputs are checked before any new exploration. */
	it("runs every corpus entry before the first generated input", () => {
		const seen: string[] = [];

		withSeed("0x1234abcd", () => {
			fuzzStrings({ seed: 0x9e37_79b9, iterations: 3, corpus: ["first", "second"] }, input => {
				seen.push(input);
			});
		});

		expect(seen.slice(0, 2)).toEqual(["first", "second"]);
		expect(seen).toHaveLength(5);
	});

	/** A corpus is dead weight if the deterministic mode skips it, which is the mode a bisect uses. */
	it("runs the corpus under the deterministic seed too", () => {
		const seen: string[] = [];

		withSeed("0", () => {
			fuzzStrings({ seed: 0x9e37_79b9, iterations: 0, corpus: ["pinned"] }, input => {
				seen.push(input);
			});
		});

		expect(seen).toEqual(["pinned"]);
	});

	/** The iteration count is the contract a suite writes down; drawing one fewer would go unnoticed. */
	it("draws exactly the requested number of generated inputs", () => {
		let calls = 0;

		withSeed("0x1234abcd", () => {
			fuzzStrings({ seed: 0x0bad_f00d, iterations: 250 }, () => {
				calls++;
			});
		});

		expect(calls).toBe(250);
	});

	/**
	 * The headline behaviour. A long generated string containing one bad code point must be reported
	 * as that code point, not as the string it arrived in.
	 */
	it("shrinks a generated failure to the single offending code point", () => {
		const failure = withSeed("0x1234abcd", () =>
			failureFrom(() => {
				fuzzStrings({ seed: 0x9e37_79b9, iterations: 4000 }, input => {
					if (input.includes("\x00")) throw new Error("NUL reached the parser");
				});
			}),
		);

		expect(failure.message).toContain("generated input failed (shrunk from ");
		expect(failure.message).toContain('"\\u0000"');
		// The minimal input is the NUL alone. Anything longer means shrinking stopped early and the
		// reader is back to guessing which fragment mattered.
		expect(failure.message).toContain('corpus entry: "\\u0000"');
	});

	/**
	 * Shrinking walks code points, never UTF-16 units. Splitting the emoji would report a lone
	 * surrogate the generator never produced, which is a different bug than the one that fired.
	 */
	it("never splits a surrogate pair while shrinking", () => {
		const failure = withSeed("0x1234abcd", () =>
			failureFrom(() => {
				fuzzStrings({ seed: 0x9e37_79b9, iterations: 4000 }, input => {
					if (input.includes("\u{1f600}")) throw new Error("astral code point reached the parser");
				});
			}),
		);

		// Two code units, one code point: the pair arrived and left intact.
		expect(failure.message).toContain("shrunk from ");
		expect(failure.message).toContain(' to 2 code units): "\u{1f600}"');
		expect(failure.message).toContain('corpus entry: "\u{1f600}"');
	});

	/**
	 * A corpus entry is already minimal, and shrinking it would name a string other than the one
	 * checked in -- which reads as a second, unrelated regression.
	 */
	it("reports a corpus failure verbatim rather than shrinking it", () => {
		const failure = withSeed("0x1234abcd", () =>
			failureFrom(() => {
				fuzzStrings({ seed: 0x9e37_79b9, iterations: 0, corpus: ["\x1b]66;s=2;\udfff"] }, input => {
					if (input.includes("\x1b")) throw new Error("escape reached the parser");
				});
			}),
		);

		expect(failure.message).toContain("corpus entry failed");
		expect(failure.message).toContain('corpus entry: "\\u001b]66;s=2;\\udfff"');
	});

	/** The original assertion carries the real diagnosis; wrapping must not swallow it. */
	it("keeps the original error as the cause", () => {
		const original = new Error("expected 3 rows, received 0");

		const failure = withSeed("0x1234abcd", () =>
			failureFrom(() => {
				fuzzStrings({ seed: 0x9e37_79b9, iterations: 1, corpus: ["x"] }, () => {
					throw original;
				});
			}),
		);

		expect(failure.cause).toBe(original);
	});

	/** Without the replay line, a CI failure names an input but not the run that produced it. */
	it("names the seed that replays the failing run", () => {
		const failure = withSeed("0x1234abcd", () =>
			failureFrom(() => {
				fuzzStrings({ seed: 0x9e37_79b9, iterations: 1, corpus: ["boom"] }, () => {
					throw new Error("boom");
				});
			}),
		);

		expect(failure.message).toContain(`${FUZZ_SEED_ENV}=0x1234abcd`);
	});

	/**
	 * A suite whose invariant only holds over a narrower alphabet supplies its own builder, and still
	 * gets shrinking and the corpus. Without this the width-math, stdin and key fuzzers could not
	 * migrate at all, and keeping their own loops is how they came to lack both.
	 */
	it("draws from a supplied builder instead of the shared pool", () => {
		const seen: string[] = [];

		withSeed("0x1234abcd", () => {
			fuzzStrings(
				{ seed: 0x9e37_79b9, iterations: 20, build: rand => "ab".repeat(1 + Math.floor(rand() * 3)) },
				input => {
					seen.push(input);
				},
			);
		});

		expect(seen).toHaveLength(20);
		expect(seen.every(input => /^(ab)+$/.test(input))).toBe(true);
		// More than one length, or the builder's randomness is not reaching it.
		expect(new Set(seen).size).toBeGreaterThan(1);
	});

	/** Shrinking works over a custom alphabet too: the reported input stays one the builder can make. */
	it("shrinks an input from a supplied builder", () => {
		const failure = withSeed("0x1234abcd", () =>
			failureFrom(() => {
				fuzzStrings({ seed: 0x9e37_79b9, iterations: 200, build: () => "aaaaXaaaa" }, input => {
					if (input.includes("X")) throw new Error("X reached the parser");
				});
			}),
		);

		expect(failure.message).toContain('corpus entry: "X"');
	});
});
