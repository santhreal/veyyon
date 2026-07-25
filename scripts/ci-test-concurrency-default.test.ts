import { afterEach, describe, expect, it } from "bun:test";
import { testConcurrency } from "./ci-test-ts";

/**
 * How many test chunks run at once.
 *
 * This has a test because the previous default, one chunk per available core,
 * made a full local run drive the load average past 80 on a many-core
 * workstation and left the machine unusable. Each chunk is a `bun test` process
 * that spawns children of its own, so the real process count is a multiple of the
 * chunk count. Someone running the suite is usually still working on that same
 * machine, so sequential is the correct default and fanout is an explicit choice.
 */
describe("local test concurrency", () => {
	const original = Bun.env.VEYYON_TEST_CONCURRENCY;

	afterEach(() => {
		if (original === undefined) delete Bun.env.VEYYON_TEST_CONCURRENCY;
		else Bun.env.VEYYON_TEST_CONCURRENCY = original;
	});

	it("runs one chunk at a time by default, however many chunks there are", () => {
		delete Bun.env.VEYYON_TEST_CONCURRENCY;
		// Asserted at several sizes: the default must not scale with the workload, which
		// is exactly how the machine got saturated.
		expect(testConcurrency(1)).toBe(1);
		expect(testConcurrency(96)).toBe(1);
		expect(testConcurrency(1000)).toBe(1);
	});

	it("honors an explicit numeric opt-in, capped at the number of chunks", () => {
		Bun.env.VEYYON_TEST_CONCURRENCY = "4";
		expect(testConcurrency(96)).toBe(4);
		// Never more workers than there is work.
		expect(testConcurrency(2)).toBe(2);
	});

	it("treats `all` and `max` as full fanout, for a dedicated test box", () => {
		Bun.env.VEYYON_TEST_CONCURRENCY = "all";
		expect(testConcurrency(96)).toBe(96);
		Bun.env.VEYYON_TEST_CONCURRENCY = "max";
		expect(testConcurrency(12)).toBe(12);
	});

	it("falls back to sequential when the override is not a usable number", () => {
		// A typo must degrade to the safe value, never to unbounded fanout.
		for (const bad of ["", "abc", "0", "-3"]) {
			Bun.env.VEYYON_TEST_CONCURRENCY = bad;
			expect({ bad, workers: testConcurrency(96) }).toEqual({ bad, workers: 1 });
		}
	});
});
