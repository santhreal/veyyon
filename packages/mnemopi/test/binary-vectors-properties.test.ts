/**
 * Algebraic properties of the binary-vector primitives, over generated embeddings.
 *
 * WHY THIS SUITE EXISTS. `binary-vectors.ts` is the bottom of the recall path: every recall
 * compares quantised vectors, and a defect here does not throw, it silently reorders results. The
 * existing table-driven cases pin specific vectors, which catches a broken implementation and
 * cannot catch a subtly wrong one -- the case that matters is the embedding nobody thought to write
 * down.
 *
 * `fast-check` was already declared by this package and imported by no file, so the dependency
 * asserted a coverage story the repository did not have. These are the properties it was declared
 * for, and they shrink: a failure reports a minimal counterexample embedding rather than a
 * thousand-dimension vector you then have to minimise by hand.
 *
 * The properties are the ones a similarity search actually depends on. A distance that is not
 * symmetric ranks A-against-B differently from B-against-A. A distance that can exceed the
 * dimension makes `informationTheoreticScore` negative and inverts a ranking. A binarisation that
 * is not a pure function of each component's sign means the same embedding lands in two different
 * buckets on two different days.
 */
import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
	BITS_PER_BYTE,
	EMBEDDING_DIM,
	hammingDistance,
	informationTheoreticScore,
	maximallyInformativeBinarization,
	quantizeInt8,
} from "../src/core/binary-vectors";

/** The house standard for property runs in this workspace. */
const RUNS = { numRuns: 10_000 };

/** Embedding components, including the values that break naive scaling. */
const component = fc.oneof(
	fc.double({ min: -1, max: 1, noNaN: true }),
	// Out-of-range and non-finite components reach these functions from a backend that returned
	// unnormalised output; they are clamped rather than rejected, so they belong in the generator.
	fc.double({ min: -1000, max: 1000, noNaN: false }),
	fc.constantFrom(0, -0, 1, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
);

/** An embedding of a plausible length, kept short so shrinking reports something readable. */
const embedding = fc.array(component, { minLength: 0, maxLength: 64 });

describe("quantizeInt8", () => {
	/**
	 * The output is a same-length Int8Array with every component in range. An out-of-range value
	 * would wrap through the typed array and turn a large positive component into a negative one,
	 * which reverses that dimension's contribution to every later dot product.
	 */
	it("preserves length and stays inside the signed-byte range", () => {
		fc.assert(
			fc.property(embedding, values => {
				const quantised = quantizeInt8(values);

				expect(quantised.length).toBe(values.length);
				for (const value of quantised) {
					expect(value).toBeGreaterThanOrEqual(-127);
					expect(value).toBeLessThanOrEqual(127);
				}
			}),
			RUNS,
		);
	});

	/**
	 * Quantisation is symmetric about zero: negating the embedding negates every quantised
	 * component exactly. An asymmetric rounding rule biases every vector in one direction, which
	 * shows up as a systematic ranking drift rather than as a wrong answer on any single case.
	 */
	it("is odd-symmetric, so negating the input negates the output", () => {
		fc.assert(
			fc.property(fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { maxLength: 64 }), values => {
				const positive = quantizeInt8(values);
				const negative = quantizeInt8(values.map(value => -value));

				for (let i = 0; i < values.length; i += 1) {
					// `0 - x` rather than `-x`: an Int8Array never stores -0, so negating a stored zero
					// gives -0 and `toBe` compares with Object.is. That is a property of the assertion,
					// not of the quantiser.
					expect(negative[i]).toBe(0 - (positive[i] as number));
				}
			}),
			RUNS,
		);
	});

	/**
	 * Order is preserved within a vector: a larger component never quantises below a smaller one.
	 * Similarity search is entirely about relative magnitude, so a rounding rule that inverts two
	 * neighbouring components changes which memory is recalled first.
	 */
	it("is monotonic, so a larger component never quantises lower", () => {
		fc.assert(
			fc.property(
				fc.double({ min: -1, max: 1, noNaN: true }),
				fc.double({ min: -1, max: 1, noNaN: true }),
				(left, right) => {
					const [lower, higher] = left <= right ? [left, right] : [right, left];
					const quantised = quantizeInt8([lower, higher]);

					expect(quantised[0] as number).toBeLessThanOrEqual(quantised[1] as number);
				},
			),
			RUNS,
		);
	});
});

describe("maximallyInformativeBinarization", () => {
	/**
	 * The byte count follows from the dimension alone, capped at `EMBEDDING_DIM`. A longer
	 * embedding producing a longer buffer would make `hammingDistance` count the overflow bits as
	 * differences against every stored vector.
	 */
	it("emits exactly the bytes the capped dimension needs", () => {
		fc.assert(
			fc.property(fc.array(component, { maxLength: EMBEDDING_DIM + 32 }), values => {
				const dim = Math.min(values.length, EMBEDDING_DIM);

				expect(maximallyInformativeBinarization(values).length).toBe(Math.ceil(dim / BITS_PER_BYTE));
			}),
			RUNS,
		);
	});

	/**
	 * Each bit is the sign of its component and nothing else -- strictly positive sets the bit, and
	 * zero, negative, NaN and both infinities-with-sign follow the same rule. Two embeddings that
	 * agree on every sign must binarise identically, or the same memory hashes into two buckets.
	 */
	it("depends only on each component's sign", () => {
		fc.assert(
			fc.property(embedding, values => {
				// Replace every component with a different value of the same sign class.
				const rescaled = values.map(value =>
					Number.isFinite(value) && value > 0 ? 0.5 : value > 0 ? value : -0.5,
				);

				expect(Array.from(maximallyInformativeBinarization(rescaled))).toEqual(
					Array.from(maximallyInformativeBinarization(values)),
				);
			}),
			RUNS,
		);
	});
});

describe("hammingDistance", () => {
	/**
	 * A metric, not a heuristic: symmetric, zero exactly on equal inputs, and bounded by the bits
	 * present. Asymmetry alone would make a ranking depend on argument order, which is invisible in
	 * any single-vector test.
	 */
	it("is symmetric, zero on identical vectors, and bounded by the bit count", () => {
		fc.assert(
			fc.property(embedding, embedding, (left, right) => {
				const a = maximallyInformativeBinarization(left);
				const b = maximallyInformativeBinarization(right);

				expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
				expect(hammingDistance(a, a)).toBe(0);
				expect(hammingDistance(a, b)).toBeGreaterThanOrEqual(0);
				expect(hammingDistance(a, b)).toBeLessThanOrEqual(Math.max(a.length, b.length) * BITS_PER_BYTE);
			}),
			RUNS,
		);
	});

	/**
	 * The triangle inequality. It is what lets a caller reason that a memory close to the query and
	 * close to another memory bounds the distance between those memories, which is the assumption
	 * behind every pruning step in the search.
	 */
	it("satisfies the triangle inequality", () => {
		fc.assert(
			fc.property(embedding, embedding, embedding, (first, second, third) => {
				const a = maximallyInformativeBinarization(first);
				const b = maximallyInformativeBinarization(second);
				const c = maximallyInformativeBinarization(third);

				expect(hammingDistance(a, c)).toBeLessThanOrEqual(hammingDistance(a, b) + hammingDistance(b, c));
			}),
			RUNS,
		);
	});

	/**
	 * Length mismatch counts the unpaired bytes rather than ignoring them. Truncating to the shorter
	 * vector would report distance 0 between a vector and its own prefix, which ranks a truncated
	 * embedding as a perfect match for everything it starts with.
	 */
	it("counts the bits of the longer vector's tail", () => {
		fc.assert(
			fc.property(fc.uint8Array({ minLength: 1, maxLength: 16 }), fc.uint8Array({ maxLength: 16 }), (head, tail) => {
				const combined = new Uint8Array([...head, ...tail]);
				const tailBits = Array.from(tail).reduce((sum, byte) => sum + byte.toString(2).replace(/0/g, "").length, 0);

				expect(hammingDistance(head, combined)).toBe(tailBits);
			}),
			RUNS,
		);
	});
});

describe("informationTheoreticScore", () => {
	/**
	 * The score is a decreasing affine function of distance, in `[0, 1]` for any distance the
	 * metric can actually produce. A score outside that range would sort ahead of an exact match.
	 */
	it("maps a valid distance to a decreasing score in [0, 1]", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 4096 }), dim => {
				expect(informationTheoreticScore(0, dim)).toBe(1);
				expect(informationTheoreticScore(dim, dim)).toBe(0);

				for (const distance of [1, Math.floor(dim / 2), dim - 1]) {
					const score = informationTheoreticScore(distance, dim);
					expect(score).toBeGreaterThanOrEqual(0);
					expect(score).toBeLessThanOrEqual(1);
					expect(score).toBeLessThan(informationTheoreticScore(distance - 1, dim));
				}
			}),
			RUNS,
		);
	});

	/**
	 * A non-positive dimension scores 0 rather than dividing by zero. `Infinity` or `NaN` here would
	 * propagate into the ranking and sort an empty vector to the top of every result list.
	 */
	it("returns zero for a non-positive dimension instead of dividing by it", () => {
		fc.assert(
			fc.property(fc.integer({ min: -1000, max: 0 }), fc.integer({ min: 0, max: 4096 }), (dim, distance) => {
				expect(informationTheoreticScore(distance, dim)).toBe(0);
			}),
			RUNS,
		);
	});
});
