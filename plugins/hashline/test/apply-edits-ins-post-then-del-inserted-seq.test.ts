/**
 * Sequential INS.POST then DEL the inserted line.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits POST then DEL inserted sequential", () => {
	for (const anchor of [1, 2, 3]) {
		it(`anchor ${anchor}`, () => {
			const base = ["a", "b", "c"];
			const t1 = applyEdits(base.join("\n"), parsePatch(`INS.POST ${anchor}:\n+X`).edits).text;
			expect(t1.split("\n")).toContain("X");
			// X is at anchor+1
			const t2 = applyEdits(t1, parsePatch(`DEL ${anchor + 1}`).edits).text;
			expect(t2).toBe(base.join("\n"));
		});
	}
});
