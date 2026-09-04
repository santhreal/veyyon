/**
 * SQL-like body content with quotes and comments is opaque.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SQL-like body content", () => {
	const bodies = [
		"SELECT * FROM t WHERE id = 1;",
		"INSERT INTO t VALUES ('a', 'b');",
		"-- comment",
		"/* block */",
		"WHERE name LIKE '%x%'",
	];
	for (const body of bodies) {
		it(JSON.stringify(body), () => {
			const { text } = applyEdits("old", parsePatch(`SWAP 1.=1:\n+${body}`).edits);
			expect(text).toBe(body);
		});
	}
});
