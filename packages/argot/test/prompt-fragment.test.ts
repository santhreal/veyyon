import { describe, expect, test } from "bun:test";
import { emptyDict, makePromptFragment } from "../src/codec.js";
import { parseDict } from "../src/parse.js";

function fragment(toml: string): string {
	return makePromptFragment(parseDict(toml, "AGENTS.dict"));
}

describe("promptFragment", () => {
	test("names the mechanism and lists every handle in file order", () => {
		const f = fragment(`version = 1
[handles]
dbconn = "packages/server/src/database/connection.ts"
tsc = "bunx tsgo --noEmit"
`);
		expect(f).toContain("## Project shorthand (Argot)");
		expect(f).toContain("- `§dbconn` → `packages/server/src/database/connection.ts`");
		expect(f).toContain("- `§tsc` → `bunx tsgo --noEmit`");
		// File order: dbconn before tsc.
		expect(f.indexOf("§dbconn")).toBeLessThan(f.indexOf("§tsc"));
	});

	test("uses the custom sigil in the instruction and the listing", () => {
		const f = fragment(`version = 1
sigil = "@@"
[handles]
db = "x/y/z"
`);
		expect(f).toContain("`@@`");
		expect(f).toContain("- `@@db` → `x/y/z`");
		expect(f).not.toContain("§");
	});

	test("empty dict yields the empty string so it can be appended unconditionally", () => {
		expect(emptyDict().promptFragment()).toBe("");
	});
});
