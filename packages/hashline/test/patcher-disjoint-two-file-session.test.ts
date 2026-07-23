/**
 * Two-file session: alternate edits with refreshed hashes from prior apply results.
 */
import { describe, expect, it } from "bun:test";
import { formatHashlineHeader, InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@veyyon/hashline";

describe("Patcher two-file alternating session", () => {
	it("edit a then b then a again with returned hashes", async () => {
		const fs = new InMemoryFilesystem([
			["a.ts", "A0\n"],
			["b.ts", "B0\n"],
		]);
		const snapshots = new InMemorySnapshotStore();
		let ta = snapshots.record("a.ts", "A0\n");
		let tb = snapshots.record("b.ts", "B0\n");
		const patcher = new Patcher({ fs, snapshots });

		const r1 = await patcher.apply(Patch.parse(`${formatHashlineHeader("a.ts", ta)}\nSWAP 1.=1:\n+A1`));
		ta = r1.sections[0]!.fileHash!;
		expect(fs.get("a.ts")).toBe("A1\n");

		const r2 = await patcher.apply(Patch.parse(`${formatHashlineHeader("b.ts", tb)}\nSWAP 1.=1:\n+B1`));
		tb = r2.sections[0]!.fileHash!;
		expect(fs.get("b.ts")).toBe("B1\n");

		const r3 = await patcher.apply(Patch.parse(`${formatHashlineHeader("a.ts", ta)}\nSWAP 1.=1:\n+A2`));
		expect(fs.get("a.ts")).toBe("A2\n");
		expect(fs.get("b.ts")).toBe("B1\n");
		expect(r3.sections[0]!.fileHash).toMatch(/^[0-9A-F]{4}$/);
	});

	it("stale hash on a does not corrupt b", async () => {
		const fs = new InMemoryFilesystem([
			["a.ts", "live-a\n"],
			["b.ts", "live-b\n"],
		]);
		const snapshots = new InMemorySnapshotStore();
		const staleA = snapshots.record("a.ts", "old-a\n");
		const tb = snapshots.record("b.ts", "live-b\n");
		const patcher = new Patcher({ fs, snapshots });
		await expect(
			patcher.apply(
				Patch.parse(
					[
						formatHashlineHeader("a.ts", staleA),
						"SWAP 1.=1:",
						"+X",
						formatHashlineHeader("b.ts", tb),
						"SWAP 1.=1:",
						"+Y",
					].join("\n"),
				),
			),
		).rejects.toThrow();
		expect(fs.get("a.ts")).toBe("live-a\n");
		expect(fs.get("b.ts")).toBe("live-b\n");
	});
});
