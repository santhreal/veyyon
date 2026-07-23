import { describe, expect, test } from "bun:test";
import { ArgotParseError, parseDict } from "../src/parse.js";

const S = "AGENTS.dict";

describe("parseDict: valid dicts", () => {
	test("parses version, sigil, and handles in file order", () => {
		const vocab = parseDict(
			`version = 1
sigil = "§"

[handles]
dbconn = "packages/server/src/database/connection.ts"
tsc = "bunx tsgo --noEmit"
`,
			S,
		);
		expect(vocab.version).toBe(1);
		expect(vocab.sigil).toBe("§");
		expect([...vocab.handles.keys()]).toEqual(["dbconn", "tsc"]);
		expect(vocab.handles.get("dbconn")).toBe("packages/server/src/database/connection.ts");
		expect(vocab.handles.get("tsc")).toBe("bunx tsgo --noEmit");
		expect(vocab.meta.size).toBe(0);
	});

	test("defaults the sigil to § when omitted", () => {
		const vocab = parseDict(
			`version = 1
[handles]
db = "x/y/z.ts"
`,
			S,
		);
		expect(vocab.sigil).toBe("§");
	});

	test("accepts a custom sigil", () => {
		const vocab = parseDict(
			`version = 1
sigil = "@@"
[handles]
db = "x/y/z.ts"
`,
			S,
		);
		expect(vocab.sigil).toBe("@@");
	});

	test("parses [meta] notes and scope for existing handles", () => {
		const vocab = parseDict(
			`version = 1
[handles]
db = "x/y/z.ts"
[meta.db]
note = "the one database entrypoint"
scope = "packages/server/**"
`,
			S,
		);
		expect(vocab.meta.get("db")).toEqual({
			note: "the one database entrypoint",
			scope: "packages/server/**",
		});
	});
});

describe("parseDict: invalid dicts fail loud", () => {
	test("rejects non-TOML content", () => {
		expect(() => parseDict("this is not = = toml", S)).toThrow(ArgotParseError);
	});

	test("rejects a missing version", () => {
		expect(() => parseDict(`[handles]\ndb = "x"\n`, S)).toThrow(/missing `version`/);
	});

	test("rejects a non-integer version", () => {
		expect(() => parseDict(`version = 1.5\n[handles]\ndb = "x"\n`, S)).toThrow(/`version` must be an integer/);
	});

	test("rejects a future version rather than guessing", () => {
		expect(() => parseDict(`version = 999\n[handles]\ndb = "x"\n`, S)).toThrow(/version 999/);
	});

	test("rejects a missing [handles] table", () => {
		expect(() => parseDict(`version = 1\n`, S)).toThrow(/missing `\[handles\]`/);
	});

	test("rejects an empty [handles] table", () => {
		expect(() => parseDict(`version = 1\n[handles]\n`, S)).toThrow(/defines no handles/);
	});

	test("rejects a handle name with uppercase or punctuation", () => {
		expect(() => parseDict(`version = 1\n[handles]\nDbConn = "x"\n`, S)).toThrow(/must match/);
		expect(() => parseDict(`version = 1\n[handles]\n"db-conn" = "x"\n`, S)).toThrow(/must match/);
	});

	test("rejects a non-string expansion", () => {
		expect(() => parseDict(`version = 1\n[handles]\ndb = 42\n`, S)).toThrow(/must expand to a string/);
	});

	test("rejects an empty expansion", () => {
		expect(() => parseDict(`version = 1\n[handles]\ndb = ""\n`, S)).toThrow(/must not expand to an empty string/);
	});

	test("rejects an expansion over the byte limit", () => {
		const big = "a".repeat(9000);
		expect(() => parseDict(`version = 1\n[handles]\ndb = "${big}"\n`, S)).toThrow(/over the 8192-byte limit/);
	});

	test("rejects an expansion that contains the sigil, so expansion stays one pass", () => {
		expect(() => parseDict(`version = 1\n[handles]\na = "see §b instead"\nb = "x"\n`, S)).toThrow(
			/containing the sigil/,
		);
	});

	test("checks expansions against the custom sigil, not the default", () => {
		// The default § is fine here, but the declared sigil @@ is present, so reject.
		expect(() => parseDict(`version = 1\nsigil = "@@"\n[handles]\na = "path/@@b"\n`, S)).toThrow(
			/containing the sigil/,
		);
		// And an expansion with a bare § is allowed when the sigil is @@.
		const vocab = parseDict(`version = 1\nsigil = "@@"\n[handles]\na = "the § symbol"\n`, S);
		expect(vocab.handles.get("a")).toBe("the § symbol");
	});

	test("rejects an empty sigil", () => {
		expect(() => parseDict(`version = 1\nsigil = ""\n[handles]\ndb = "x"\n`, S)).toThrow(/must not be empty/);
	});

	test("rejects a sigil containing a letter", () => {
		expect(() => parseDict(`version = 1\nsigil = "x"\n[handles]\ndb = "y"\n`, S)).toThrow(/must not contain/);
	});

	test("rejects [meta] for an unknown handle", () => {
		expect(() => parseDict(`version = 1\n[handles]\ndb = "x"\n[meta.other]\nnote = "n"\n`, S)).toThrow(
			/not defined in \[handles\]/,
		);
	});

	test("names the source file in the message", () => {
		try {
			parseDict(`version = 1\n`, "/repo/AGENTS.dict");
			throw new Error("expected a throw");
		} catch (err) {
			expect(err).toBeInstanceOf(ArgotParseError);
			expect((err as ArgotParseError).message).toContain("/repo/AGENTS.dict");
			expect((err as ArgotParseError).source).toBe("/repo/AGENTS.dict");
		}
	});
});
