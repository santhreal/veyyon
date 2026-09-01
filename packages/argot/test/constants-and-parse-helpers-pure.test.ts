import { describe, expect, it } from "bun:test";
import {
	ARGOT_LOAD_TOOL,
	ARGOT_UNLOAD_TOOL,
	DEFAULT_SAVINGS_COVERAGE,
	DEFAULT_SIGIL,
	DEFAULT_TOKEN_BUDGET,
	DICT_FILENAME,
	GENERATOR_REVISION,
	HANDLE_NAME_CHAR_RE,
	HANDLE_NAME_RE,
	MAX_EXPANSION_BYTES,
	SIGIL_FORBIDDEN_RE,
	SUPPORTED_VERSION,
} from "../src/constants";
import { ArgotParseError, parseDict } from "../src/parse";

describe("constants", () => {
	it("SUPPORTED_VERSION is 1", () => {
		expect(SUPPORTED_VERSION).toBe(1);
	});
	it("DEFAULT_SIGIL is §", () => {
		expect(DEFAULT_SIGIL).toBe("§");
	});
	it("DEFAULT_TOKEN_BUDGET is 1000", () => {
		expect(DEFAULT_TOKEN_BUDGET).toBe(1000);
	});
	it("DEFAULT_SAVINGS_COVERAGE is 0.9", () => {
		expect(DEFAULT_SAVINGS_COVERAGE).toBe(0.9);
	});
	it("GENERATOR_REVISION is 3", () => {
		expect(GENERATOR_REVISION).toBe(3);
	});
	it("HANDLE_NAME_RE matches valid handle names", () => {
		expect(HANDLE_NAME_RE.test("abc")).toBe(true);
		expect(HANDLE_NAME_RE.test("abc123")).toBe(true);
		expect(HANDLE_NAME_RE.test("abc_def")).toBe(true);
		expect(HANDLE_NAME_RE.test("a")).toBe(true);
		expect(HANDLE_NAME_RE.test("123")).toBe(true);
	});
	it("HANDLE_NAME_RE rejects invalid handle names", () => {
		expect(HANDLE_NAME_RE.test("ABC")).toBe(false);
		expect(HANDLE_NAME_RE.test("abc-def")).toBe(false);
		expect(HANDLE_NAME_RE.test("abc.def")).toBe(false);
		expect(HANDLE_NAME_RE.test("")).toBe(false);
		expect(HANDLE_NAME_RE.test(" abc")).toBe(false);
	});
	it("HANDLE_NAME_CHAR_RE matches valid chars", () => {
		expect(HANDLE_NAME_CHAR_RE.test("a")).toBe(true);
		expect(HANDLE_NAME_CHAR_RE.test("0")).toBe(true);
		expect(HANDLE_NAME_CHAR_RE.test("_")).toBe(true);
	});
	it("HANDLE_NAME_CHAR_RE rejects invalid chars", () => {
		expect(HANDLE_NAME_CHAR_RE.test("A")).toBe(false);
		expect(HANDLE_NAME_CHAR_RE.test("-")).toBe(false);
		expect(HANDLE_NAME_CHAR_RE.test(" ")).toBe(false);
	});
	it("SIGIL_FORBIDDEN_RE rejects lowercase letters", () => {
		expect(SIGIL_FORBIDDEN_RE.test("a")).toBe(true);
		expect(SIGIL_FORBIDDEN_RE.test("z")).toBe(true);
	});
	it("SIGIL_FORBIDDEN_RE rejects digits", () => {
		expect(SIGIL_FORBIDDEN_RE.test("0")).toBe(true);
		expect(SIGIL_FORBIDDEN_RE.test("9")).toBe(true);
	});
	it("SIGIL_FORBIDDEN_RE rejects underscore and whitespace", () => {
		expect(SIGIL_FORBIDDEN_RE.test("_")).toBe(true);
		expect(SIGIL_FORBIDDEN_RE.test(" ")).toBe(true);
		expect(SIGIL_FORBIDDEN_RE.test("\t")).toBe(true);
	});
	it("SIGIL_FORBIDDEN_RE accepts non-alphanumeric sigils", () => {
		expect(SIGIL_FORBIDDEN_RE.test("§")).toBe(false);
		expect(SIGIL_FORBIDDEN_RE.test("@")).toBe(false);
		expect(SIGIL_FORBIDDEN_RE.test("#")).toBe(false);
	});
	it("MAX_EXPANSION_BYTES is 8192", () => {
		expect(MAX_EXPANSION_BYTES).toBe(8192);
	});
	it("DICT_FILENAME is AGENTS.dict", () => {
		expect(DICT_FILENAME).toBe("AGENTS.dict");
	});
	it("ARGOT_LOAD_TOOL is argot_load", () => {
		expect(ARGOT_LOAD_TOOL).toBe("argot_load");
	});
	it("ARGOT_UNLOAD_TOOL is argot_unload", () => {
		expect(ARGOT_UNLOAD_TOOL).toBe("argot_unload");
	});
});

describe("parseDict", () => {
	it("parses valid dict with handles", () => {
		const toml = `version = 1\n[handles]\nfoo = "bar"`;
		const result = parseDict(toml, "test.dict");
		expect(result.version).toBe(1);
		expect(result.sigil).toBe("§");
		expect(result.handles.get("foo")).toBe("bar");
	});
	it("parses dict with custom sigil", () => {
		const toml = `version = 1\nsigil = "@"\n[handles]\nfoo = "bar"`;
		const result = parseDict(toml, "test.dict");
		expect(result.sigil).toBe("@");
	});
	it("parses dict with meta", () => {
		const toml = `version = 1\n[handles]\nfoo = "bar"\n[meta.foo]\nnote = "a note"\nscope = "global"`;
		const result = parseDict(toml, "test.dict");
		const meta = result.meta.get("foo");
		expect(meta?.note).toBe("a note");
		expect(meta?.scope).toBe("global");
	});
	it("throws on invalid TOML", () => {
		expect(() => parseDict("not toml {{{", "test.dict")).toThrow(ArgotParseError);
	});
	it("throws on missing version", () => {
		expect(() => parseDict('[handles]\nfoo = "bar"', "test.dict")).toThrow(ArgotParseError);
	});
	it("throws on non-integer version", () => {
		expect(() => parseDict('version = 1.5\n[handles]\nfoo = "bar"', "test.dict")).toThrow(ArgotParseError);
	});
	it("throws on version < 1", () => {
		expect(() => parseDict('version = 0\n[handles]\nfoo = "bar"', "test.dict")).toThrow(ArgotParseError);
	});
	it("throws on unsupported version", () => {
		expect(() => parseDict('version = 2\n[handles]\nfoo = "bar"', "test.dict")).toThrow(ArgotParseError);
	});
	it("throws on non-string sigil", () => {
		expect(() => parseDict('version = 1\nsigil = 42\n[handles]\nfoo = "bar"', "test.dict")).toThrow(ArgotParseError);
	});
	it("throws on empty sigil", () => {
		expect(() => parseDict('version = 1\nsigil = ""\n[handles]\nfoo = "bar"', "test.dict")).toThrow(ArgotParseError);
	});
	it("throws on sigil with forbidden chars", () => {
		expect(() => parseDict('version = 1\nsigil = "a"\n[handles]\nfoo = "bar"', "test.dict")).toThrow(ArgotParseError);
	});
	it("throws on missing handles table", () => {
		expect(() => parseDict("version = 1", "test.dict")).toThrow(ArgotParseError);
	});
	it("throws on handles not a table", () => {
		expect(() => parseDict('version = 1\nhandles = "not a table"', "test.dict")).toThrow(ArgotParseError);
	});
	it("throws on invalid handle name", () => {
		expect(() => parseDict('version = 1\n[handles]\n"FOO" = "bar"', "test.dict")).toThrow(ArgotParseError);
	});
	it("throws on non-string expansion", () => {
		expect(() => parseDict("version = 1\n[handles]\nfoo = 42", "test.dict")).toThrow(ArgotParseError);
	});
	it("throws on empty expansion", () => {
		expect(() => parseDict('version = 1\n[handles]\nfoo = ""', "test.dict")).toThrow(ArgotParseError);
	});
	it("throws on expansion containing sigil", () => {
		expect(() => parseDict('version = 1\n[handles]\nfoo = "§bar"', "test.dict")).toThrow(ArgotParseError);
	});
	it("throws on no handles defined", () => {
		expect(() => parseDict("version = 1\n[handles]", "test.dict")).toThrow(ArgotParseError);
	});
	it("throws on meta referencing undefined handle", () => {
		const toml = `version = 1\n[handles]\nfoo = "bar"\n[meta.baz]\nnote = "x"`;
		expect(() => parseDict(toml, "test.dict")).toThrow(ArgotParseError);
	});
	it("throws on meta entry not a table", () => {
		const toml = `version = 1\n[handles]\nfoo = "bar"\n[meta.foo]\n42`;
		expect(() => parseDict(toml, "test.dict")).toThrow(ArgotParseError);
	});
	it("throws on meta note not a string", () => {
		const toml = `version = 1\n[handles]\nfoo = "bar"\n[meta.foo]\nnote = 42`;
		expect(() => parseDict(toml, "test.dict")).toThrow(ArgotParseError);
	});
	it("throws on meta scope not a string", () => {
		const toml = `version = 1\n[handles]\nfoo = "bar"\n[meta.foo]\nscope = 42`;
		expect(() => parseDict(toml, "test.dict")).toThrow(ArgotParseError);
	});
	it("returns empty meta when no meta table", () => {
		const toml = `version = 1\n[handles]\nfoo = "bar"`;
		const result = parseDict(toml, "test.dict");
		expect(result.meta.size).toBe(0);
	});
	it("handles multiple handles", () => {
		const toml = `version = 1\n[handles]\nfoo = "bar"\nbaz = "qux"`;
		const result = parseDict(toml, "test.dict");
		expect(result.handles.size).toBe(2);
		expect(result.handles.get("foo")).toBe("bar");
		expect(result.handles.get("baz")).toBe("qux");
	});
	it("ArgotParseError has source property", () => {
		try {
			parseDict("version = 1", "my.dict");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ArgotParseError);
			expect((err as ArgotParseError).source).toBe("my.dict");
		}
	});
});
