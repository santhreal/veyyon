import { describe, expect, it } from "bun:test";
import { computeFileHash, formatHashlineHeader } from "@veyyon/hashline";

/**
 * Symmetry: formatHashlineHeader embeds path and hash extractable by regex.
 */

describe("formatHashlineHeader parse symmetry", () => {
	it("regex extracts path and hash for many samples", () => {
		const samples = [
			["a.ts", "hello\n"],
			["src/b.ts", "world\n"],
			["/tmp/c.ts", "x\ny\n"],
			["日本語.ts", "値\n"],
		] as const;
		for (const [path, body] of samples) {
			const hash = computeFileHash(body);
			const header = formatHashlineHeader(path, hash);
			const m = /^\[(.+)#([0-9A-Fa-f]{4})\]$/.exec(header);
			expect(m).not.toBeNull();
			expect(m![1]).toBe(path);
			expect(m![2]!.toLowerCase()).toBe(hash.toLowerCase());
		}
	});
});
