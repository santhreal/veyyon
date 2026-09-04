import { describe, expect, it } from "bun:test";
import { computeFileHash, InMemorySnapshotStore } from "@veyyon/hashline";

/**
 * InMemorySnapshotStore.record returns hash matching computeFileHash.
 */

describe("InMemorySnapshotStore.record property", () => {
	it("record returns computeFileHash for many bodies", () => {
		const store = new InMemorySnapshotStore();
		for (let i = 0; i < 50; i++) {
			const path = `f${i}.ts`;
			const body = `export const n = ${i};\n`;
			const tag = store.record(path, body);
			expect(tag.toLowerCase()).toBe(computeFileHash(body).toLowerCase());
			expect(tag).toMatch(/^[0-9A-Fa-f]{4}$/);
		}
	});

	it("re-recording same content yields same tag", () => {
		const store = new InMemorySnapshotStore();
		const body = "same\n";
		const t1 = store.record("a.ts", body);
		const t2 = store.record("a.ts", body);
		expect(t1).toBe(t2);
	});

	it("different paths can share content tags", () => {
		const store = new InMemorySnapshotStore();
		const body = "shared\n";
		const t1 = store.record("a.ts", body);
		const t2 = store.record("b.ts", body);
		expect(t1).toBe(t2);
	});
});
