/**
 * Head/tail inserts on stale tags: content-independent, apply with HEADTAIL_DRIFT_WARNING.
 */
import { describe, expect, it } from "bun:test";
import {
	HEADTAIL_DRIFT_WARNING,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	formatHashlineHeader,
} from "@veyyon/hashline";

describe("Patcher head/tail drift", () => {
	it("INS.HEAD applies on stale tag with drift warning", async () => {
		const live = "body\n";
		const fs = new InMemoryFilesystem([["f.ts", live]]);
		const snapshots = new InMemorySnapshotStore();
		// Tag from older content; live drifted but head insert is position-independent
		const stale = snapshots.record("f.ts", "old\n");
		// live is different and not recorded as matching stale for content anchors
		const patcher = new Patcher({ fs, snapshots });
		const result = await patcher.apply(
			Patch.parse(`${formatHashlineHeader("f.ts", stale)}\nINS.HEAD:\n+HEAD`),
		);
		expect(fs.get("f.ts")).toBe("HEAD\nbody\n");
		const warnings = result.sections.flatMap(s => s.warnings ?? []);
		expect(warnings).toContain(HEADTAIL_DRIFT_WARNING);
	});

	it("INS.TAIL applies on stale tag with drift warning", async () => {
		const live = "body\n";
		const fs = new InMemoryFilesystem([["f.ts", live]]);
		const snapshots = new InMemorySnapshotStore();
		const stale = snapshots.record("f.ts", "older\n");
		const patcher = new Patcher({ fs, snapshots });
		const result = await patcher.apply(
			Patch.parse(`${formatHashlineHeader("f.ts", stale)}\nINS.TAIL:\n+TAIL`),
		);
		expect(fs.get("f.ts")).toBe("body\nTAIL\n");
		const warnings = result.sections.flatMap(s => s.warnings ?? []);
		expect(warnings).toContain(HEADTAIL_DRIFT_WARNING);
	});

	it("anchored SWAP on same stale tag still mismatches (not head/tail)", async () => {
		const fs = new InMemoryFilesystem([["f.ts", "live\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const stale = snapshots.record("f.ts", "tagged\n");
		const patcher = new Patcher({ fs, snapshots });
		await expect(
			patcher.apply(Patch.parse(`${formatHashlineHeader("f.ts", stale)}\nSWAP 1.=1:\n+X`)),
		).rejects.toThrow(/file changed|not from this session|rejected/i);
		expect(fs.get("f.ts")).toBe("live\n");
	});
});
