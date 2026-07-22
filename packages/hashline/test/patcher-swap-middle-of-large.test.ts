import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
} from "@veyyon/hashline";

/**
 * Patcher SWAP middle of a larger file.
 */

describe("Patcher SWAP middle of large file", () => {
	it("swaps line 50 of 100", async () => {
		const lines = Array.from({ length: 100 }, (_, i) => `L${i + 1}`);
		const body = `${lines.join("\n")}\n`;
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", body);
		const patcher = new Patcher({ fs: mem, snapshots });
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nSWAP 50.=50:\n+MID\n`));
		const out = mem.get("a.ts")!;
		const result = out.split("\n").filter((l, i, a) => i < a.length - 1 || l);
		expect(result).toHaveLength(100);
		expect(result[49]).toBe("MID");
		expect(result[0]).toBe("L1");
		expect(result[99]).toBe("L100");
	});
});
