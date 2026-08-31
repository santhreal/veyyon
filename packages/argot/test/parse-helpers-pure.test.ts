import { describe, expect, it } from "bun:test";
import { DEFAULT_SIGIL, SUPPORTED_VERSION } from "../src/constants";
import { ArgotParseError, parseDict } from "../src/parse";

describe("parseDict", () => {
	it("parses valid dict with version and handles", () => {
		const toml = `version = 1\n\n[handles]\nfoo = "bar"\n`;
		const result = parseDict(toml, "test.dict");
		expect(result.version).toBe(1);
		expect(result.sigil).toBe(DEFAULT_SIGIL);
		expect(result.handles.get("foo")).toBe("bar");
	});
	it("parses custom sigil", () => {
		const toml = `version = 1\nsigil = "@"\n\n[handles]\nfoo = "bar"\n`;
		const result = parseDict(toml, "test.dict");
		expect(result.sigil).toBe("@");
	});
	it("parses meta entries", () => {
		const toml = `version = 1\n\n[handles]\nfoo = "bar"\n\n[meta.foo]\nnote = "test note"\nscope = "global"\n`;
		const result = parseDict(toml, "test.dict");
		expect(result.meta.get("foo")).toEqual({ note: "test note", scope: "global" });
	});
	it("parses meta with only note", () => {
		const toml = `version = 1\n\n[handles]\nfoo = "bar"\n\n[meta.foo]\nnote = "just a note"\n`;
		const result = parseDict(toml, "test.dict");
		expect(result.meta.get("foo")).toEqual({ note: "just a note" });
	});
	it("parses meta with only scope", () => {
		const toml = `version = 1\n\n[handles]\nfoo = "bar"\n\n[meta.foo]\nscope = "local"\n`;
		const result = parseDict(toml, "test.dict");
		expect(result.meta.get("foo")).toEqual({ scope: "local" });
	});
	it("parses multiple handles", () => {
		const toml = `version = 1\n\n[handles]\nfoo = "bar"\nbaz = "qux"\nabc = "def"\n`;
		const result = parseDict(toml, "test.dict");
		expect(result.handles.size).toBe(3);
		expect(result.handles.get("baz")).toBe("qux");
	});
	it("parses handle with underscores and digits", () => {
		const toml = `version = 1\n\n[handles]\nfoo_bar_123 = "expansion"\n`;
		const result = parseDict(toml, "test.dict");
		expect(result.handles.get("foo_bar_123")).toBe("expansion");
	});
});

describe("parseDict errors", () => {
	it("throws on invalid TOML", () => {
		expect(() => parseDict("not valid toml {{{", "bad.dict")).toThrow(ArgotParseError);
	});
	it("throws on missing version", () => {
		const toml = `[handles]\nfoo = "bar"\n`;
		expect(() => parseDict(toml, "test.dict")).toThrow("missing `version`");
	});
	it("throws on non-integer version", () => {
		const toml = `version = 1.5\n\n[handles]\nfoo = "bar"\n`;
		expect(() => parseDict(toml, "test.dict")).toThrow("must be an integer");
	});
	it("throws on version < 1", () => {
		const toml = `version = 0\n\n[handles]\nfoo = "bar"\n`;
		expect(() => parseDict(toml, "test.dict")).toThrow(">= 1");
	});
	it("throws on version > SUPPORTED_VERSION", () => {
		const toml = `version = ${SUPPORTED_VERSION + 1}\n\n[handles]\nfoo = "bar"\n`;
		expect(() => parseDict(toml, "test.dict")).toThrow("upgrade argot");
	});
	it("throws on non-string sigil", () => {
		const toml = `version = 1\nsigil = 42\n\n[handles]\nfoo = "bar"\n`;
		expect(() => parseDict(toml, "test.dict")).toThrow("must be a string");
	});
	it("throws on empty sigil", () => {
		const toml = `version = 1\nsigil = ""\n\n[handles]\nfoo = "bar"\n`;
		expect(() => parseDict(toml, "test.dict")).toThrow("must not be empty");
	});
	it("throws on sigil with letter", () => {
		const toml = `version = 1\nsigil = "a"\n\n[handles]\nfoo = "bar"\n`;
		expect(() => parseDict(toml, "test.dict")).toThrow("must not contain");
	});
	it("throws on sigil with digit", () => {
		const toml = `version = 1\nsigil = "1"\n\n[handles]\nfoo = "bar"\n`;
		expect(() => parseDict(toml, "test.dict")).toThrow("must not contain");
	});
	it("throws on sigil with underscore", () => {
		const toml = `version = 1\nsigil = "_"\n\n[handles]\nfoo = "bar"\n`;
		expect(() => parseDict(toml, "test.dict")).toThrow("must not contain");
	});
	it("throws on sigil with whitespace", () => {
		const toml = `version = 1\nsigil = " "\n\n[handles]\nfoo = "bar"\n`;
		expect(() => parseDict(toml, "test.dict")).toThrow("must not contain");
	});
	it("throws on missing handles table", () => {
		const toml = `version = 1\n`;
		expect(() => parseDict(toml, "test.dict")).toThrow("missing `[handles]`");
	});
	it("throws on handles not a table", () => {
		const toml = `version = 1\nhandles = "not a table"\n`;
		expect(() => parseDict(toml, "test.dict")).toThrow("must be a table");
	});
	it("throws on invalid handle name", () => {
		const toml = `version = 1\n\n[handles]\nFOO = "bar"\n`;
		expect(() => parseDict(toml, "test.dict")).toThrow("must match");
	});
	it("throws on non-string expansion", () => {
		const toml = `version = 1\n\n[handles]\nfoo = 42\n`;
		expect(() => parseDict(toml, "test.dict")).toThrow("must expand to a string");
	});
	it("throws on empty expansion", () => {
		const toml = `version = 1\n\n[handles]\nfoo = ""\n`;
		expect(() => parseDict(toml, "test.dict")).toThrow("empty string");
	});
	it("throws on expansion containing sigil", () => {
		const toml = `version = 1\n\n[handles]\nfoo = "§bar"\n`;
		expect(() => parseDict(toml, "test.dict")).toThrow("must not contain the sigil");
	});
	it("throws on no handles defined", () => {
		const toml = `version = 1\n\n[handles]\n`;
		expect(() => parseDict(toml, "test.dict")).toThrow("no handles");
	});
	it("throws on meta referencing unknown handle", () => {
		const toml = `version = 1\n\n[handles]\nfoo = "bar"\n\n[meta.baz]\nnote = "x"\n`;
		expect(() => parseDict(toml, "test.dict")).toThrow("not defined");
	});
	it("throws on meta not a table", () => {
		const toml = `version = 1\nmeta = "not a table"\n\n[handles]\nfoo = "bar"\n`;
		expect(() => parseDict(toml, "test.dict")).toThrow("must be a table");
	});
	it("throws on meta entry not a table", () => {
		const toml = `version = 1\n\n[handles]\nfoo = "bar"\n\n[meta.foo]\n`;
		const result = parseDict(toml, "test.dict");
		expect(result.meta.get("foo")).toEqual({});
	});
	it("throws on meta note not a string", () => {
		const toml = `version = 1\n\n[handles]\nfoo = "bar"\n\n[meta.foo]\nnote = 42\n`;
		expect(() => parseDict(toml, "test.dict")).toThrow("must be a string");
	});
	it("throws on meta scope not a string", () => {
		const toml = `version = 1\n\n[handles]\nfoo = "bar"\n\n[meta.foo]\nscope = 42\n`;
		expect(() => parseDict(toml, "test.dict")).toThrow("must be a string");
	});
});

describe("ArgotParseError", () => {
	it("is an Error subclass", () => {
		const err = new ArgotParseError("msg", "source.dict");
		expect(err).toBeInstanceOf(Error);
	});
	it("has correct name", () => {
		const err = new ArgotParseError("msg", "source.dict");
		expect(err.name).toBe("ArgotParseError");
	});
	it("includes source in message", () => {
		const err = new ArgotParseError("msg", "my.dict");
		expect(err.message).toContain("my.dict");
	});
	it("stores source property", () => {
		const err = new ArgotParseError("msg", "my.dict");
		expect(err.source).toBe("my.dict");
	});
});
