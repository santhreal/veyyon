/**
 * Session chain of INS.POST ops with refreshed hashes after each apply.
 */
import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	formatHashlineHeader,
} from "@veyyon/hashline";

describe("Patcher INS.POST session chain", () => {
	it("three sequential inserts after growing content", async () => {
		const fs = new InMemoryFilesystem([["f.ts", "base\n"]]);
		const snapshots = new InMemorySnapshotStore();
		let tag = snapshots.record("f.ts", "base\n");
		const patcher = new Patcher({ fs, snapshots });

		let r = await patcher.apply(
			Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nINS.POST 1:\n+A`),
		);
		expect(fs.get("f.ts")).toBe("base\nA\n");
		tag = r.sections[0]!.fileHash!;

		r = await patcher.apply(
			Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nINS.POST 2:\n+B`),
		);
		expect(fs.get("f.ts")).toBe("base\nA\nB\n");
		tag = r.sections[0]!.fileHash!;

		r = await patcher.apply(
			Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nINS.POST 3:\n+C`),
		);
		expect(fs.get("f.ts")).toBe("base\nA\nB\nC\n");
	});
});
