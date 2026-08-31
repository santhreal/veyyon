import { describe, expect, it } from "bun:test";
import {
	ArgotConflictError,
	emptyDict,
	makeDict,
	makeExpander,
	makePromptFragment,
	measureDecode,
	unionVocabularies,
} from "../src/codec";
import { DEFAULT_SIGIL, HANDLE_NAME_RE, SIGIL_FORBIDDEN_RE, SUPPORTED_VERSION } from "../src/constants";
import type { Vocabulary } from "../src/types";

function makeVocab(handles: Record<string, string>, sigil = DEFAULT_SIGIL): Vocabulary {
	return {
		version: SUPPORTED_VERSION,
		sigil,
		handles: new Map(Object.entries(handles)),
		meta: new Map(),
	};
}

describe("ArgotConflictError", () => {
	it("is an Error subclass", () => {
		const err = new ArgotConflictError("test");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("ArgotConflictError");
		expect(err.message).toBe("test");
	});
});

describe("unionVocabularies", () => {
	it("returns empty vocabulary for empty input", () => {
		const result = unionVocabularies([]);
		expect(result.handles.size).toBe(0);
		expect(result.sigil).toBe(DEFAULT_SIGIL);
	});

	it("returns single vocabulary unchanged", () => {
		const vocab = makeVocab({ foo: "bar" });
		const result = unionVocabularies([vocab]);
		expect(result.handles.get("foo")).toBe("bar");
	});

	it("merges two vocabularies with different handles", () => {
		const v1 = makeVocab({ foo: "bar" });
		const v2 = makeVocab({ baz: "qux" });
		const result = unionVocabularies([v1, v2]);
		expect(result.handles.get("foo")).toBe("bar");
		expect(result.handles.get("baz")).toBe("qux");
	});

	it("allows same handle with same expansion in both", () => {
		const v1 = makeVocab({ foo: "bar" });
		const v2 = makeVocab({ foo: "bar" });
		const result = unionVocabularies([v1, v2]);
		expect(result.handles.get("foo")).toBe("bar");
	});

	it("throws on conflicting expansions for same handle", () => {
		const v1 = makeVocab({ foo: "bar" });
		const v2 = makeVocab({ foo: "different" });
		expect(() => unionVocabularies([v1, v2])).toThrow(ArgotConflictError);
		expect(() => unionVocabularies([v1, v2])).toThrow("defined twice with different expansions");
	});

	it("throws on different sigils", () => {
		const v1 = makeVocab({ foo: "bar" }, "§");
		const v2 = makeVocab({ baz: "qux" }, "@");
		expect(() => unionVocabularies([v1, v2])).toThrow(ArgotConflictError);
		expect(() => unionVocabularies([v1, v2])).toThrow("different sigils");
	});

	it("skips empty vocabularies", () => {
		const v1 = makeVocab({});
		const v2 = makeVocab({ foo: "bar" });
		const result = unionVocabularies([v1, v2]);
		expect(result.handles.get("foo")).toBe("bar");
	});

	it("uses first non-empty vocab's sigil", () => {
		const v1 = makeVocab({});
		const v2 = makeVocab({ foo: "bar" }, "§");
		const result = unionVocabularies([v1, v2]);
		expect(result.sigil).toBe("§");
	});

	it("merges meta from both vocabularies keeping first", () => {
		const v1: Vocabulary = {
			version: SUPPORTED_VERSION,
			sigil: "§",
			handles: new Map([["foo", "bar"]]),
			meta: new Map([["foo", { note: "first" }]]),
		};
		const v2: Vocabulary = {
			version: SUPPORTED_VERSION,
			sigil: "§",
			handles: new Map([["baz", "qux"]]),
			meta: new Map([
				["foo", { note: "second" }],
				["baz", { note: "baz-note" }],
			]),
		};
		const result = unionVocabularies([v1, v2]);
		expect(result.meta.get("foo")?.note).toBe("first");
		expect(result.meta.get("baz")?.note).toBe("baz-note");
	});
});

describe("makeExpander", () => {
	it("returns identity function for empty vocabulary", () => {
		const expand = makeExpander(makeVocab({}));
		expect(expand("hello world")).toBe("hello world");
	});

	it("expands single handle", () => {
		const expand = makeExpander(makeVocab({ foo: "bar" }));
		expect(expand("§foo")).toBe("bar");
	});

	it("expands handle in context", () => {
		const expand = makeExpander(makeVocab({ foo: "bar" }));
		expect(expand("prefix §foo suffix")).toBe("prefix bar suffix");
	});

	it("expands multiple handles", () => {
		const expand = makeExpander(makeVocab({ foo: "bar", baz: "qux" }));
		expect(expand("§foo and §baz")).toBe("bar and qux");
	});

	it("does not expand handle followed by word characters", () => {
		const expand = makeExpander(makeVocab({ foo: "bar" }));
		expect(expand("§foobar")).toBe("§foobar");
	});

	it("expands longest handle first", () => {
		const expand = makeExpander(makeVocab({ foo: "short", foobar: "long" }));
		expect(expand("§foobar")).toBe("long");
		expect(expand("§foo")).toBe("short");
	});

	it("handles multiple occurrences of same handle", () => {
		const expand = makeExpander(makeVocab({ foo: "bar" }));
		expect(expand("§foo §foo §foo")).toBe("bar bar bar");
	});

	it("does not expand text without sigil", () => {
		const expand = makeExpander(makeVocab({ foo: "bar" }));
		expect(expand("foo")).toBe("foo");
	});

	it("handles empty string", () => {
		const expand = makeExpander(makeVocab({ foo: "bar" }));
		expect(expand("")).toBe("");
	});

	it("handles special regex chars in expansions", () => {
		const expand = makeExpander(makeVocab({ foo: "$1.00 (cheap)" }));
		expect(expand("§foo")).toBe("$1.00 (cheap)");
	});
});

describe("measureDecode", () => {
	it("returns text unchanged for empty vocabulary", () => {
		const result = measureDecode(makeVocab({}), "hello");
		expect(result.expanded).toBe("hello");
		expect(result.replacements).toEqual([]);
		expect(result.unknownSigilCount).toBe(0);
	});

	it("measures single replacement", () => {
		const result = measureDecode(makeVocab({ foo: "bar" }), "§foo");
		expect(result.expanded).toBe("bar");
		expect(result.replacements).toHaveLength(1);
		expect(result.replacements[0]!.name).toBe("foo");
		expect(result.replacements[0]!.expansion).toBe("bar");
	});

	it("counts unknown sigil occurrences", () => {
		const result = measureDecode(makeVocab({ foo: "bar" }), "§foo §unknown");
		expect(result.replacements).toHaveLength(1);
		expect(result.unknownSigilCount).toBe(1);
	});

	it("handles multiple replacements", () => {
		const result = measureDecode(makeVocab({ foo: "bar", baz: "qux" }), "§foo §baz §foo");
		expect(result.replacements).toHaveLength(3);
		expect(result.expanded).toBe("bar qux bar");
	});

	it("handles no sigils in text", () => {
		const result = measureDecode(makeVocab({ foo: "bar" }), "plain text");
		expect(result.replacements).toEqual([]);
		expect(result.unknownSigilCount).toBe(0);
	});

	it("tracks replacement indices", () => {
		const result = measureDecode(makeVocab({ foo: "bar" }), "text §foo here");
		expect(result.replacements[0]!.index).toBe(5);
	});
});

describe("makePromptFragment", () => {
	it("returns empty string for empty vocabulary", () => {
		expect(makePromptFragment(makeVocab({}))).toBe("");
	});

	it("includes header for non-empty vocabulary", () => {
		const fragment = makePromptFragment(makeVocab({ foo: "bar" }));
		expect(fragment).toContain("Project shorthand");
		expect(fragment).toContain("Argot");
	});

	it("includes handle and expansion", () => {
		const fragment = makePromptFragment(makeVocab({ foo: "bar" }));
		expect(fragment).toContain("§foo");
		expect(fragment).toContain("bar");
	});

	it("includes all handles", () => {
		const fragment = makePromptFragment(makeVocab({ foo: "bar", baz: "qux" }));
		expect(fragment).toContain("§foo");
		expect(fragment).toContain("§baz");
		expect(fragment).toContain("bar");
		expect(fragment).toContain("qux");
	});

	it("includes sigil in instructions", () => {
		const fragment = makePromptFragment(makeVocab({ foo: "bar" }));
		expect(fragment).toContain("§");
	});
});

describe("makeDict", () => {
	it("creates a dict with expand and promptFragment", () => {
		const dict = makeDict(makeVocab({ foo: "bar" }));
		expect(typeof dict.expand).toBe("function");
		expect(typeof dict.promptFragment).toBe("function");
	});

	it("expand function works", () => {
		const dict = makeDict(makeVocab({ foo: "bar" }));
		expect(dict.expand("§foo")).toBe("bar");
	});

	it("promptFragment returns content", () => {
		const dict = makeDict(makeVocab({ foo: "bar" }));
		expect(dict.promptFragment()).toContain("§foo");
	});

	it("empty vocab returns empty promptFragment", () => {
		const dict = makeDict(makeVocab({}));
		expect(dict.promptFragment()).toBe("");
	});
});

describe("emptyDict", () => {
	it("returns identity expand", () => {
		const dict = emptyDict();
		expect(dict.expand("hello")).toBe("hello");
	});

	it("returns empty promptFragment", () => {
		const dict = emptyDict();
		expect(dict.promptFragment()).toBe("");
	});
});

describe("HANDLE_NAME_RE", () => {
	it("matches lowercase alphanumeric and underscore", () => {
		expect(HANDLE_NAME_RE.test("foo")).toBe(true);
		expect(HANDLE_NAME_RE.test("foo_bar123")).toBe(true);
		expect(HANDLE_NAME_RE.test("a")).toBe(true);
	});

	it("rejects uppercase", () => {
		expect(HANDLE_NAME_RE.test("Foo")).toBe(false);
	});

	it("rejects special characters", () => {
		expect(HANDLE_NAME_RE.test("foo-bar")).toBe(false);
		expect(HANDLE_NAME_RE.test("foo.bar")).toBe(false);
	});

	it("rejects empty string", () => {
		expect(HANDLE_NAME_RE.test("")).toBe(false);
	});
});

describe("SIGIL_FORBIDDEN_RE", () => {
	it("matches lowercase letters", () => {
		expect(SIGIL_FORBIDDEN_RE.test("a")).toBe(true);
	});

	it("matches digits", () => {
		expect(SIGIL_FORBIDDEN_RE.test("1")).toBe(true);
	});

	it("matches underscore", () => {
		expect(SIGIL_FORBIDDEN_RE.test("_")).toBe(true);
	});

	it("matches whitespace", () => {
		expect(SIGIL_FORBIDDEN_RE.test(" ")).toBe(true);
	});

	it("does not match special characters", () => {
		expect(SIGIL_FORBIDDEN_RE.test("§")).toBe(false);
		expect(SIGIL_FORBIDDEN_RE.test("@")).toBe(false);
		expect(SIGIL_FORBIDDEN_RE.test("#")).toBe(false);
	});
});
