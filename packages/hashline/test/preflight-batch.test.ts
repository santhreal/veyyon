import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher, type WriteResult } from "@veyyon/hashline";

function setup(files: Record<string, string>): {
	fs: InMemoryFilesystem;
	snapshots: InMemorySnapshotStore;
	tags: Record<string, string>;
} {
	const fs = new InMemoryFilesystem(Object.entries(files));
	const snapshots = new InMemorySnapshotStore();
	const tags: Record<string, string> = {};
	for (const [path, content] of Object.entries(files)) tags[path] = snapshots.record(path, content);
	return { fs, snapshots, tags };
}

describe("Patcher.preflight", () => {
	it("validates a multi-section patch without writing anything", async () => {
		const { fs, snapshots, tags } = setup({ "a.ts": "one\n", "b.ts": "two\n" });
		const patcher = new Patcher({ fs, snapshots });
		const patch = Patch.parse(
			[`[a.ts#${tags["a.ts"]}]`, "SWAP 1.=1:", "+ONE", `[b.ts#${tags["b.ts"]}]`, "SWAP 1.=1:", "+TWO"].join("\n"),
		);
		await patcher.preflight(patch);
		expect(fs.get("a.ts")).toBe("one\n");
		expect(fs.get("b.ts")).toBe("two\n");
	});

	it("rejects a no-op section", async () => {
		const { fs, snapshots, tags } = setup({ "a.ts": "one\n", "b.ts": "two\n" });
		const patcher = new Patcher({ fs, snapshots });
		const patch = Patch.parse(
			[`[a.ts#${tags["a.ts"]}]`, "SWAP 1.=1:", "+one", `[b.ts#${tags["b.ts"]}]`, "SWAP 1.=1:", "+TWO"].join("\n"),
		);
		await expect(patcher.preflight(patch)).rejects.toThrow(/Edits to a\.ts resulted in no changes/);
	});

	it("rejects two differently-authored paths canonicalizing to the same file before any write", async () => {
		class CanonicalizingFs extends InMemoryFilesystem {
			override canonicalPath(path: string): string {
				return path.replace(/^\.\//, "");
			}
			override async readText(path: string): Promise<string> {
				return super.readText(this.canonicalPath(path));
			}
		}
		const fs = new CanonicalizingFs([["a.ts", "one\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", "one\n");
		snapshots.record("./a.ts", "one\n");
		const patcher = new Patcher({ fs, snapshots });
		const patch = Patch.parse(
			[`[a.ts#${tag}]`, "SWAP 1.=1:", "+ONE", `[./a.ts#${tag}]`, "SWAP 1.=1:", "+one!"].join("\n"),
		);
		await expect(patcher.preflight(patch)).rejects.toThrow(/Multiple hashline sections resolve to the same file/);
		await expect(patcher.apply(patch)).rejects.toThrow(/Merge their ops under one header/);
		expect(fs.get("a.ts")).toBe("one\n");
	});
});

describe("Patcher.apply multi-section batches", () => {
	it("applies all sections when every prepare succeeds", async () => {
		const { fs, snapshots, tags } = setup({ "a.ts": "one\n", "b.ts": "two\n" });
		const patcher = new Patcher({ fs, snapshots });
		const result = await patcher.apply(
			Patch.parse(
				[`[a.ts#${tags["a.ts"]}]`, "SWAP 1.=1:", "+ONE", `[b.ts#${tags["b.ts"]}]`, "SWAP 1.=1:", "+TWO"].join("\n"),
			),
		);
		expect(result.sections).toHaveLength(2);
		expect(fs.get("a.ts")).toBe("ONE\n");
		expect(fs.get("b.ts")).toBe("TWO\n");
	});

	it("writes nothing when a later section fails prepare (all-or-nothing preflight)", async () => {
		const { fs, snapshots, tags } = setup({ "a.ts": "one\n", "b.ts": "two\n" });
		const patcher = new Patcher({ fs, snapshots });
		const patch = Patch.parse(
			[`[a.ts#${tags["a.ts"]}]`, "SWAP 1.=1:", "+ONE", "[b.ts#FFFF]", "SWAP 1.=1:", "+TWO"].join("\n"),
		);
		await expect(patcher.apply(patch)).rejects.toThrow();
		expect(fs.get("a.ts")).toBe("one\n");
		expect(fs.get("b.ts")).toBe("two\n");
	});

	it("reports written vs not-written sections when a mid-batch write fails", async () => {
		class FailSecondWriteFs extends InMemoryFilesystem {
			writes = 0;
			override async writeText(path: string, content: string): Promise<WriteResult> {
				this.writes++;
				if (this.writes === 2) throw new Error("disk full");
				return super.writeText(path, content);
			}
		}
		const files = { "a.ts": "one\n", "b.ts": "two\n", "c.ts": "three\n" };
		const fs = new FailSecondWriteFs(Object.entries(files));
		const snapshots = new InMemorySnapshotStore();
		const tags = Object.fromEntries(Object.entries(files).map(([p, c]) => [p, snapshots.record(p, c)]));
		const patcher = new Patcher({ fs, snapshots });
		const patch = Patch.parse(
			[
				`[a.ts#${tags["a.ts"]}]`,
				"SWAP 1.=1:",
				"+ONE",
				`[b.ts#${tags["b.ts"]}]`,
				"SWAP 1.=1:",
				"+TWO",
				`[c.ts#${tags["c.ts"]}]`,
				"SWAP 1.=1:",
				"+THREE",
			].join("\n"),
		);
		const error = await patcher.apply(patch).then(
			() => null,
			e => e as Error,
		);
		expect(error?.message).toContain("Failed to write b.ts: disk full");
		expect(error?.message).toContain("Sections already written: a.ts.");
		expect(error?.message).toContain("Sections not written: c.ts.");
		expect(fs.get("a.ts")).toBe("ONE\n");
		expect(fs.get("b.ts")).toBe("two\n");
		expect(fs.get("c.ts")).toBe("three\n");
	});
});
