/**
 * content-type.test.ts already pins last-suffix (a.md.json vs a.json.md) and
 * fallback-to-plain. Remaining traps: a trailing-dot path whose extname is
 * `.`, and `.markdown` / `.jsonc` which are not in the two-type table.
 */
import { describe, expect, it } from "bun:test";
import { getContentType } from "@veyyon/coding-agent/internal-urls/content-type";

describe("extname traps the last-suffix suite does not name", () => {
	it("treats 'notes.md.' as plain because extname is '.'", () => {
		expect(getContentType("notes.md.")).toBe("text/plain");
	});

	it("treats .markdown / .jsonc as plain (not in the two-type table)", () => {
		expect(getContentType("notes.markdown")).toBe("text/plain");
		expect(getContentType("tsconfig.jsonc")).toBe("text/plain");
	});
});
