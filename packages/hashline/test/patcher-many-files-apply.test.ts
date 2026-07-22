import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
} from "@veyyon/hashline";

/**
 * Patcher applies a patch touching many files.
 */

describe("Patcher many files apply", () => {
	it("updates 20 files in one patch", async () => {
		const n = 20;
		const files: [string, string][] = Array.from({ length: n }, (_, i) => [
			`f${i}.ts`,
			`v0-${i}\n`,
		]);
		const mem = new InMemoryFilesystem(files);
		const snapshots = new InMemorySnapshotStore();
		const tags: string[] = [];
		for (const [p, body] of files) {
			tags.push(snapshots.record(p, body));
		}
		const sections = files
			.map(([p], i) => `[${p}#${tags[i]}]\nSWAP 1.=1:\n+v1-${i}\n`)
			.join("\n");
		const patcher = new Patcher({ fs: mem, snapshots });
		await patcher.apply(Patch.parse(sections));
		for (let i = 0; i < n; i++) {
			expect(mem.get(`f${i}.ts`)).toBe(`v1-${i}\n`);
		}
	});
});
