/**
 * formatHashlineHeader + Patch.parse path/hash identity.
 */
import { describe, expect, it } from "bun:test";
import { computeFileHash, formatHashlineHeader, Patch } from "@veyyon/hashline";

describe("formatHashlineHeader Patch.parse identity", () => {
	const paths = ["a.ts", "src/foo/bar.ts", "pkg-name/x.tsx", "under_score.ts"];
	for (const p of paths) {
		it(`path ${p}`, () => {
			const hash = computeFileHash("content\n");
			const header = formatHashlineHeader(p, hash);
			const patch = Patch.parse(`${header}\nDEL 1`);
			expect(patch.sections).toHaveLength(1);
			expect(patch.sections[0]?.path).toBe(p);
			expect(patch.sections[0]?.fileHash).toBe(hash);
		});
	}

	it("uppercase hash preserved", () => {
		const header = formatHashlineHeader("x.ts", "AbCd");
		// format does not force case; parse uppercases
		const patch = Patch.parse(`${header}\nDEL 1`);
		expect(patch.sections[0]?.fileHash).toBe("ABCD");
	});
});
