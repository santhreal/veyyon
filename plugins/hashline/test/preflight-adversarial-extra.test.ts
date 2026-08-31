import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher, type WriteResult } from "@veyyon/hashline";

/**
 * Extra preflight adversarial cases: blocked first file, empty patch reject,
 * and multi-file with delete+swap batch integrity.
 */

function setup(files: Record<string, string>) {
	const fs = new InMemoryFilesystem(Object.entries(files));
	const snapshots = new InMemorySnapshotStore();
	const tags: Record<string, string> = {};
	for (const [p, c] of Object.entries(files)) tags[p] = snapshots.record(p, c);
	return { fs, snapshots, tags };
}

describe("hashline preflight adversarial extras", () => {
	it("blocks entire batch when preflightWrite fails on the first section", async () => {
		class BlockFirst extends InMemoryFilesystem {
			override async preflightWrite(filePath: string): Promise<void> {
				if (filePath === "a.ts") throw new Error("blocked write: a.ts");
			}
		}
		const files = { "a.ts": "one\n", "b.ts": "two\n" };
		const fs = new BlockFirst(Object.entries(files));
		const snapshots = new InMemorySnapshotStore();
		const tags = Object.fromEntries(Object.entries(files).map(([p, c]) => [p, snapshots.record(p, c)]));
		const patcher = new Patcher({ fs, snapshots });
		const patch = Patch.parse(
			[`[a.ts#${tags["a.ts"]}]`, "SWAP 1.=1:", "+ONE", `[b.ts#${tags["b.ts"]}]`, "SWAP 1.=1:", "+TWO"].join("\n"),
		);
		await expect(patcher.preflight(patch)).rejects.toThrow(/blocked write: a\.ts/);
		expect(fs.get("a.ts")).toBe("one\n");
		expect(fs.get("b.ts")).toBe("two\n");
	});

	it("delete+swap multi-file batch applies both or neither on tag mismatch", async () => {
		const { fs, snapshots, tags } = setup({
			"del.ts": "a\nb\nc\n",
			"swap.ts": "old\n",
		});
		const patcher = new Patcher({ fs, snapshots });
		const good = await patcher.apply(
			Patch.parse(
				[`[del.ts#${tags["del.ts"]}]`, "DEL 2", `[swap.ts#${tags["swap.ts"]}]`, "SWAP 1.=1:", "+new"].join("\n"),
			),
		);
		expect(good.sections).toHaveLength(2);
		expect(fs.get("del.ts")).toBe("a\nc\n");
		expect(fs.get("swap.ts")).toBe("new\n");

		const before = { del: fs.get("del.ts")!, swap: fs.get("swap.ts")! };
		const hDel = snapshots.record("del.ts", before.del);
		const bad = Patch.parse([`[del.ts#${hDel}]`, "DEL 1", "[swap.ts#0000]", "SWAP 1.=1:", "+poison"].join("\n"));
		await expect(patcher.apply(bad)).rejects.toThrow();
		expect(fs.get("del.ts")).toBe(before.del);
		expect(fs.get("swap.ts")).toBe(before.swap);
	});

	it("writeText failure mid-batch names remaining sections", async () => {
		class FailSecond extends InMemoryFilesystem {
			#n = 0;
			override async writeText(path: string, content: string): Promise<WriteResult> {
				this.#n++;
				if (this.#n === 2) throw new Error("EIO");
				return super.writeText(path, content);
			}
		}
		const files = { "a.ts": "1\n", "b.ts": "2\n", "c.ts": "3\n" };
		const fs = new FailSecond(Object.entries(files));
		const snapshots = new InMemorySnapshotStore();
		const tags = Object.fromEntries(Object.entries(files).map(([p, c]) => [p, snapshots.record(p, c)]));
		const patcher = new Patcher({ fs, snapshots });
		const patch = Patch.parse(
			[
				`[a.ts#${tags["a.ts"]}]`,
				"SWAP 1.=1:",
				"+A",
				`[b.ts#${tags["b.ts"]}]`,
				"SWAP 1.=1:",
				"+B",
				`[c.ts#${tags["c.ts"]}]`,
				"SWAP 1.=1:",
				"+C",
			].join("\n"),
		);
		const err = await patcher.apply(patch).then(
			() => null,
			e => e as Error,
		);
		expect(err?.message).toContain("EIO");
		expect(err?.message).toMatch(/already written|not written/i);
		expect(fs.get("a.ts")).toBe("A\n");
		expect(fs.get("b.ts")).toBe("2\n");
		expect(fs.get("c.ts")).toBe("3\n");
	});
});
