/**
 * Tokenizer.tokenize header paths with hashes.
 */
import { describe, expect, it } from "bun:test";
import { Tokenizer } from "../src/tokenizer";
import { formatHashlineHeader } from "../src/format";

const tok = new Tokenizer();

describe("Tokenizer.tokenize header matrix", () => {
	const paths = ["a.ts", "src/b.ts", "x-y.ts", "under_score.ts"];
	for (const p of paths) {
		it(`header ${p}`, () => {
			const line = formatHashlineHeader(p, "ABCD");
			const t = tok.tokenize(line);
			expect(t.kind).toBe("header");
			if (t.kind === "header") {
				expect(t.path).toBe(p);
				expect(t.fileHash).toBe("ABCD");
			}
		});
	}

	it("header without hash", () => {
		const t = tok.tokenize("[bare.ts]");
		expect(t.kind).toBe("header");
		if (t.kind === "header") {
			expect(t.path).toBe("bare.ts");
			expect(t.fileHash).toBeUndefined();
		}
	});
});
