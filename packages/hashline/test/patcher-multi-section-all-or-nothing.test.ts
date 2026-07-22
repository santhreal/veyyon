/**
 * Patcher multi-section preflight: one bad section blocks every write.
 * Exact post-state and error type.
 */
import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	MismatchError,
	Patch,
	Patcher,
	computeFileHash,
	formatHashlineHeader,
} from "@veyyon/hashline";

describe("Patcher multi-section all-or-nothing", () => {
	it("commits two valid sections in order with fresh hashes", async () => {
		const a = "a1\na2\n";
		const b = "b1\nb2\n";
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
				"+A1",
				formatHashlineHeader("b.ts", tb),
				"SWAP 2.=2:",
				"+B2",
			].join("\n"),
		);
		const result = await patcher.apply(patch);
		expect(result.sections).toHaveLength(2);
		expect(result.sections[0]?.op).toBe("update");
		expect(result.sections[1]?.op).toBe("update");
		expect(fs.get("a.ts")).toBe("A1\na2\n");
		expect(fs.get("b.ts")).toBe("b1\nB2\n");
		// Post-apply tags match live content hashes
		expect(result.sections[0]?.fileHash).toBe(computeFileHash("A1\na2\n"));
		expect(result.sections[1]?.fileHash).toBe(computeFileHash("b1\nB2\n"));
	});

	it("second section mismatch leaves first file untouched", async () => {
		const a = "keep-a\n";
		const b = "live-b\n";
		const fs = new InMemoryFilesystem([
			["a.ts", a],
			["b.ts", b],
		]);
		const snapshots = new InMemorySnapshotStore();
		const ta = snapshots.record("a.ts", a);
		// Stale tag for b: recorded "old-b" but live is "live-b"
		const tb = snapshots.record("b.ts", "old-b\n");
		// Head advanced for b without updating live in a way recovery can use:
		// force live drift with no usable remap (content totally different)
		const patcher = new Patcher({ fs, snapshots });
		const patch = Patch.parse(
			[
				formatHashlineHeader("a.ts", ta),
				"SWAP 1.=1:",
				"+CHANGED-A",
				formatHashlineHeader("b.ts", tb),
				"SWAP 1.=1:",
				"+CHANGED-B",
			].join("\n"),
		);
		await expect(patcher.apply(patch)).rejects.toBeInstanceOf(MismatchError);
		// all-or-nothing: a.ts must remain original
		expect(fs.get("a.ts")).toBe(a);
		expect(fs.get("b.ts")).toBe(b);
	});

	it("missing snapshot tag rejects without writing", async () => {
		const fs = new InMemoryFilesystem([["a.ts", "x\n"]]);
		const snapshots = new InMemorySnapshotStore();
		snapshots.record("a.ts", "x\n");
		const patcher = new Patcher({ fs, snapshots });
		// Header without hash tag
		const patch = Patch.parse("[a.ts]\nSWAP 1.=1:\n+Y");
		await expect(patcher.apply(patch)).rejects.toThrow(/Missing hashline snapshot tag|snapshot tag/i);
		expect(fs.get("a.ts")).toBe("x\n");
	});

	it("REM deletes file and records result op", async () => {
		const fs = new InMemoryFilesystem([["gone.ts", "bye\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("gone.ts", "bye\n");
		const patcher = new Patcher({ fs, snapshots });
		const result = await patcher.apply(Patch.parse(`${formatHashlineHeader("gone.ts", tag)}\nREM`));
		expect(result.sections[0]?.op).toBe("delete");
		expect(fs.get("gone.ts")).toBeUndefined();
	});

	it("session chain: apply twice with refreshed hash from first result", async () => {
		const fs = new InMemoryFilesystem([["c.ts", "v0\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const t0 = snapshots.record("c.ts", "v0\n");
		const patcher = new Patcher({ fs, snapshots });
		const r1 = await patcher.apply(Patch.parse(`${formatHashlineHeader("c.ts", t0)}\nSWAP 1.=1:\n+v1`));
		expect(fs.get("c.ts")).toBe("v1\n");
		const t1 = r1.sections[0]!.fileHash!;
		const r2 = await patcher.apply(Patch.parse(`${formatHashlineHeader("c.ts", t1)}\nSWAP 1.=1:\n+v2`));
		expect(fs.get("c.ts")).toBe("v2\n");
		expect(r2.sections[0]?.fileHash).toBe(computeFileHash("v2\n"));
	});

	it("prepare then commit writes once with same outcome as apply", async () => {
		const content = "p1\np2\n";
		const fs = new InMemoryFilesystem([["p.ts", content]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("p.ts", content);
		const patcher = new Patcher({ fs, snapshots });
		const section = Patch.parse(`${formatHashlineHeader("p.ts", tag)}\nSWAP 2.=2:\n+P2`).sections[0]!;
		const prepared = await patcher.prepare(section);
		expect(fs.get("p.ts")).toBe(content); // not written yet
		const committed = await patcher.commit(prepared);
		expect(committed.op).toBe("update");
		expect(fs.get("p.ts")).toBe("p1\nP2\n");
	});
});
