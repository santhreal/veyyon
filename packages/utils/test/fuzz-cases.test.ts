/**
 * `fuzzCases`: the fuzz driver for a case that is a structure rather than a string.
 *
 * WHY THIS SUITE EXISTS. `fuzzStrings` gave ten hand-written fuzzers a shrinker and a corpus, and
 * two suites could not take it because their unit under test needs a structure: a pasted stream
 * plus the marker offsets inside it plus a chunking, or a line plus the width it must fill.
 * Shrinking the string alone would report an input that no longer matches its own parameters. They
 * kept hand-written loops, which meant they kept the exact two gaps the driver exists to close.
 *
 * `fuzzCases` closes them by taking the search strategy and leaving the domain knowledge with the
 * caller: the caller says how to build a case and which simpler cases to try, the driver decides in
 * what order to try them and how to report the result. That split is what these cases pin. The
 * driver must run the corpus first and unshrunk, must minimise a generated failure through the
 * caller's candidates, must never revisit a candidate (so a `simplify` that returns its own input
 * cannot spin), must give every case its own reproducible secondary generator, and must report a
 * failure in the same shape the string driver does.
 */
import { describe, expect, it } from "bun:test";
import { fuzzCases } from "../src/adversarial-strings";

/** A deliberately structured case: two numbers that must be shrunk together. */
type Pair = { readonly left: number; readonly right: number };

/** Candidates, biggest reduction first: halve each side, then step it down by one. */
function simplifyPair(pair: Pair): Pair[] {
	const candidates: Pair[] = [];
	if (pair.left > 0) candidates.push({ ...pair, left: Math.floor(pair.left / 2) });
	if (pair.right > 0) candidates.push({ ...pair, right: Math.floor(pair.right / 2) });
	if (pair.left > 0) candidates.push({ ...pair, left: pair.left - 1 });
	if (pair.right > 0) candidates.push({ ...pair, right: pair.right - 1 });
	return candidates;
}

/** Build a pair from the run's stream, large enough that shrinking has real work to do. */
function buildPair(rand: () => number): Pair {
	return { left: Math.floor(rand() * 1000), right: Math.floor(rand() * 1000) };
}

describe("fuzzCases runs the corpus", () => {
	/**
	 * The corpus is replayed before any generated case. A regression that a fuzzer once found must
	 * fail on the first case checked, not after however many iterations it takes to rediscover it,
	 * which is to say by luck.
	 */
	it("checks every corpus case before generating any", () => {
		const seen: Pair[] = [];

		fuzzCases<Pair>(
			{
				seed: 1,
				iterations: 3,
				corpus: [
					{ left: 1, right: 2 },
					{ left: 3, right: 4 },
				],
				build: buildPair,
			},
			pair => {
				seen.push(pair);
			},
		);

		expect(seen.length).toBe(5);
		expect(seen.slice(0, 2)).toEqual([
			{ left: 1, right: 2 },
			{ left: 3, right: 4 },
		]);
	});

	/**
	 * A corpus case is reported EXACTLY as written, never shrunk. Shrinking it would name a
	 * different case than the one checked in, which reads as a second, unrelated bug.
	 */
	it("reports a failing corpus case unshrunk", () => {
		expect(() =>
			fuzzCases<Pair>(
				{
					seed: 1,
					iterations: 0,
					corpus: [{ left: 40, right: 2 }],
					build: buildPair,
					simplify: simplifyPair,
				},
				() => {
					throw new Error("always fails");
				},
			),
		).toThrow(/corpus case failed: \{"left":40,"right":2\}/);
	});

	/** Exactly the iterations asked for, so a suite's cost is the number in its own source. */
	it("generates exactly the requested number of cases", () => {
		let count = 0;

		fuzzCases<Pair>({ seed: 7, iterations: 250, build: buildPair }, () => {
			count += 1;
		});

		expect(count).toBe(250);
	});
});

describe("fuzzCases minimises a generated failure", () => {
	/**
	 * The whole point. The check rejects any pair whose left side is at least 8, so the minimum is
	 * exactly 8: the driver must walk the candidates down to it rather than reporting the
	 * three-digit pair the generator happened to produce.
	 */
	it("shrinks to the smallest case the check still rejects", () => {
		let reported: string | undefined;

		try {
			fuzzCases<Pair>({ seed: 3, iterations: 1_000, build: buildPair, simplify: simplifyPair }, pair => {
				if (pair.left >= 8) throw new Error("left too large");
			});
		} catch (error) {
			reported = (error as Error).message;
		}

		expect(reported).toBeDefined();
		expect(reported).toContain('"left":8');
		expect(reported).toContain("generated case failed (shrunk from");
	});

	/**
	 * Both fields shrink, not just the first one the candidate list mentions. A driver that stopped
	 * at the first field would report a case that is minimal in one dimension and arbitrary in the
	 * other, which is the failure mode that makes a "minimal" case untrustworthy.
	 */
	it("shrinks every dimension of the case, not only the first", () => {
		let reported: string | undefined;

		try {
			fuzzCases<Pair>({ seed: 11, iterations: 1_000, build: buildPair, simplify: simplifyPair }, pair => {
				if (pair.left >= 5 && pair.right >= 5) throw new Error("both too large");
			});
		} catch (error) {
			reported = (error as Error).message;
		}

		expect(reported).toContain('{"left":5,"right":5}');
	});

	/**
	 * With no `simplify`, the failure is reported as generated rather than silently swallowed. An
	 * unshrunk report is worse than a shrunk one and far better than a passing run.
	 */
	it("reports the generated case as-is when nothing simplifies it", () => {
		let reported: string | undefined;

		try {
			fuzzCases<Pair>({ seed: 5, iterations: 10, build: buildPair }, () => {
				throw new Error("always fails");
			});
		} catch (error) {
			reported = (error as Error).message;
		}

		expect(reported).toContain("generated case failed (did not shrink)");
	});

	/**
	 * A `simplify` that hands back the case it was given cannot spin the driver: already-tried
	 * candidates are remembered, so it runs out and stops. Without that, the most natural mistake a
	 * caller can make would hang the suite with no output at all.
	 */
	it("terminates when simplify returns the case it was given", () => {
		let reported: string | undefined;

		try {
			fuzzCases<Pair>({ seed: 5, iterations: 10, build: buildPair, simplify: pair => [pair, pair] }, () => {
				throw new Error("always fails");
			});
		} catch (error) {
			reported = (error as Error).message;
		}

		expect(reported).toContain("generated case failed");
	});

	/** And a `simplify` that cycles between two forms terminates for the same reason. */
	it("terminates when simplify cycles between two cases", () => {
		let reported: string | undefined;

		try {
			fuzzCases<Pair>(
				{
					seed: 5,
					iterations: 10,
					build: () => ({ left: 1, right: 2 }),
					simplify: pair => [{ left: pair.right, right: pair.left }],
				},
				() => {
					throw new Error("always fails");
				},
			);
		} catch (error) {
			reported = (error as Error).message;
		}

		expect(reported).toContain("generated case failed");
	});
});

describe("fuzzCases reports a failure the way fuzzStrings does", () => {
	/** The seed line, so a reader can replay the exact run rather than a different one. */
	it("names the seed that replays the run", () => {
		let reported: string | undefined;

		try {
			fuzzCases<Pair>({ seed: 5, iterations: 1, build: buildPair }, () => {
				throw new Error("boom");
			});
		} catch (error) {
			reported = (error as Error).message;
		}

		expect(reported).toContain("replay this run with VEYYON_FUZZ_SEED=0x");
	});

	/** The paste-ready corpus line, which is how a find becomes a permanent regression. */
	it("prints a corpus line for the minimal case", () => {
		let reported: string | undefined;

		try {
			fuzzCases<Pair>({ seed: 5, iterations: 100, build: buildPair, simplify: simplifyPair }, pair => {
				if (pair.left >= 4) throw new Error("boom");
			});
		} catch (error) {
			reported = (error as Error).message;
		}

		expect(reported).toContain('corpus entry: {"left":4');
	});

	/** The original error survives as `cause`, so its own message and stack are not lost. */
	it("keeps the original error as the cause", () => {
		const original = new Error("the real assertion message");
		let caught: unknown;

		try {
			fuzzCases<Pair>({ seed: 5, iterations: 1, build: buildPair }, () => {
				throw original;
			});
		} catch (error) {
			caught = error;
		}

		expect((caught as Error).cause).toBe(original);
	});

	/** `describe` names the case, for a structure whose JSON would be unreadable. */
	it("uses the caller's describe when one is given", () => {
		let reported: string | undefined;

		try {
			fuzzCases<Pair>(
				{
					seed: 5,
					iterations: 1,
					build: buildPair,
					describe: pair => `L${pair.left}`,
				},
				() => {
					throw new Error("boom");
				},
			);
		} catch (error) {
			reported = (error as Error).message;
		}

		expect(reported).toMatch(/generated case failed \(did not shrink\): L\d+/);
	});
});

describe("fuzzCases gives each case its own generator", () => {
	/**
	 * A check that draws its own randomness must get the SAME draws on every replay of a case, or
	 * shrinking searches a different case than the one that failed and minimisation becomes a
	 * second search. Pinned by replaying the same case through the driver twice and comparing.
	 */
	it("rebuilds a case's secondary randomness identically", () => {
		const runs: number[][] = [];

		for (let run = 0; run < 2; run++) {
			const draws: number[] = [];
			fuzzCases<Pair>({ seed: 21, iterations: 4, build: buildPair }, (_pair, rand) => {
				draws.push(rand(), rand());
			});
			runs.push(draws);
		}

		expect(runs[0]).toEqual(runs[1] as number[]);
	});

	/** Neighbouring cases get UNRELATED draws, so a suite cannot accidentally test one stream. */
	it("gives neighbouring cases different secondary draws", () => {
		const firstDraws: number[] = [];

		fuzzCases<Pair>({ seed: 21, iterations: 8, build: buildPair }, (_pair, rand) => {
			firstDraws.push(rand());
		});

		expect(new Set(firstDraws).size).toBe(firstDraws.length);
	});
});

describe("fuzzCases is quiet on success", () => {
	/** A passing run throws nothing, so a green suite stays green and silent. */
	it("returns normally when every case passes", () => {
		expect(() =>
			fuzzCases<Pair>({ seed: 99, iterations: 500, corpus: [{ left: 0, right: 0 }], build: buildPair }, () => {}),
		).not.toThrow();
	});
});
