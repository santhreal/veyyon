/**
 * computeFileHash normalizes trailing [space/tab/CR] per line before hashing.
 * Property: adding trailing spaces/tabs/CR on any lines must not change the tag.
 */
import { describe, expect, it } from "bun:test";
import { computeFileHash, HL_FILE_HASH_LENGTH } from "@veyyon/hashline";

describe("computeFileHash trailing-ws normalize property", () => {
	const bodies = [
		"a",
		"a\nb",
		"a\nb\nc\n",
		"line with spaces",
		"\n\n",
		"x\n\ny",
	];

	for (const body of bodies) {
		it(`tag length and case for ${JSON.stringify(body)}`, () => {
			const h = computeFileHash(body);
			expect(h).toHaveLength(HL_FILE_HASH_LENGTH);
			expect(h).toMatch(/^[0-9A-F]+$/);
		});

		it(`trailing spaces ignored: ${JSON.stringify(body)}`, () => {
			const spaced = body
				.split("\n")
				.map(l => `${l}   `)
				.join("\n");
			expect(computeFileHash(spaced)).toBe(computeFileHash(body));
		});

		it(`trailing tabs ignored: ${JSON.stringify(body)}`, () => {
			const tabbed = body
				.split("\n")
				.map(l => `${l}\t\t`)
				.join("\n");
			expect(computeFileHash(tabbed)).toBe(computeFileHash(body));
		});

		it(`CRLF trailing CR stripped via normalize: ${JSON.stringify(body)}`, () => {
			// bare CR at EOL is stripped by the trailing-ws pass
			const withCr = body
				.split("\n")
				.map(l => `${l}\r`)
				.join("\n");
			expect(computeFileHash(withCr)).toBe(computeFileHash(body));
		});
	}

	it("content change changes hash", () => {
		expect(computeFileHash("a")).not.toBe(computeFileHash("b"));
		expect(computeFileHash("a\nb")).not.toBe(computeFileHash("a\nc"));
	});

	it("stable across repeated calls", () => {
		const t = "stable\ncontent\n";
		expect(computeFileHash(t)).toBe(computeFileHash(t));
	});
});
