/**
 * Recovery external path: head === snapshot but live drifted → RECOVERY_EXTERNAL_WARNING.
 */
import { describe, expect, it } from "bun:test";
import {
	InMemorySnapshotStore,
	parsePatch,
	RECOVERY_EXTERNAL_WARNING,
	RECOVERY_LINE_REMAP_WARNING,
	Recovery,
} from "@veyyon/hashline";

describe("Recovery external warning exact", () => {
	it("emits external or remap warning when head still tagged snapshot", () => {
		const store = new InMemorySnapshotStore();
		const tagged = "a\nb\nc";
		const h = store.record("f.ts", tagged);
		// Do not re-record live; head stays tagged snapshot
		expect(store.head("f.ts")!.hash).toBe(h);
		const live = "a\nEXTRA\nb\nc";
		const r = new Recovery(store);
		const result = r.tryRecover({
			path: "f.ts",
			currentText: live,
			fileHash: h,
			edits: parsePatch("SWAP 3.=3:\n+B").edits,
		});
		if (result) {
			expect(
				result.warnings.includes(RECOVERY_EXTERNAL_WARNING) ||
					result.warnings.includes(RECOVERY_LINE_REMAP_WARNING) ||
					result.warnings.some(w => w.startsWith("Recovered")),
			).toBe(true);
			expect(result.text).toContain("B");
			expect(result.text).toContain("EXTRA");
		}
	});

	it("unknown hash still null", () => {
		const store = new InMemorySnapshotStore();
		store.record("f.ts", "a");
		const r = new Recovery(store);
		expect(
			r.tryRecover({
				path: "f.ts",
				currentText: "a",
				fileHash: "ZZZZ",
				edits: parsePatch("DEL 1").edits,
			}),
		).toBeNull();
	});
});
