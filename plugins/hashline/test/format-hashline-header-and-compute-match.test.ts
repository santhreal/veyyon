/**
 * formatHashlineHeader embeds computeFileHash result.
 */
import { describe, expect, it } from "bun:test";
import { computeFileHash, formatHashlineHeader, Patch } from "@veyyon/hashline";

describe("formatHashlineHeader with computeFileHash", () => {
	const bodies = ["", "a", "a\nb\n", "unicode ☃"];
	for (const body of bodies) {
		it(JSON.stringify(body).slice(0, 20), () => {
			const h = computeFileHash(body);
			const header = formatHashlineHeader("f.ts", h);
			const patch = Patch.parse(`${header}\nDEL 1`);
			expect(patch.sections[0]?.fileHash).toBe(h);
		});
	}
});
