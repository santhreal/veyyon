import { describe, expect, test } from "bun:test";
import { armCanaryFailure, shouldTripCanary } from "./aggregate";

/**
 * The per-arm fail-fast canary, and the blind spot it exists to close.
 *
 * `shouldTripCanary` aborts only when EVERY completed trial is a hard error. On
 * a multi-arm run that is the wrong shape of question. The queue is arm-major,
 * arms run concurrently, and a single success anywhere disarms the global
 * predicate permanently. So an arm that is 100% dead beside a healthy control
 * never trips it: the run burns the full queue, roughly two hours of container
 * setup, and then prints a comparison against an arm that produced nothing at
 * all.
 *
 * That is not a hypothetical. It is the argot failure already seen once, where
 * an encode arm degraded silently while its control ran clean, and the report
 * read as a real measurement.
 *
 * The two predicates are complementary and both are kept. The global one trips
 * sooner when the first wave spans arms and nothing works at all; this one sees
 * the case the global one structurally cannot. Every test below that asserts a
 * per-arm trip also asserts that the global predicate does NOT fire on the same
 * data, because that contrast IS the bug.
 */
describe("armCanaryFailure — a single dead arm aborts the run", () => {
	const hard = (arm: string, error = 'Model "x" not found') => ({ arm, error, outputTokens: null });
	const good = (arm: string) => ({ arm, error: null, outputTokens: 800 });

	/**
	 * The core case, and the exact scenario the global predicate misses. The
	 * control arm is fine, the treatment arm is dead, and only the per-arm check
	 * can tell.
	 */
	test("trips on a dead arm running beside a healthy one, and names it", () => {
		const results = [good("decode"), hard("full"), good("decode"), hard("full")];

		expect(armCanaryFailure(results, 2)).toBe("full");
		// The contrast that makes this suite worth having: the old predicate is
		// silent on the same data, which is why the run used to continue.
		expect(shouldTripCanary(results, 2)).toBe(false);
	});

	/**
	 * The arm NAME has to come back, not just a boolean. "Some arm is broken"
	 * sends the operator reading the wrong config, on a run with five arms.
	 */
	test("names the dead arm rather than reporting that one exists", () => {
		const results = [good("a"), good("b"), hard("c"), hard("c"), hard("c")];

		expect(armCanaryFailure(results, 3)).toBe("c");
	});

	/**
	 * The false-positive guard, mirroring the global predicate's. A single
	 * success inside an arm proves that arm's config works, so its failures are
	 * task flakiness and the run must continue.
	 */
	test("does not trip on an arm that produced any output at all", () => {
		const results = [hard("full"), hard("full"), good("full"), hard("full")];

		expect(armCanaryFailure(results, 3)).toBeUndefined();
	});

	/**
	 * The window has to be full for that arm specifically. Aborting on the first
	 * one or two errors would kill runs over an unlucky start, which is the
	 * failure mode that makes people disable a canary entirely.
	 */
	test("does not trip before the arm has completed a full window", () => {
		expect(armCanaryFailure([hard("full"), hard("full")], 3)).toBeUndefined();
		expect(armCanaryFailure([hard("full"), hard("full"), hard("full")], 3)).toBe("full");
	});

	/**
	 * The counts are per arm, not global. Two arms with two errors each must not
	 * add up to a four-error window and trip a canary sized for four.
	 */
	test("counts each arm's window separately rather than pooling them", () => {
		const results = [hard("a"), hard("b"), hard("a"), hard("b")];

		expect(armCanaryFailure(results, 4)).toBeUndefined();
		expect(armCanaryFailure(results, 2)).toBe("a");
	});

	/**
	 * The specific regression, stated on its own. A success EARLY in the run
	 * disarms the global predicate for good; the per-arm one must be unaffected,
	 * because that success says nothing about a different arm.
	 */
	test("stays armed after an early success has permanently disarmed the global check", () => {
		const results = [good("decode"), hard("full"), hard("full"), hard("full"), hard("full")];

		expect(shouldTripCanary(results, 4)).toBe(false);
		expect(armCanaryFailure(results, 4)).toBe("full");
	});

	/** Nothing has run, so there is nothing to conclude. */
	test("an empty result set never trips", () => {
		expect(armCanaryFailure([], 4)).toBeUndefined();
	});

	/**
	 * A run where every arm is healthy stays silent. Without this the suite would
	 * pass against an implementation that returned the first arm it saw.
	 */
	test("says nothing when every arm is producing output", () => {
		expect(armCanaryFailure([good("a"), good("b"), good("a"), good("b")], 2)).toBeUndefined();
	});

	/**
	 * A window of one is the single-item-queue case, where the first hard error
	 * for an arm is already a full window.
	 */
	test("with a window of one, an arm's first hard error trips", () => {
		expect(armCanaryFailure([hard("full")], 1)).toBe("full");
		expect(armCanaryFailure([good("full")], 1)).toBeUndefined();
	});

	/**
	 * A non-positive window would otherwise make `total >= canarySize` true for
	 * every arm and abort the run before anything had finished.
	 */
	test("a window of zero or less never trips", () => {
		expect(armCanaryFailure([hard("full")], 0)).toBeUndefined();
		expect(armCanaryFailure([hard("full")], -1)).toBeUndefined();
	});

	/**
	 * Determinism. With two dead arms the result must be stable across calls, so
	 * the abort message does not change between identical runs and so the
	 * operator fixes the arm the message named.
	 */
	test("returns the same arm every time when more than one is dead", () => {
		const results = [hard("a"), hard("b"), hard("a"), hard("b")];

		const first = armCanaryFailure(results, 2);
		expect(first).toBe("a");
		expect(armCanaryFailure(results, 2)).toBe(first);
		expect(armCanaryFailure([...results], 2)).toBe(first);
	});

	/**
	 * A scored fail is data, not a config failure: the agent ran and produced
	 * output, it just did not solve the task. An arm of those must never trip,
	 * or a genuinely hard task set reads as a broken arm.
	 */
	test("does not trip on an arm that keeps failing tasks while producing output", () => {
		const scoredFail = { arm: "full", error: null, outputTokens: 1200 };

		expect(armCanaryFailure([scoredFail, scoredFail, scoredFail], 3)).toBeUndefined();
	});

	/**
	 * An error WITH output is a partial or timed-out run, which reflects the task
	 * or the arm's behaviour rather than a config that never started. `isHardError`
	 * is the one owner of that distinction and this arm must survive.
	 */
	test("does not trip on errors that still produced tokens", () => {
		const partial = { arm: "full", error: "timed out", outputTokens: 400 };

		expect(armCanaryFailure([partial, partial, partial], 3)).toBeUndefined();
	});
});
