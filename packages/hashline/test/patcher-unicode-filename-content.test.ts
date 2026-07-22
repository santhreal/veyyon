/**
 * Patcher on unicode path and content.
 */
import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	formatHashlineHeader,
} from "@veyyon/hashline";

describe("Patcher unicode path and content", () => {
	it("edits 日本語 path", async () => {
		const path = "docs/日本語.ts";
		const content = "const x = 1;\n";
		const fs = new InMemoryFilesystem([[path, content]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(path, content);
		const patcher = new Patcher({ fs, snapshots });
		await patcher.apply(
			Patch.parse(`${formatHashlineHeader(path, tag)}\nSWAP 1.=1:\n+const x = 2;`),
		);
		expect(fs.get(path)).toBe("const x = 2;\n");
	});

	it("emoji body", async () => {
		const path = "a.ts";
		const content = "old\n";
		const fs = new InMemoryFilesystem([[path, content]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(path, content);
		const patcher = new Patcher({ fs, snapshots });
		await patcher.apply(
			Patch.parse(`${formatHashlineHeader(path, tag)}\nSWAP 1.=1:\n+🚀 ship`),
		);
		expect(fs.get(path)).toBe("🚀 ship\n");
	});
});
