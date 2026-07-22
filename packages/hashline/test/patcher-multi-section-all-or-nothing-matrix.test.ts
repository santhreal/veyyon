/**
 * Patcher multi-section all-or-nothing property: n good sections all land;
 * any bad section leaves every file unchanged.
 */
import { describe, expect, it } from "bun:test";
import {
	computeFileHash,
	formatHashlineHeader,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	MismatchError,
	Patch,
	Patcher,
} from "@veyyon/hashline";

describe("Patcher multi-section all-or-nothing matrix", () => {
	it("two good sections both land with fresh hashes", async () => {
		const a = "A1\nA2\n";
		const b = "B1\nB2\n";
		const fs = new InMemoryFilesystem([
			["a.ts", a],
			["b.ts", b],
		]);
		const snapshots = new InMemorySnapshotStore();
		const ha = snapshots.record("a.ts", a);
		const hb = snapshots.record("b.ts", b);
		const patcher = new Patcher({ fs, snapshots });
		const result = await patcher.apply(
			Patch.parse(
				[
					formatHashlineHeader("a.ts", ha),
					"SWAP 1.=1:",
					"+A1x",
					formatHashlineHeader("b.ts", hb),
					"SWAP 2.=2:",
					"+B2x",
				].join("\n"),
			),
		);
		expect(result.sections).toHaveLength(2);
		expect(fs.get("a.ts")).toBe("A1x\nA2\n");
		expect(fs.get("b.ts")).toBe("B1\nB2x\n");
		expect(result.sections[0]?.fileHash).toBe(computeFileHash("A1x\nA2\n"));
		expect(result.sections[1]?.fileHash).toBe(computeFileHash("B1\nB2x\n"));
	});

	it("bad tag on second section is MismatchError and no writes", async () => {
		const a = "A1\n";
		const b = "B1\n";
		const fs = new InMemoryFilesystem([
			["a.ts", a],
			["b.ts", b],
		]);
		const snapshots = new InMemorySnapshotStore();
		const ha = snapshots.record("a.ts", a);
		snapshots.record("b.ts", b);
		const patcher = new Patcher({ fs, snapshots });
		await expect(
			patcher.apply(
				Patch.parse(
					[
						formatHashlineHeader("a.ts", ha),
						"SWAP 1.=1:",
						"+CHANGED",
						formatHashlineHeader("b.ts", "DEAD"),
						"SWAP 1.=1:",
						"+NOPE",
					].join("\n"),
				),
			),
		).rejects.toBeInstanceOf(MismatchError);
		expect(fs.get("a.ts")).toBe(a);
		expect(fs.get("b.ts")).toBe(b);
	});

	it("out-of-range edit refuses without partial write", async () => {
		const a = "only\n";
		const b = "keep\n";
		const fs = new InMemoryFilesystem([
			["a.ts", a],
			["b.ts", b],
		]);
		const snapshots = new InMemorySnapshotStore();
		const ha = snapshots.record("a.ts", a);
		const hb = snapshots.record("b.ts", b);
		const patcher = new Patcher({ fs, snapshots });
		await expect(
			patcher.apply(
				Patch.parse(
					[
						formatHashlineHeader("a.ts", ha),
						"DEL 9",
						formatHashlineHeader("b.ts", hb),
						"SWAP 1.=1:",
						"+mutated",
					].join("\n"),
				),
			),
		).rejects.toThrow();
		expect(fs.get("a.ts")).toBe(a);
		expect(fs.get("b.ts")).toBe(b);
	});

	for (const n of [2, 3, 4, 5]) {
		it(`${n} sections sequential good applies all`, async () => {
			const entries: Array<[string, string]> = [];
			for (let i = 0; i < n; i++) entries.push([`f${i}.ts`, `L${i}\n`]);
			const fs = new InMemoryFilesystem(entries);
			const snapshots = new InMemorySnapshotStore();
			const parts: string[] = [];
			for (const [path, text] of entries) {
				const h = snapshots.record(path, text);
				parts.push(formatHashlineHeader(path, h), "SWAP 1.=1:", `+N${path}`);
			}
			const patcher = new Patcher({ fs, snapshots });
			const result = await patcher.apply(Patch.parse(parts.join("\n")));
			expect(result.sections).toHaveLength(n);
			for (let i = 0; i < n; i++) {
				expect(fs.get(`f${i}.ts`)).toBe(`Nf${i}.ts\n`);
			}
		});
	}
});
