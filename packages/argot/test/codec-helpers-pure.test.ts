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
import { DEFAULT_SIGIL, SUPPORTED_VERSION } from "../src/constants";
import type { Vocabulary } from "../src/types";

function makeVocab(handles: Record<string, string>, sigil = DEFAULT_SIGIL): Vocabulary {
	const handleMap = new Map(Object.entries(handles));
	const meta = new Map();
	return { version: SUPPORTED_VERSION, sigil, handles: handleMap, meta };
}

describe("unionVocabularies", () => {
	it("unions two vocabularies with different handles", () => {
		const a = makeVocab({ foo: " expansion-a " });
		const b = makeVocab({ bar: " expansion-b " });
		const result = unionVocabularies([a, b]);
		expect(result.handles.get("foo")).toBe(" expansion-a ");
		expect(result.handles.get("bar")).toBe(" expansion-b ");
	});
	it("allows same handle with same expansion", () => {
		const a = makeVocab({ foo: "expansion" });
		const b = makeVocab({ foo: "expansion" });
		expect(() => unionVocabularies([a, b])).not.toThrow();
	});
	it("throws on same handle with different expansions", () => {
		const a = makeVocab({ foo: "expansion-a" });
		const b = makeVocab({ foo: "expansion-b" });
		expect(() => unionVocabularies([a, b])).toThrow(ArgotConflictError);
	});
	it("throws on different sigils", () => {
		const a = makeVocab({ foo: "expansion" }, "§");
		const b = makeVocab({ bar: "expansion" }, "@");
		expect(() => unionVocabularies([a, b])).toThrow(ArgotConflictError);
	});
	it("skips empty vocabularies", () => {
		const a = makeVocab({});
		const b = makeVocab({ foo: "expansion" });
		const result = unionVocabularies([a, b]);
		expect(result.handles.get("foo")).toBe("expansion");
	});
	it("returns empty handles for all empty vocabs", () => {
		const result = unionVocabularies([makeVocab({}), makeVocab({})]);
		expect(result.handles.size).toBe(0);
	});
	it("uses default sigil when all vocabs are empty", () => {
		const result = unionVocabularies([makeVocab({})]);
		expect(result.sigil).toBe(DEFAULT_SIGIL);
	});
	it("preserves first sigil for non-empty vocabs", () => {
		const a = makeVocab({ foo: "expansion" }, "@");
		const result = unionVocabularies([a]);
		expect(result.sigil).toBe("@");
	});
	it("merges meta entries", () => {
		const a = makeVocab({ foo: "expansion" });
		a.meta.set("foo", { source: "a.ts" });
		const b = makeVocab({ bar: "expansion" });
		b.meta.set("bar", { source: "b.ts" });
		const result = unionVocabularies([a, b]);
		expect(result.meta.get("foo")).toEqual({ source: "a.ts" });
		expect(result.meta.get("bar")).toEqual({ source: "b.ts" });
	});
	it("does not overwrite existing meta", () => {
		const a = makeVocab({ foo: "expansion" });
		a.meta.set("foo", { source: "first" });
		const b = makeVocab({ foo: "expansion" });
		b.meta.set("foo", { source: "second" });
		const result = unionVocabularies([a, b]);
		expect(result.meta.get("foo")).toEqual({ source: "first" });
	});
});

describe("makeExpander", () => {
	it("expands known handle", () => {
		const vocab = makeVocab({ foo: "bar baz" });
		const expand = makeExpander(vocab);
		expect(expand("§foo")).toBe("bar baz");
	});
	it("expands handle in context", () => {
		const vocab = makeVocab({ foo: "bar" });
		const expand = makeExpander(vocab);
		expect(expand("hello §foo world")).toBe("hello bar world");
	});
	it("expands multiple handles", () => {
		const vocab = makeVocab({ foo: "bar", baz: "qux" });
		const expand = makeExpander(vocab);
		expect(expand("§foo and §baz")).toBe("bar and qux");
	});
	it("does not expand unknown handle", () => {
		const vocab = makeVocab({ foo: "bar" });
		const expand = makeExpander(vocab);
		expect(expand("§unknown")).toBe("§unknown");
	});
	it("returns identity for empty vocab", () => {
		const expand = makeExpander(makeVocab({}));
		expect(expand("hello")).toBe("hello");
	});
	it("does not expand handle followed by word char", () => {
		const vocab = makeVocab({ foo: "bar" });
		const expand = makeExpander(vocab);
		expect(expand("§foobar")).toBe("§foobar");
	});
	it("expands longest match first", () => {
		const vocab = makeVocab({ foo: "short", foobar: "long" });
		const expand = makeExpander(vocab);
		expect(expand("§foobar")).toBe("long");
		expect(expand("§foo")).toBe("short");
	});
	it("expands handle at end of string", () => {
		const vocab = makeVocab({ foo: "bar" });
		const expand = makeExpander(vocab);
		expect(expand("text §foo")).toBe("text bar");
	});
	it("expands handle at start of string", () => {
		const vocab = makeVocab({ foo: "bar" });
		const expand = makeExpander(vocab);
		expect(expand("§foo text")).toBe("bar text");
	});
	it("expands multiple occurrences of same handle", () => {
		const vocab = makeVocab({ foo: "bar" });
		const expand = makeExpander(vocab);
		expect(expand("§foo §foo §foo")).toBe("bar bar bar");
	});
	it("handles empty string", () => {
		const expand = makeExpander(makeVocab({ foo: "bar" }));
		expect(expand("")).toBe("");
	});
	it("handles custom sigil", () => {
		const vocab = makeVocab({ foo: "bar" }, "@");
		const expand = makeExpander(vocab);
		expect(expand("@foo")).toBe("bar");
	});
});

describe("measureDecode", () => {
	it("measures replacements for known handles", () => {
		const vocab = makeVocab({ foo: "bar" });
		const result = measureDecode(vocab, "§foo and §foo");
		expect(result.replacements).toHaveLength(2);
		expect(result.replacements[0].name).toBe("foo");
		expect(result.replacements[0].expansion).toBe("bar");
	});
	it("counts unknown sigil occurrences", () => {
		const vocab = makeVocab({ foo: "bar" });
		const result = measureDecode(vocab, "§foo and §unknown");
		expect(result.unknownSigilCount).toBe(1);
	});
	it("returns zero unknown for no sigils", () => {
		const vocab = makeVocab({ foo: "bar" });
		const result = measureDecode(vocab, "hello world");
		expect(result.unknownSigilCount).toBe(0);
	});
	it("returns expanded text", () => {
		const vocab = makeVocab({ foo: "bar" });
		const result = measureDecode(vocab, "§foo");
		expect(result.expanded).toBe("bar");
	});
	it("returns identity for empty vocab", () => {
		const result = measureDecode(makeVocab({}), "hello");
		expect(result.expanded).toBe("hello");
		expect(result.replacements).toEqual([]);
		expect(result.unknownSigilCount).toBe(0);
	});
	it("records index of each replacement", () => {
		const vocab = makeVocab({ foo: "bar" });
		const result = measureDecode(vocab, "xx §foo");
		expect(result.replacements[0].index).toBe(3);
	});
});

describe("makePromptFragment", () => {
	it("returns empty string for empty vocab", () => {
		expect(makePromptFragment(makeVocab({}))).toBe("");
	});
	it("contains heading for non-empty vocab", () => {
		const fragment = makePromptFragment(makeVocab({ foo: "bar" }));
		expect(fragment).toContain("Project shorthand");
		expect(fragment).toContain("Argot");
	});
	it("lists handles with sigil", () => {
		const fragment = makePromptFragment(makeVocab({ foo: "bar" }));
		expect(fragment).toContain("§foo");
		expect(fragment).toContain("bar");
	});
	it("lists multiple handles", () => {
		const fragment = makePromptFragment(makeVocab({ foo: "bar", baz: "qux" }));
		expect(fragment).toContain("§foo");
		expect(fragment).toContain("§baz");
	});
	it("includes sigil in instructions", () => {
		const fragment = makePromptFragment(makeVocab({ foo: "bar" }));
		expect(fragment).toContain("§");
	});
});

describe("makeDict", () => {
	it("returns dict with expand and promptFragment", () => {
		const dict = makeDict(makeVocab({ foo: "bar" }));
		expect(typeof dict.expand).toBe("function");
		expect(typeof dict.promptFragment).toBe("function");
	});
	it("expand works correctly", () => {
		const dict = makeDict(makeVocab({ foo: "bar" }));
		expect(dict.expand("§foo")).toBe("bar");
	});
	it("promptFragment returns fragment", () => {
		const dict = makeDict(makeVocab({ foo: "bar" }));
		expect(dict.promptFragment()).toContain("§foo");
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

describe("ArgotConflictError", () => {
	it("is an Error subclass", () => {
		const err = new ArgotConflictError("test");
		expect(err).toBeInstanceOf(Error);
	});
	it("has correct name", () => {
		const err = new ArgotConflictError("test");
		expect(err.name).toBe("ArgotConflictError");
	});
	it("preserves message", () => {
		const err = new ArgotConflictError("conflict message");
		expect(err.message).toBe("conflict message");
	});
});
