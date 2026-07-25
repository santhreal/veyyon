import { describe, expect, test } from "bun:test";
import { emptyDict, makeDict, makeExpander } from "../src/codec.js";
import { parseDict } from "../src/parse.js";

function expander(toml: string): (text: string) => string {
	return makeExpander(parseDict(toml, "AGENTS.dict"));
}

const BASE = `version = 1
[handles]
dbconn = "packages/server/src/database/connection.ts"
db = "packages/server/src/database"
tsc = "bunx tsgo --noEmit"
`;

describe("expand", () => {
	test("replaces a handle with its exact expansion", () => {
		const expand = expander(BASE);
		expect(expand("open §dbconn now")).toBe("open packages/server/src/database/connection.ts now");
	});

	test("prefers the longest matching handle at a boundary", () => {
		const expand = expander(BASE);
		// §dbconn must win over §db even though §db is also a handle.
		expect(expand("§dbconn")).toBe("packages/server/src/database/connection.ts");
		expect(expand("§db")).toBe("packages/server/src/database");
	});

	test("does not expand a handle that runs into more name characters", () => {
		const expand = expander(BASE);
		// §dbextra is not a handle; §db must not fire and leave "extra" dangling.
		expect(expand("§dbextra")).toBe("§dbextra");
	});

	test("leaves an unknown handle untouched", () => {
		const expand = expander(BASE);
		expect(expand("§nope stays")).toBe("§nope stays");
	});

	test("expands multiple handles and repeats in one pass", () => {
		const expand = expander(BASE);
		expect(expand("§tsc then §tsc then §db")).toBe(
			"bunx tsgo --noEmit then bunx tsgo --noEmit then packages/server/src/database",
		);
	});

	test("is idempotent: expanded text has no handles left to change", () => {
		const expand = expander(BASE);
		const once = expand("§dbconn and §tsc");
		expect(expand(once)).toBe(once);
	});

	test("honors a custom sigil and ignores the default one", () => {
		const expand = expander(`version = 1
sigil = "@@"
[handles]
db = "x/y/z"
`);
		expect(expand("@@db")).toBe("x/y/z");
		expect(expand("§db")).toBe("§db");
	});

	test("empty dict expand is identity", () => {
		const d = emptyDict();
		expect(d.expand("§db untouched")).toBe("§db untouched");
	});

	test("makeDict wires expand to the vocabulary", () => {
		const d = makeDict(parseDict(BASE, "AGENTS.dict"));
		expect(d.expand("§dbconn")).toBe("packages/server/src/database/connection.ts");
	});
});
