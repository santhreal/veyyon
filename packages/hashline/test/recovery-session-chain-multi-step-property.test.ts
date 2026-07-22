/**
 * Recovery session chain: apply edit via recovery after external drift, then
 * a second recovery step on the new head after another drift.
 */
import { describe, expect, it } from "bun:test";
import {
	applyEdits,
	InMemorySnapshotStore,
	parsePatch,
	Recovery,
} from "@veyyon/hashline";

describe("Recovery session chain multi-step property", () => {
	it("two sequential recoveries after independent prefix drifts", () => {
		const store = new InMemorySnapshotStore();
		let text = "a\nb\nc\nd\ne";
		const h0 = store.record("f.ts", text);
		// external prefix
		text = `PRE0\n${text}`;
		const r = new Recovery(store);
		const rec1 = r.tryRecover({
			path: "f.ts",
			currentText: text,
			fileHash: h0,
			edits: parsePatch("SWAP 2.=2:\n+B").edits,
		});
		expect(rec1).not.toBeNull();
		text = rec1!.text;
		expect(text.startsWith("PRE0\n")).toBe(true);
		// original line 2 was "b" → remapped after prefix
		expect(text.split("\n")).toContain("B");
		expect(text.split("\n")).not.toContain("b");
		const h1 = store.record("f.ts", text);

		// another prefix
		text = `PRE1\n${text}`;
		const rec2 = r.tryRecover({
			path: "f.ts",
			currentText: text,
			fileHash: h1,
			edits: parsePatch("SWAP 1.=1:\n+C").edits,
		});
		// SWAP 1 against pre-second-drift content is PRE0 after first recovery
		expect(rec2).not.toBeNull();
		expect(rec2!.text.startsWith("PRE1\n")).toBe(true);
		expect(rec2!.text.split("\n")).toContain("C");
	});

	for (const steps of [2, 3, 4]) {
		it(`${steps}-step unique line SWAP chain with suffix drift`, () => {
			const store = new InMemorySnapshotStore();
			let text = Array.from({ length: 8 }, (_, i) => `U${i + 1}`).join("\n");
			const r = new Recovery(store);
			for (let s = 0; s < steps; s++) {
				const h = store.record("c.ts", text);
				text = `${text}\nSUF${s}`;
				const target = 2 + s;
				const rec = r.tryRecover({
					path: "c.ts",
					currentText: text,
					fileHash: h,
					edits: parsePatch(`SWAP ${target}.=${target}:\n+M${s}`).edits,
				});
				expect(rec).not.toBeNull();
				text = rec!.text;
				expect(text.split("\n")).toContain(`M${s}`);
			}
		});
	}
});
