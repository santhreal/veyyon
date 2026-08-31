import { describe, expect, it } from "bun:test";
import { computeFileHash, InMemorySnapshotStore } from "@veyyon/hashline";

/**
 * Snapshot store with empty and newline-only bodies.
 */

describe("InMemorySnapshotStore empty bodies", () => {
	it("records empty string", () => {
		const store = new InMemorySnapshotStore();
		const tag = store.record("a.ts", "");
		expect(tag).toBe(computeFileHash(""));
	});

	it("records newline-only", () => {
		const store = new InMemorySnapshotStore();
		const tag = store.record("a.ts", "\n");
		expect(tag).toBe(computeFileHash("\n"));
		expect(tag).not.toBe(computeFileHash(""));
	});
});
