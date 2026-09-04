import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@veyyon/hashline";

/**
 * Patcher on unicode path names.
 */

describe("Patcher unicode paths", () => {
	it("applies SWAP to a unicode path", async () => {
		const path = "ソース/main.ts";
		const body = "const 値 = 1;\n";
		const mem = new InMemoryFilesystem([[path, body]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(path, body);
		const patcher = new Patcher({ fs: mem, snapshots });
		await patcher.apply(Patch.parse(`[${path}#${tag}]\nSWAP 1.=1:\n+const 値 = 2;\n`));
		expect(mem.get(path)).toBe("const 値 = 2;\n");
	});
});
