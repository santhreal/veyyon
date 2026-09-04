/**
 * Patcher expand then contract with hash chain.
 */
import { describe, expect, it } from "bun:test";
import { formatHashlineHeader, InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@veyyon/hashline";

describe("Patcher expand then contract session", () => {
	it("expand mid line then shrink back", async () => {
		const content = "a\nb\nc\n";
		const fs = new InMemoryFilesystem([["f.ts", content]]);
		const snapshots = new InMemorySnapshotStore();
		let tag = snapshots.record("f.ts", content);
		const patcher = new Patcher({ fs, snapshots });

		let r = await patcher.apply(Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nSWAP 2.=2:\n+B1\n+B2\n+B3`));
		expect(fs.get("f.ts")).toBe("a\nB1\nB2\nB3\nc\n");
		tag = r.sections[0]!.fileHash!;

		r = await patcher.apply(Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nSWAP 2.=4:\n+b`));
		expect(fs.get("f.ts")).toBe("a\nb\nc\n");
	});
});
