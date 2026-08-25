/**
 * `shrinkWalk` rebuilds objects with `for…in` and no hasOwn.
 *
 * WHY THIS SUITE EXISTS. `JSON.stringify` only enumerates own properties, so
 * the cheap "already under the cap" path never sees a prototype string.
 * Once a payload is oversized, shrinkWalk clones with `for (const k in src)`
 * and copies inherited enumerable keys onto the clone that then goes on the
 * wire. A guest would then render fields the host never owned — the same
 * class of bug as flattenWorkspaceTextEdits walking `changes.__proto__`.
 *
 * The existing replication-shrink tests pin size and elision markers, not
 * prototype pollution of the clone.
 */
import { describe, expect, it } from "bun:test";
import { MAX_REPLICATED_PAYLOAD_BYTES, shrinkForReplication } from "@veyyon/coding-agent/collab/replication-shrink";

describe("shrinkForReplication copies only own keys", () => {
	it("does not materialize an inherited enumerable string onto an oversized clone", () => {
		const stolen = "STOLEN".repeat(16);
		const proto = { leaked: stolen };
		const blob = "B".repeat(MAX_REPLICATED_PAYLOAD_BYTES);
		const value = Object.assign(Object.create(proto), {
			t: "entry",
			blob,
		}) as { t: string; blob: string; leaked?: string };

		expect(JSON.stringify(value).includes("STOLEN")).toBe(false);
		expect(value.leaked).toBe(stolen);

		const shrunk = shrinkForReplication(value) as { t: string; blob: string; leaked?: string };
		expect(shrunk.t).toBe("entry");
		expect(Object.hasOwn(shrunk, "leaked")).toBe(false);
		expect(JSON.stringify(shrunk).includes("STOLEN")).toBe(false);
	});

	it("does not copy inherited array-shaped keys either", () => {
		const proto = { extra: ["inherited"] };
		const value = Object.assign(Object.create(proto), {
			t: "snapshot-chunk",
			items: Array.from({ length: 400 }, (_, i) => `x${i}-${"y".repeat(4000)}`),
		});
		const shrunk = shrinkForReplication(value) as { extra?: unknown; t: string };
		expect(shrunk.t).toBe("snapshot-chunk");
		expect(Object.hasOwn(shrunk, "extra")).toBe(false);
	});

	it("still returns the same object when under the cap (inherited keys stay on the prototype, not cloned)", () => {
		const proto = { leaked: "no" };
		const value = Object.assign(Object.create(proto), { t: "hello" });
		expect(shrinkForReplication(value)).toBe(value);
	});
});
