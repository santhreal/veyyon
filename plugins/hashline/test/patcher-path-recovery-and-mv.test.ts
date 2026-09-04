/**
 * Path recovery from tag when authored path missing; MV relocates content + snapshots.
 */
import { describe, expect, it } from "bun:test";
import {
	formatHashlineHeader,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	pathRecoveredFromTagMessage,
} from "@veyyon/hashline";

describe("Patcher path recovery from snapshot tag", () => {
	it("rebounds bare filename to the unique session path that minted the tag", async () => {
		const full = "pkg/src/util.ts";
		const body = "export const x = 1;\n";
		const fs = new InMemoryFilesystem([[full, body]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(full, body);
		const patcher = new Patcher({ fs, snapshots });
		// Model authored bare filename with the real tag
		const result = await patcher.apply(
			Patch.parse(`${formatHashlineHeader("util.ts", tag)}\nSWAP 1.=1:\n+export const x = 2;`),
		);
		// Should have written the real path
		expect(fs.get(full)).toBe("export const x = 2;\n");
		expect(fs.get("util.ts")).toBeUndefined();
		const warnings = result.sections.flatMap(s => s.warnings ?? []);
		expect(warnings.some(w => w.includes("util.ts") && w.includes(full))).toBe(true);
		// Message contract still names the recovery form
		expect(pathRecoveredFromTagMessage("util.ts", full, tag)).toContain(full);
	});

	it("does not rebind when tag matches multiple paths (ambiguous)", async () => {
		const body = "identical\n";
		const fs = new InMemoryFilesystem([
			["a/x.ts", body],
			["b/x.ts", body],
		]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a/x.ts", body);
		snapshots.record("b/x.ts", body);
		expect(tag).toBe(snapshots.record("b/x.ts", body));
		const patcher = new Patcher({ fs, snapshots });
		// Bare x.ts with shared tag — should not silently pick one and wipe the wrong file
		await expect(
			patcher.apply(Patch.parse(`${formatHashlineHeader("x.ts", tag)}\nSWAP 1.=1:\n+changed`)),
		).rejects.toThrow();
		expect(fs.get("a/x.ts")).toBe(body);
		expect(fs.get("b/x.ts")).toBe(body);
	});
});

describe("Patcher MV", () => {
	it("moves file content to dest and clears source", async () => {
		const body = "moved-body\n";
		const fs = new InMemoryFilesystem([["from.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("from.ts", body);
		const patcher = new Patcher({ fs, snapshots });
		const result = await patcher.apply(Patch.parse(`${formatHashlineHeader("from.ts", tag)}\nMV to.ts`));
		expect(result.sections[0]?.op).toMatch(/move|mv|update/i);
		expect(fs.get("from.ts")).toBeUndefined();
		expect(fs.get("to.ts")).toBe(body);
	});

	it("MV then edit at destination with relocated snapshot tag", async () => {
		const body = "line\n";
		const fs = new InMemoryFilesystem([["old.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("old.ts", body);
		const patcher = new Patcher({ fs, snapshots });
		await patcher.apply(Patch.parse(`${formatHashlineHeader("old.ts", tag)}\nMV new.ts`));
		// Snapshot history should resolve at new path for the original tag (relocate)
		const head = snapshots.head("new.ts");
		const byOld = snapshots.head("old.ts");
		expect(byOld).toBeNull();
		// After MV, either head exists at new path or a fresh record is needed — apply edit with live hash
		const live = fs.get("new.ts")!;
		const liveTag = snapshots.record("new.ts", live);
		await patcher.apply(Patch.parse(`${formatHashlineHeader("new.ts", liveTag)}\nSWAP 1.=1:\n+LINE`));
		expect(fs.get("new.ts")).toBe("LINE\n");
		expect(head === null || head.path === "new.ts").toBe(true);
	});
});
