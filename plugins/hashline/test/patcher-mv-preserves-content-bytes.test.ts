/**
 * MV preserves exact content including unicode and trailing newline shapes.
 */
import { describe, expect, it } from "bun:test";
import { formatHashlineHeader, InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@veyyon/hashline";

describe("Patcher MV preserves content", () => {
	const bodies = ["plain\n", "unicode 日本語\n", "a\nb\nc\n", ""];
	for (const body of bodies) {
		it(JSON.stringify(body).slice(0, 30), async () => {
			const fs = new InMemoryFilesystem([["from.ts", body]]);
			const snapshots = new InMemorySnapshotStore();
			const tag = snapshots.record("from.ts", body);
			const patcher = new Patcher({ fs, snapshots });
			await patcher.apply(Patch.parse(`${formatHashlineHeader("from.ts", tag)}\nMV to.ts`));
			expect(fs.get("from.ts")).toBeUndefined();
			expect(fs.get("to.ts")).toBe(body);
		});
	}
});
