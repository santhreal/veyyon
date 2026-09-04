import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@veyyon/hashline";

/**
 * Sequential Patcher.apply calls with fresh tags each time.
 */

describe("Patcher sequential applies", () => {
	it("three sequential SWAPs accumulate", async () => {
		let body = "A\nB\nC\n";
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs: mem, snapshots });

		for (const [line, next] of [
			[1, "A2"],
			[2, "B2"],
			[3, "C2"],
		] as const) {
			body = mem.get("a.ts")!;
			const tag = snapshots.record("a.ts", body);
			await patcher.apply(Patch.parse(`[a.ts#${tag}]\nSWAP ${line}.=${line}:\n+${next}\n`));
		}
		expect(mem.get("a.ts")).toBe("A2\nB2\nC2\n");
	});
});
