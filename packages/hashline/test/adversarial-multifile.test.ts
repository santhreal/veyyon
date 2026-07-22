import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	type WriteResult,
} from "@veyyon/hashline";

/**
 * Adversarial multi-file hashline contracts: mixed endings, unicode paths and
 * anchors, blocked mid-batch writes, colliding tags, and no partial apply when
 * preflight fails. Complements preflight-batch and recovery-session-chain.
 */

function setup(files: Record<string, string>): {
	fs: InMemoryFilesystem;
	snapshots: InMemorySnapshotStore;
	tags: Record<string, string>;
} {
	const fs = new InMemoryFilesystem(Object.entries(files));
	const snapshots = new InMemorySnapshotStore();
	const tags: Record<string, string> = {};
	for (const [path, content] of Object.entries(files)) {
		tags[path] = snapshots.record(path, content);
	}
	return { fs, snapshots, tags };
}

describe("hashline adversarial multi-file", () => {
	it("applies independent CRLF and LF files without rewriting the other file's endings", async () => {
		const crlf = "line-a\r\nline-b\r\n";
		const lf = "line-a\nline-b\n";
		const { fs, snapshots, tags } = setup({ "win.txt": crlf, "unix.txt": lf });
		const patcher = new Patcher({ fs, snapshots });
		const result = await patcher.apply(
			Patch.parse(
				[
					`[win.txt#${tags["win.txt"]}]`,
					"SWAP 1.=1:",
					"+LINE-A",
					`[unix.txt#${tags["unix.txt"]}]`,
					"SWAP 2.=2:",
					"+line-B",
				].join("\n"),
			),
		);
		expect(result.sections).toHaveLength(2);
		// CRLF file keeps CR between lines; LF file stays LF.
		expect(fs.get("win.txt")).toBe("LINE-A\r\nline-b\r\n");
		expect(fs.get("unix.txt")).toBe("line-a\nline-B\n");
	});

	it("handles unicode path segments and non-ASCII anchor content in one batch", async () => {
		const files = {
			"src/日本語/ファイル.ts": "const 名前 = 1;\nconst 値 = 2;\n",
			"src/emoji-🎉.ts": "export const ok = true;\n",
		};
		const { fs, snapshots, tags } = setup(files);
		const patcher = new Patcher({ fs, snapshots });
		const jp = "src/日本語/ファイル.ts";
		const emoji = "src/emoji-🎉.ts";
		await patcher.apply(
			Patch.parse(
				[
					`[${jp}#${tags[jp]}]`,
					"SWAP 1.=1:",
					"+const 名前 = 42;",
					`[${emoji}#${tags[emoji]}]`,
					"SWAP 1.=1:",
					"+export const ok = false;",
				].join("\n"),
			),
		);
		expect(fs.get(jp)).toBe("const 名前 = 42;\nconst 値 = 2;\n");
		expect(fs.get(emoji)).toBe("export const ok = false;\n");
	});

	it("preflight fails closed on a bad second section and leaves both files untouched", async () => {
		const { fs, snapshots, tags } = setup({ "a.ts": "one\n", "b.ts": "two\n" });
		const patcher = new Patcher({ fs, snapshots });
		const patch = Patch.parse(
			[
				`[a.ts#${tags["a.ts"]}]`,
				"SWAP 1.=1:",
				"+ONE",
				// Wrong 4-hex snapshot tag for b.ts — must fail before any write.
				"[b.ts#dead]",
				"SWAP 1.=1:",
				"+TWO",
			].join("\n"),
		);
		await expect(patcher.preflight(patch)).rejects.toThrow();
		await expect(patcher.apply(patch)).rejects.toThrow();
		expect(fs.get("a.ts")).toBe("one\n");
		expect(fs.get("b.ts")).toBe("two\n");
	});

	it("reports which sections wrote when preflightWrite blocks the middle file", async () => {
		class BlockMiddleFs extends InMemoryFilesystem {
			#blocked: Set<string>;
			constructor(initial: Iterable<readonly [string, string]>, blocked: Iterable<string>) {
				super(initial);
				this.#blocked = new Set(blocked);
			}
			override async preflightWrite(filePath: string): Promise<void> {
				if (this.#blocked.has(filePath)) {
					throw new Error(`blocked write: ${filePath}`);
				}
			}
		}
		const files = { "a.ts": "one\n", "b.ts": "two\n", "c.ts": "three\n" };
		const fs = new BlockMiddleFs(Object.entries(files), ["b.ts"]);
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
		// preflight should refuse the whole batch when any section cannot write.
		await expect(patcher.preflight(patch)).rejects.toThrow(/blocked write: b\.ts/);
		expect(fs.get("a.ts")).toBe("one\n");
		expect(fs.get("b.ts")).toBe("two\n");
		expect(fs.get("c.ts")).toBe("three\n");
	});

	it("mid-batch write failure names written and not-written sections", async () => {
		class FailOnB extends InMemoryFilesystem {
			override async writeText(path: string, content: string): Promise<WriteResult> {
				if (path === "b.ts") throw new Error("ENOSPC");
				return super.writeText(path, content);
			}
		}
		const files = { "a.ts": "one\n", "b.ts": "two\n", "c.ts": "three\n" };
		const fs = new FailOnB(Object.entries(files));
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
		const err = await patcher.apply(patch).then(
			() => null,
			e => e as Error,
		);
		expect(err?.message).toContain("Failed to write b.ts: ENOSPC");
		expect(err?.message).toContain("Sections already written: a.ts.");
		expect(err?.message).toContain("Sections not written: c.ts.");
		expect(fs.get("a.ts")).toBe("ONE\n");
		expect(fs.get("b.ts")).toBe("two\n");
		expect(fs.get("c.ts")).toBe("three\n");
	});

	it("rejects empty multi-section body (no-op) per section without writing siblings", async () => {
		const { fs, snapshots, tags } = setup({ "a.ts": "keep\n", "b.ts": "change-me\n" });
		const patcher = new Patcher({ fs, snapshots });
		// a.ts swap to identical content is a no-op; b would be valid if reached.
		const patch = Patch.parse(
			[
				`[a.ts#${tags["a.ts"]}]`,
				"SWAP 1.=1:",
				"+keep",
				`[b.ts#${tags["b.ts"]}]`,
				"SWAP 1.=1:",
				"+changed",
			].join("\n"),
		);
		await expect(patcher.apply(patch)).rejects.toThrow(/no changes/i);
		expect(fs.get("a.ts")).toBe("keep\n");
		expect(fs.get("b.ts")).toBe("change-me\n");
	});

	it("BOM-preserving file keeps leading EF BB BF after a non-first-line edit", async () => {
		const bom = "\uFEFF";
		const body = `${bom}first\nsecond\n`;
		const { fs, snapshots, tags } = setup({ "bom.ts": body });
		const patcher = new Patcher({ fs, snapshots });
		await patcher.apply(
			Patch.parse([`[bom.ts#${tags["bom.ts"]}]`, "SWAP 2.=2:", "+SECOND"].join("\n")),
		);
		const out = fs.get("bom.ts");
		expect(out.startsWith(bom)).toBe(true);
		expect(out).toBe(`${bom}first\nSECOND\n`);
	});

	it("three-file batch with delete + insert + replace all land or none do on tag mismatch", async () => {
		const { fs, snapshots, tags } = setup({
			"del.ts": "a\nb\nc\n",
			"ins.ts": "only\n",
			"rep.ts": "old\n",
		});
		const patcher = new Patcher({ fs, snapshots });
		const good = Patch.parse(
			[
				`[del.ts#${tags["del.ts"]}]`,
				"DEL 2.=2",
				`[ins.ts#${tags["ins.ts"]}]`,
				"INS.POST 1:",
				"+extra",
				`[rep.ts#${tags["rep.ts"]}]`,
				"SWAP 1.=1:",
				"+new",
			].join("\n"),
		);
		const ok = await patcher.apply(good);
		expect(ok.sections).toHaveLength(3);
		expect(fs.get("del.ts")).toBe("a\nc\n");
		expect(fs.get("ins.ts")).toBe("only\nextra\n");
		expect(fs.get("rep.ts")).toBe("new\n");

		// Second batch: poison one tag, ensure no further mutation of the trio.
		const before = {
			del: fs.get("del.ts"),
			ins: fs.get("ins.ts"),
			rep: fs.get("rep.ts"),
		};
		// Re-record tags from current content for a realistic follow-up batch.
		const tags2 = {
			"del.ts": snapshots.record("del.ts", before.del),
			"ins.ts": snapshots.record("ins.ts", before.ins),
			"rep.ts": "0000",
		};
		const bad = Patch.parse(
			[
				`[del.ts#${tags2["del.ts"]}]`,
				"DEL 1",
				`[ins.ts#${tags2["ins.ts"]}]`,
				"SWAP 1.=1:",
				"+nope",
				`[rep.ts#${tags2["rep.ts"]}]`,
				"SWAP 1.=1:",
				"+poison",
			].join("\n"),
		);
		await expect(patcher.apply(bad)).rejects.toThrow();
		expect(fs.get("del.ts")).toBe(before.del);
		expect(fs.get("ins.ts")).toBe(before.ins);
		expect(fs.get("rep.ts")).toBe(before.rep);
	});
});
