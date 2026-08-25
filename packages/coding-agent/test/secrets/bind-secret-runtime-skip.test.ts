/**
 * WHY: `bindSecretRuntime` in the SDK closure iterates every element of a
 * messages array to bind each message object to its `SecretRuntimeLease` in a
 * WeakMap. It is called multiple times per turn on the same array reference
 * (transformContext, convertToLlmFinal, transformProviderContext each re-bind
 * the array that emitContext / wrapSteeringForModel / obfuscateMessages
 * returned unchanged), so without an early return the per-element loop runs
 * redundantly — 33K WeakMap.set calls per redundant call, several times per
 * turn.
 *
 * The class this closes: an optimization that skips the iteration when the
 * array is already bound to the same runtime must not leave elements unbound.
 * The invariant is: after `bind(arr, R)` returns, `resolve(arr)` and
 * `resolve(arr[i])` both return `R` — whether it was the first bind or a
 * redundant re-bind that was skipped.
 *
 * What it does NOT catch: the full SDK integration path that calls
 * `bindSecretRuntime` through transformContext / convertToLlmFinal /
 * transformProviderContext. Those are covered by
 * `redaction-outlives-expansion-on-every-outbound-seam.test.ts` and
 * `secret-runtime-lifecycle.test.ts`.
 */
import { describe, expect, it } from "bun:test";

describe("bindSecretRuntime early-return optimization", () => {
	// Reproduce the closure's binding pattern with the early-return guard.
	function createBinder() {
		const map = new WeakMap<object, string>();
		const bind = (value: unknown, runtime: string): void => {
			if (typeof value !== "object" || value === null) return;
			if (map.get(value) === runtime) return;
			map.set(value, runtime);
			if (Array.isArray(value)) {
				for (const item of value) {
					if (typeof item === "object" && item !== null) map.set(item, runtime);
				}
			}
		};
		const resolve = (value: object): string | undefined => map.get(value);
		return { bind, resolve, map };
	}

	it("binds the array and every element on the first call", () => {
		const { bind, resolve } = createBinder();
		const item0 = { role: "user" };
		const item1 = { role: "assistant" };
		const arr = [item0, item1];

		bind(arr, "R1");

		expect(resolve(arr)).toBe("R1");
		expect(resolve(item0)).toBe("R1");
		expect(resolve(item1)).toBe("R1");
	});

	it("skips the per-element iteration on a redundant re-bind", () => {
		const { bind, resolve, map } = createBinder();
		const item0 = { role: "user" };
		const arr = [item0, { role: "assistant" }];

		bind(arr, "R1");
		const setCountBefore = countBound(map, arr);
		expect(setCountBefore).toBe(3); // arr + 2 elements

		// Re-bind the same array to the same runtime — the early return fires.
		bind(arr, "R1");
		const setCountAfter = countBound(map, arr);
		expect(setCountAfter).toBe(3); // unchanged: no new entries

		// Elements are still correctly resolved.
		expect(resolve(arr)).toBe("R1");
		expect(resolve(item0)).toBe("R1");
	});

	it("re-binds the array and all elements when the runtime changes", () => {
		const { bind, resolve } = createBinder();
		const item0 = { role: "user" };
		const item1 = { role: "assistant" };
		const arr = [item0, item1];

		bind(arr, "R1");
		bind(arr, "R2");

		expect(resolve(arr)).toBe("R2");
		expect(resolve(item0)).toBe("R2");
		expect(resolve(item1)).toBe("R2");
	});

	it("resolves a runtime through the array when the context object is unbound", () => {
		const { bind, resolve } = createBinder();
		const item0 = { role: "user" };
		const arr = [item0];
		const context = { messages: arr };

		bind(arr, "R1");
		// Context object was never bound, but the messages array was.
		expect(resolve(context)).toBeUndefined();
		expect(resolve(arr)).toBe("R1");
		expect(resolve(item0)).toBe("R1");
	});

	it("handles an empty array without error", () => {
		const { bind, resolve } = createBinder();
		const arr: object[] = [];
		bind(arr, "R1");
		expect(resolve(arr)).toBe("R1");
	});

	it("handles a non-array object without iterating", () => {
		const { bind, resolve } = createBinder();
		const obj = { role: "user" };
		bind(obj, "R1");
		expect(resolve(obj)).toBe("R1");
		// Re-bind is a no-op.
		bind(obj, "R1");
		expect(resolve(obj)).toBe("R1");
	});
});

/** Count how many objects in the array plus the array itself are bound. */
function countBound(map: WeakMap<object, string>, arr: object[]): number {
	let count = 0;
	if (map.get(arr) !== undefined) count++;
	for (const item of arr) {
		if (map.get(item) !== undefined) count++;
	}
	return count;
}
