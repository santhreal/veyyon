/**
 * Patcher DEL ranges with valid tags: exact remaining content.
 */
import { describe, expect, it } from "bun:test";
import { formatHashlineHeader, InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@veyyon/hashline";

describe("Patcher DEL range with tags", () => {
	it("DEL 2.=4 on 5-line file", async () => {
		const content = "1\n2\n3\n4\n5\n";
		const fs = new InMemoryFilesystem([["f.ts", content]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("f.ts", content);
		const patcher = new Patcher({ fs, snapshots });
		await patcher.apply(Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nDEL 2.=4`));
		expect(fs.get("f.ts")).toBe("1\n5\n");
	});

	it("DEL entire file range leaves empty or single empty line per phantom rules", async () => {
		const content = "a\nb\n";
		const fs = new InMemoryFilesystem([["f.ts", content]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("f.ts", content);
		const patcher = new Patcher({ fs, snapshots });
		// DEL 1.=2 removes both content lines; trailing newline phantom may remain
		await patcher.apply(Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nDEL 1.=2`));
		const out = fs.get("f.ts")!;
		expect(out === "" || out === "\n").toBe(true);
	});
});
