/**
 * Shell-like body content with pipes, redirects, dollars is opaque.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits shell-like body content", () => {
	const bodies = [
		"echo hello | grep h",
		"cmd > /tmp/out 2>&1",
		'export FOO="$BAR"',
		"[[ -f file ]] && true",
		"$(command)",
		"`backticks`",
	];
	for (const body of bodies) {
		it(JSON.stringify(body), () => {
			const { text } = applyEdits("old", parsePatch(`SWAP 1.=1:\n+${body}`).edits);
			expect(text).toBe(body);
		});
	}
});
