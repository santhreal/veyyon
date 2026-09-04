/**
 * prepare all sections then commit: failure in prepare of section 2 never commits section 1.
 */
import { describe, expect, it } from "bun:test";
import {
	formatHashlineHeader,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	MismatchError,
	Patch,
	Patcher,
} from "@veyyon/hashline";

describe("Patcher prepare batch all-or-nothing", () => {
	it("prepare all then commit all matches apply multi-section", async () => {
		const a = "a\n";
		const b = "b\n";
		const fs = new InMemoryFilesystem([
			["a.ts", a],
			["b.ts", b],
		]);
		const snapshots = new InMemorySnapshotStore();
		const ta = snapshots.record("a.ts", a);
		const tb = snapshots.record("b.ts", b);
		const patcher = new Patcher({ fs, snapshots });
		const patch = Patch.parse(
			[
				formatHashlineHeader("a.ts", ta),
				"SWAP 1.=1:",
				"+A",
				formatHashlineHeader("b.ts", tb),
				"SWAP 1.=1:",
				"+B",
			].join("\n"),
		);
		const prepared = [];
		for (const section of patch.sections) {
			prepared.push(await patcher.prepare(section));
		}
		// nothing written yet
		expect(fs.get("a.ts")).toBe(a);
		expect(fs.get("b.ts")).toBe(b);
		for (const p of prepared) {
			await patcher.commit(p);
		}
		expect(fs.get("a.ts")).toBe("A\n");
		expect(fs.get("b.ts")).toBe("B\n");
	});

	it("failed prepare on second section leaves first uncommitted when using prepare loop", async () => {
		const a = "a\n";
		const b = "live\n";
		const fs = new InMemoryFilesystem([
			["a.ts", a],
			["b.ts", b],
		]);
		const snapshots = new InMemorySnapshotStore();
		const ta = snapshots.record("a.ts", a);
		const tb = snapshots.record("b.ts", "stale\n");
		const patcher = new Patcher({ fs, snapshots });
		const patch = Patch.parse(
			[
				formatHashlineHeader("a.ts", ta),
				"SWAP 1.=1:",
				"+A",
				formatHashlineHeader("b.ts", tb),
				"SWAP 1.=1:",
				"+B",
			].join("\n"),
		);
		const first = await patcher.prepare(patch.sections[0]!);
		await expect(patcher.prepare(patch.sections[1]!)).rejects.toBeInstanceOf(MismatchError);
		// first prepared but not committed
		expect(fs.get("a.ts")).toBe(a);
		// do not commit first on failure
		expect(fs.get("b.ts")).toBe(b);
		// first is still commit-able if caller chooses — but all-or-nothing policy is caller's
		// when using apply():
		await expect(patcher.apply(patch)).rejects.toBeInstanceOf(MismatchError);
		expect(fs.get("a.ts")).toBe(a);
		void first;
	});
});
