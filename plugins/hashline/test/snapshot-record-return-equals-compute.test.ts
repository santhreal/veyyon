/**
 * SnapshotStore.record return value always equals computeFileHash(fullText).
 */
import { describe, expect, it } from "bun:test";
import { computeFileHash, InMemorySnapshotStore } from "@veyyon/hashline";

describe("record return equals computeFileHash", () => {
	const samples = ["", "a", "a\nb", "unicode ☃", "x".repeat(100), "line\nline\n"];
	for (const s of samples) {
		it(JSON.stringify(s).slice(0, 40), () => {
			const store = new InMemorySnapshotStore();
			const h = store.record("f.ts", s);
			expect(h).toBe(computeFileHash(s));
			expect(store.head("f.ts")!.hash).toBe(h);
		});
	}
});
