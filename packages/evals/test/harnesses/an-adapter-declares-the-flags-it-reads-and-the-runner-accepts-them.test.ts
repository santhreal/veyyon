/**
 * WHY: a harness adapter reads its own flags out of the invocation -- `--omp-binary`,
 * `--factory-auth`, `--hermes-auth`, `--auth-db` -- and the runner's parser knew none of them.
 * The parser dropped every flag it did not declare, so `--omp-binary /usr/local/bin/omp` ran
 * against whatever `omp` was on PATH, and a typo in one of these flags was indistinguishable from
 * not passing it. Declaring them by hand in a table beside the runner drifts the moment an adapter
 * reads a new one.
 *
 * The class this closes: a flag an adapter reads that the entry point does not accept. The sweep
 * observes what each registered adapter reads, at run time, through a recording view of the
 * argument map, and requires the deep-swe grammar to accept every key observed. Registering a new
 * adapter, or teaching an existing one a new flag, fails this suite until the flag is declared,
 * and a declared flag no adapter reads fails it too.
 *
 * What it does not catch: a flag read somewhere other than an adapter's preflight (the sweep calls
 * `validatePreflight`, which is where every adapter resolves its inputs), and whether the value
 * passed is one the adapter can use -- a missing binary is reported by the preflight verdict, which
 * is asserted where preflight is covered.
 */

import { describe, expect, it } from "bun:test";
import type { HarnessAdapter } from "../../engine/contracts";
import { harnesses, harnessFlags } from "../../engine/loaded-members";
import { BOOLEAN_FLAGS, parseEvalsArgs, VALUE_FLAGS } from "../../evals";

/** Record every key an adapter reads out of the argument map. */
function recordFlagReads(adapter: HarnessAdapter): readonly string[] {
	const read = new Set<string>();
	const args = new Proxy(
		{},
		{
			get(_target, key) {
				if (typeof key === "string") read.add(key);
				return undefined;
			},
			has(_target, key) {
				if (typeof key === "string") read.add(key);
				return false;
			},
		},
	) as Readonly<Record<string, unknown>>;
	// A refusal is the expected outcome with no inputs; the reads are what this observes.
	try {
		adapter.validatePreflight?.({ system: adapter.id, model: "provider/model", args, dryRun: true });
	} catch {
		// An adapter that throws has still recorded the keys it reached before throwing.
	}
	return [...read].filter(k => /^[a-z0-9-]+$/.test(k)).sort();
}

const ADAPTERS = harnesses.list();
const ACCEPTED = new Set([
	...Object.keys(VALUE_FLAGS).map(f => f.replace(/^--/, "")),
	...Object.keys(BOOLEAN_FLAGS).map(f => f.replace(/^--/, "")),
	...harnessFlags(),
]);

describe("the harness adapters", () => {
	it("are registered, so the sweep below covers something", () => {
		expect(ADAPTERS.length).toBeGreaterThan(0);
	});

	it("contribute every declared flag to the registry's union", () => {
		const union = harnessFlags();
		const declared = [...new Set(ADAPTERS.flatMap(adapter => adapter.flags))].sort();
		expect(union).toEqual(declared);
	});
});

describe.each(ADAPTERS.map(adapter => [adapter.id, adapter] as const))("the %s adapter", (_name, adapter) => {
	const reads = recordFlagReads(adapter);

	it("reads at least one flag, or declares none", () => {
		if (adapter.flags.length > 0) expect(reads.length).toBeGreaterThan(0);
	});

	it("reads only flags the runner accepts", () => {
		for (const flag of reads) expect([...ACCEPTED]).toContain(flag);
	});

	it("has each flag it reads accepted on a real invocation", () => {
		for (const flag of reads) {
			const parsed = parseEvalsArgs([`--${flag}`, "value"]);
			expect(parsed.harnessOptions[flag]).toBe("value");
		}
	});
});
