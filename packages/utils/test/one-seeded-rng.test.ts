/**
 * There is one seeded RNG for the fuzz suites, and new copies cannot appear.
 *
 * WHY THIS SUITE EXISTS (FUZZ-LCG-IS-DUPLICATED-BYTE-FOR-BYTE). `lcg` was
 * defined twice, byte for byte: same multiplier 1664525, same increment
 * 1013904223, same `>>> 0`, same `/ 0x1_0000_0000`. One copy was exported from
 * `packages/tui/test/helpers/`, which nine suites imported by relative path; the
 * other was inlined in the coding-agent highlighter fuzzer with a comment saying
 * there was nothing to import -- which was true, because a test directory is not
 * an API.
 *
 * A duplicated seeded RNG is the worst kind of copy. Two byte-identical
 * generators look harmless right up until one is tuned, and from that moment
 * "reproduce with seed 42" means two different streams in two suites, with
 * nothing anywhere reporting the divergence. So the generator moved to
 * `@veyyon/utils`, a dependency every package already has, and this suite makes
 * a third copy fail the build instead of merely being noticed by whoever greps
 * next.
 *
 * TWO FORMS, ONE RECURRENCE. The copies were not quite identical, which is the
 * drift this suite exists to stop: `packages/utils` and `packages/mnemopi`
 * returned a fraction in `[0, 1)`, while the ~134 `packages/hashline/test/`
 * seed-shard suites returned the raw `uint32` state. Both are wanted -- integer
 * draws are cheaper for `% n` indexing -- so {@link lcgUint32} owns the
 * recurrence and {@link lcg} is that function normalized. Neither can drift from
 * the other, because there is only one `s = (s * 1664525 + 1013904223) >>> 0` in
 * the workspace and both forms read it.
 *
 * There is no baseline. There was one while the hashline shards still inlined
 * their copies; they no longer do, so the gate is flat and every future copy
 * fails here with its own path in the message.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { lcg, lcgUint32 } from "@veyyon/utils/adversarial-strings";
import { Glob } from "bun";

/** Repo root, from this file's location (`packages/utils/test/`). */
const ROOT = path.resolve(import.meta.dir, "../../..");

/** Either form, by name, so a copy of the integer variant is caught too. */
const DEFINITION = /(?:^|\n)\s*(?:export\s+)?function\s+lcg(?:Uint32)?\s*\(/;

async function filesDefiningLcg(): Promise<string[]> {
	const found: string[] = [];
	for await (const file of new Glob("packages/*/{src,test}/**/*.ts").scan({ cwd: ROOT })) {
		const text = await Bun.file(path.join(ROOT, file)).text();
		if (DEFINITION.test(text)) found.push(file);
	}
	return found.sort();
}

describe("one seeded RNG for the whole workspace", () => {
	/**
	 * The headline: exactly one file in the workspace defines either form, and it
	 * is the shared one. A new inline copy anywhere fails here with its own path in
	 * the message, which is the only way this stays true as packages are added.
	 */
	it("defines the generator in exactly one file in the workspace", async () => {
		expect(await filesDefiningLcg()).toEqual(["packages/utils/src/adversarial-strings.ts"]);
	});

	/**
	 * And the shared generator is the one the copies were: same constants, so a
	 * suite that switched to the import reproduces the exact stream it did before.
	 * Asserted as concrete first draws rather than by restating the recurrence,
	 * which would just be the implementation written twice.
	 */
	it("produces the stream the inlined copies produced", () => {
		const rand = lcg(42);
		const first = [rand(), rand(), rand()];

		// Recomputed by hand from seed 42: s = (s * 1664525 + 1013904223) >>> 0.
		const expected = [1083814273, 378494188, 2479403867].map(value => value / 0x1_0000_0000);
		expect(first).toEqual(expected);
	});

	/** Same seed, same stream, every time. That is the entire contract. */
	it("is deterministic across independent generators", () => {
		const a = lcg(7);
		const b = lcg(7);
		expect([a(), a(), a(), a()]).toEqual([b(), b(), b(), b()]);
		expect(lcg(7)()).not.toBe(lcg(8)());
	});

	/** Every draw is a fraction in [0, 1), which is what every caller assumes. */
	it("stays in the unit interval", () => {
		const rand = lcg(123456);
		for (let i = 0; i < 5_000; i++) {
			const value = rand();
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
		}
	});

	/**
	 * The integer form is the stream the 134 hashline seed shards inlined before
	 * they imported it. Those shards address `% n` off the raw state, so a change
	 * to what {@link lcgUint32} returns silently rewrites which operations 134
	 * suites perform -- the failures would still be failures, just not the ones the
	 * seeds name. Pinned as concrete states, from the same seed the fraction test
	 * uses, so the two are visibly the same walk.
	 */
	it("draws the raw uint32 states the hashline shards were built on", () => {
		const next = lcgUint32(42);
		expect([next(), next(), next()]).toEqual([1083814273, 378494188, 2479403867]);
	});

	/**
	 * And the two forms are one recurrence, not two implementations that happen to
	 * agree today. This is the assertion that would fail if someone re-inlined a
	 * second copy inside `lcg` instead of normalizing the shared one, which is
	 * exactly the drift the file-count test above cannot see.
	 */
	it("normalizes the same states rather than running a second recurrence", () => {
		const ints = lcgUint32(2026);
		const fracs = lcg(2026);
		for (let i = 0; i < 1_000; i++) {
			expect(fracs()).toBe(ints() / 0x1_0000_0000);
		}
	});

	/** The integer form stays a uint32: no sign flip, no float, no overflow past 2^32. */
	it("keeps every integer draw a uint32", () => {
		const next = lcgUint32(0xdeadbeef);
		for (let i = 0; i < 5_000; i++) {
			const value = next();
			expect(Number.isInteger(value)).toBe(true);
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(0x1_0000_0000);
		}
	});

	/**
	 * A negative or out-of-range seed is normalized rather than producing a
	 * different walk from its `>>> 0` equivalent. The hashline shards wrote
	 * `let s = seed` with no normalization and the other copies wrote `seed >>> 0`;
	 * unifying them made that difference observable, so it is pinned instead of
	 * left to chance.
	 */
	it("normalizes the seed the way every copy's first multiply did", () => {
		expect(lcgUint32(-1)()).toBe(lcgUint32(0xffff_ffff)());
		expect(lcgUint32(0x1_0000_0007)()).toBe(lcgUint32(7)());
	});
});
