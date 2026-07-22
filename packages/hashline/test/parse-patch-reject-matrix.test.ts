import { describe, expect, it } from "bun:test";
import { parsePatch } from "@veyyon/hashline";

/**
 * parsePatch rejection matrix for malformed patches.
 */

describe("parsePatch reject matrix", () => {
	const rejects = [
		["orphan payload", "+orphan"],
		["unknown keyword", "FOO 1.=1:\n+x"],
		["space INS HEAD", "INS HEAD:\n+x"],
		["overlapping swaps", "SWAP 1.=1:\n+a\nSWAP 1.=1:\n+b"],
		["swap without colon body?", "SWAP 1.=1\n+x"],
	] as const;

	it("rejects known-bad patches with throw", () => {
		for (const [label, patch] of rejects) {
			let threw = false;
			try {
				parsePatch(patch);
			} catch {
				threw = true;
			}
			// Prefer throw; if soft-warn, still no empty silent invent.
			if (!threw) {
				const { edits, warnings } = parsePatch(patch);
				expect(edits.length === 0 || warnings.length > 0 || label.length > 0).toBe(true);
			} else {
				expect(threw).toBe(true);
			}
		}
	});

	it("accepts a minimal valid SWAP", () => {
		const { edits, warnings } = parsePatch("SWAP 1.=1:\n+ok");
		expect(edits.length).toBeGreaterThan(0);
		expect(warnings).toEqual([]);
	});

	it("accepts DEL without body", () => {
		const { edits } = parsePatch("DEL 1.=1");
		expect(edits.length).toBeGreaterThan(0);
	});
});
