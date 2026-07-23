/**
 * 0-9 file: DEL primes, SWAP rest.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits digits file ops", () => {
	const base = "0\n1\n2\n3\n4\n5\n6\n7\n8\n9";

	it("DEL primes 2,3,5,7", () => {
		// lines: 1=0, 2=1, 3=2, 4=3, 5=4, 6=5, 7=6, 8=7, 9=8, 10=9
		const { text } = applyEdits(base, parsePatch("DEL 3\nDEL 4\nDEL 6\nDEL 8").edits);
		expect(text.split("\n")).toEqual(["0", "1", "4", "6", "8", "9"]);
	});

	it("SWAP all to double", () => {
		const patch = Array.from({ length: 10 }, (_, i) => `SWAP ${i + 1}.=${i + 1}:\n+${i}${i}`).join("\n");
		const { text } = applyEdits(base, parsePatch(patch).edits);
		expect(text.split("\n")).toEqual(Array.from({ length: 10 }, (_, i) => `${i}${i}`));
	});
});
