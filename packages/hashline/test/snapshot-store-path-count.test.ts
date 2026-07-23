import { describe, expect, it } from "bun:test";
import { computeFileHash, InMemorySnapshotStore } from "@veyyon/hashline";

/**
 * Snapshot store records many paths without interference.
 */

describe("InMemorySnapshotStore many paths", () => {
	it("records 100 distinct paths with unique bodies", () => {
		const store = new InMemorySnapshotStore();
		const tags: string[] = [];
		for (let i = 0; i < 100; i++) {
			const body = `file ${i}\ncontent\n`;
			const tag = store.record(`p/${i}.ts`, body);
			expect(tag).toBe(computeFileHash(body));
			tags.push(tag);
		}
		// Most tags unique given distinct bodies.
		expect(new Set(tags).size).toBeGreaterThan(90);
	});
});
