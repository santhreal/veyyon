import { describe, expect, it } from "bun:test";
import { computeFileHash, InMemorySnapshotStore } from "@veyyon/hashline";

/**
 * Re-recording different content for the same path updates the tag.
 */

describe("InMemorySnapshotStore overwrite tag", () => {
	it("tag changes when content changes", () => {
		const store = new InMemorySnapshotStore();
		const t1 = store.record("a.ts", "v1\n");
		const t2 = store.record("a.ts", "v2\n");
		expect(t1).toBe(computeFileHash("v1\n"));
		expect(t2).toBe(computeFileHash("v2\n"));
		expect(t1).not.toBe(t2);
	});

	it("tag stays when content stays", () => {
		const store = new InMemorySnapshotStore();
		const t1 = store.record("a.ts", "same\n");
		const t2 = store.record("a.ts", "same\n");
		expect(t1).toBe(t2);
	});
});
