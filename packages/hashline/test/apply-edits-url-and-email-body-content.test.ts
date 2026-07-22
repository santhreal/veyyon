/**
 * URLs and emails in body are opaque content.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits URL and email body content", () => {
	const bodies = [
		"https://example.com/path?q=1",
		"http://localhost:8080/",
		"mailto:user@example.com",
		"user@example.com",
		"git@github.com:org/repo.git",
		"file:///tmp/x",
	];
	for (const body of bodies) {
		it(JSON.stringify(body), () => {
			const { text } = applyEdits("old", parsePatch(`SWAP 1.=1:\n+${body}`).edits);
			expect(text).toBe(body);
		});
	}
});
