/**
 * WHY THIS SUITE EXISTS. `bestEffort` and `optionalResult` are one mechanism with two contracts, and
 * the contract is the whole reason both exist: one says the failure ends the story, the other says
 * the failure IS the answer. A refactor that collapses them, or that routes either through
 * `reportFault`, turns a deliberate silence into either a lost answer or a stream of noise about
 * teardown steps nobody was waiting on. These arms pin the difference.
 *
 * WHAT THIS DOES NOT CATCH: whether a given call site chose the right one of the two. That is a
 * reading of the site, not a property of the helpers.
 */
import { describe, expect, it } from "bun:test";
import { bestEffort, optionalResult } from "@veyyon/utils/discarded-fault";
import { attachFaultSink, type Fault } from "@veyyon/utils/fault-sink";

/** Collect everything reported while `run` executes, so "reports nothing" is an observation. */
async function faultsDuring(run: () => Promise<unknown>): Promise<Fault[]> {
	const seen: Fault[] = [];
	const detach = attachFaultSink(fault => {
		seen.push(fault);
	});
	try {
		await run();
	} finally {
		detach();
	}
	return seen;
}

describe("a step nobody waits on", () => {
	it("resolves rather than rejecting when the step fails", async () => {
		const outcome = await bestEffort(Promise.reject(new Error("target already gone")), "why");
		expect(outcome).toBeUndefined();
	});

	it("resolves to nothing even when the step produced a value", async () => {
		// The `void` return is the contract: a caller that stopped waiting cannot read an answer.
		expect(await bestEffort(Promise.resolve("a value"), "why")).toBeUndefined();
	});

	it("reports nothing, because a discarded fault is not an operator's problem", async () => {
		const faults = await faultsDuring(() => bestEffort(Promise.reject(new Error("noise")), "why"));
		expect(faults).toEqual([]);
	});

	it("does not swallow a synchronous throw from building the step", async () => {
		// A caller that cannot even construct the promise has a defect, not a best-effort step.
		const build = (): Promise<void> => {
			throw new Error("constructing the step failed");
		};
		expect(() => bestEffort(build(), "why")).toThrow("constructing the step failed");
	});
});

describe("a probe whose failure is the answer", () => {
	it("answers the value when the probe succeeds", async () => {
		expect(await optionalResult(Promise.resolve("a title"), "why")).toBe("a title");
	});

	it("answers undefined when the probe fails", async () => {
		expect(await optionalResult(Promise.reject(new Error("mid-navigation")), "why")).toBeUndefined();
	});

	it("keeps a falsy answer instead of turning it into absence", async () => {
		// `undefined` means "no answer". An empty string, a zero and a false ARE answers, and a helper
		// that flattened them would make a caller read absence where there was a value.
		expect(await optionalResult(Promise.resolve(""), "why")).toBe("");
		expect(await optionalResult(Promise.resolve(0), "why")).toBe(0);
		expect(await optionalResult(Promise.resolve(false), "why")).toBe(false);
	});

	it("reports nothing", async () => {
		const faults = await faultsDuring(() => optionalResult(Promise.reject(new Error("noise")), "why"));
		expect(faults).toEqual([]);
	});
});
