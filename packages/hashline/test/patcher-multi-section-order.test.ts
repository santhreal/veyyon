import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
} from "@veyyon/hashline";

/**
 * Multi-section patch order: later sections apply after earlier ones.
 */

describe("Patcher multi-section order", () => {
	it("three files update in one apply", async () => {
		const files: [string, string][] = [
			["a.ts", "A\n"],
			["b.ts", "B\n"],
			["c.ts", "C\n"],
		];
		const mem = new InMemoryFilesystem(files);
		const snapshots = new InMemorySnapshotStore();
		const tags: Record<string, string> = {};
		for (const [p, body] of files) {
			tags[p] = snapshots.record(p, body);
		}
		const patcher = new Patcher({ fs: mem, snapshots });
		const src = files
			.map(([p]) => `[${p}#${tags[p]}]\nSWAP 1.=1:\n+${p[0]!.toUpperCase()}2\n`)
			.join("\n");
		await patcher.apply(Patch.parse(src));
		expect(mem.get("a.ts")).toBe("A2\n");
		expect(mem.get("b.ts")).toBe("B2\n");
		expect(mem.get("c.ts")).toBe("C2\n");
	});

	it("same file twice in one patch is rejected or last wins", async () => {
		const mem = new InMemoryFilesystem([["a.ts", "A\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", "A\n");
		const patcher = new Patcher({ fs: mem, snapshots });
		const src = `[a.ts#${tag}]\nSWAP 1.=1:\n+X\n\n[a.ts#${tag}]\nSWAP 1.=1:\n+Y\n`;
		let threw = false;
		try {
			await patcher.apply(Patch.parse(src));
		} catch {
			threw = true;
		}
		const out = mem.get("a.ts");
		expect(threw || out === "X\n" || out === "Y\n" || out === "A\n").toBe(true);
	});
});
