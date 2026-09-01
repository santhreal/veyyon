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
import type { Vocabulary } from "../src/types";

const makeVocab = (
	handles: Record<string, string>,
	sigil = "§",
	meta: Record<string, { note?: string; scope?: string }> = {},
): Vocabulary => ({
	version: 1,
	sigil,
	handles: new Map(Object.entries(handles)),
	meta: new Map(Object.entries(meta)),
});

describe("unionVocabularies", () => {
	it("combines two vocabularies with same sigil", () => {
		const v1 = makeVocab({ foo: "bar" });
		const v2 = makeVocab({ baz: "qux" });
		const result = unionVocabularies([v1, v2]);
		expect(result.handles.size).toBe(2);
		expect(result.handles.get("foo")).toBe("bar");
		expect(result.handles.get("baz")).toBe("qux");
	});
	it("throws on different sigils", () => {
		const v1 = makeVocab({ foo: "bar" }, "§");
		const v2 = makeVocab({ baz: "qux" }, "@");
		expect(() => unionVocabularies([v1, v2])).toThrow(ArgotConflictError);
	});
	it("throws on conflicting handle expansions", () => {
		const v1 = makeVocab({ foo: "bar" });
		const v2 = makeVocab({ foo: "different" });
		expect(() => unionVocabularies([v1, v2])).toThrow(ArgotConflictError);
	});
	it("allows same handle with same expansion", () => {
		const v1 = makeVocab({ foo: "bar" });
		const v2 = makeVocab({ foo: "bar" });
		const result = unionVocabularies([v1, v2]);
		expect(result.handles.size).toBe(1);
		expect(result.handles.get("foo")).toBe("bar");
	});
	it("skips empty vocabularies", () => {
		const v1 = makeVocab({});
		const v2 = makeVocab({ foo: "bar" });
		const result = unionVocabularies([v1, v2]);
		expect(result.handles.size).toBe(1);
	});
	it("returns default sigil for all-empty vocabularies", () => {
		const result = unionVocabularies([makeVocab({})]);
		expect(result.sigil).toBe("§");
	});
	it("returns empty handles for empty input", () => {
		const result = unionVocabularies([]);
		expect(result.handles.size).toBe(0);
	});
	it("merges meta from multiple vocabularies", () => {
		const v1 = makeVocab({ foo: "bar" }, "§", { foo: { note: "n1" } });
		const v2 = makeVocab({ baz: "qux" }, "§", { baz: { scope: "s1" } });
		const result = unionVocabularies([v1, v2]);
		expect(result.meta.get("foo")?.note).toBe("n1");
		expect(result.meta.get("baz")?.scope).toBe("s1");
	});
	it("first meta wins for duplicate handle names", () => {
		const v1 = makeVocab({ foo: "bar" }, "§", { foo: { note: "first" } });
		const v2 = makeVocab({ foo: "bar" }, "§", { foo: { note: "second" } });
		const result = unionVocabularies([v1, v2]);
		expect(result.meta.get("foo")?.note).toBe("first");
	});
});

describe("makeExpander", () => {
	it("returns identity for empty vocabulary", () => {
		const expand = makeExpander(makeVocab({}));
		expect(expand("hello world")).toBe("hello world");
	});
	it("expands known handle", () => {
		const expand = makeExpander(makeVocab({ foo: "bar" }));
		expect(expand("§foo")).toBe("bar");
	});
	it("expands handle in context", () => {
		const expand = makeExpander(makeVocab({ foo: "bar" }));
		expect(expand("hello §foo world")).toBe("hello bar world");
	});
	it("expands multiple handles", () => {
		const expand = makeExpander(makeVocab({ foo: "bar", baz: "qux" }));
		expect(expand("§foo and §baz")).toBe("bar and qux");
	});
	it("does not expand unknown handle", () => {
		const expand = makeExpander(makeVocab({ foo: "bar" }));
		expect(expand("§unknown")).toBe("§unknown");
	});
	it("longest match wins (§dbconn over §db)", () => {
		const expand = makeExpander(makeVocab({ db: "database", dbconn: "database connection" }));
		expect(expand("§dbconn")).toBe("database connection");
		expect(expand("§db")).toBe("database");
	});
	it("boundary guard: §dbextra not expanded as §db", () => {
		const expand = makeExpander(makeVocab({ db: "database" }));
		expect(expand("§dbextra")).toBe("§dbextra");
	});
	it("expands multiple occurrences of same handle", () => {
		const expand = makeExpander(makeVocab({ foo: "bar" }));
		expect(expand("§foo §foo §foo")).toBe("bar bar bar");
	});
	it("handles custom sigil", () => {
		const expand = makeExpander(makeVocab({ foo: "bar" }, "@"));
		expect(expand("@foo")).toBe("bar");
	});
	it("no expansion when sigil not present", () => {
		const expand = makeExpander(makeVocab({ foo: "bar" }));
		expect(expand("hello world")).toBe("hello world");
	});
});

describe("measureDecode", () => {
	it("returns expanded text identical to makeExpander", () => {
		const vocab = makeVocab({ foo: "bar", baz: "qux" });
		const text = "hello §foo and §baz";
		const expand = makeExpander(vocab);
		const measured = measureDecode(vocab, text);
		expect(measured.expanded).toBe(expand(text));
	});
	it("records replacements in order", () => {
		const vocab = makeVocab({ foo: "bar", baz: "qux" });
		const measured = measureDecode(vocab, "§foo §baz");
		expect(measured.replacements.length).toBe(2);
		expect(measured.replacements[0]?.name).toBe("foo");
		expect(measured.replacements[0]?.expansion).toBe("bar");
		expect(measured.replacements[1]?.name).toBe("baz");
	});
	it("counts unknown sigils", () => {
		const vocab = makeVocab({ foo: "bar" });
		const measured = measureDecode(vocab, "§foo §unknown");
		expect(measured.replacements.length).toBe(1);
		expect(measured.unknownSigilCount).toBe(1);
	});
	it("unknownSigilCount is 0 when all sigils resolve", () => {
		const vocab = makeVocab({ foo: "bar" });
		const measured = measureDecode(vocab, "§foo");
		expect(measured.unknownSigilCount).toBe(0);
	});
	it("handles text with no sigils", () => {
		const vocab = makeVocab({ foo: "bar" });
		const measured = measureDecode(vocab, "hello world");
		expect(measured.replacements.length).toBe(0);
		expect(measured.unknownSigilCount).toBe(0);
		expect(measured.expanded).toBe("hello world");
	});
	it("handles empty vocabulary (no expansion)", () => {
		const vocab = makeVocab({});
		const measured = measureDecode(vocab, "§foo");
		expect(measured.replacements.length).toBe(0);
		expect(measured.expanded).toBe("§foo");
	});
	it("records index of each replacement", () => {
		const vocab = makeVocab({ foo: "bar" });
		const measured = measureDecode(vocab, "hello §foo");
		expect(measured.replacements[0]?.index).toBe(6);
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
	it("lists handles with sigil", () => {
		const fragment = makePromptFragment(makeVocab({ foo: "bar" }));
		expect(fragment).toContain("§foo");
		expect(fragment).toContain("bar");
	});
	it("uses custom sigil", () => {
		const fragment = makePromptFragment(makeVocab({ foo: "bar" }, "@"));
		expect(fragment).toContain("@foo");
	});
	it("lists multiple handles", () => {
		const fragment = makePromptFragment(makeVocab({ foo: "bar", baz: "qux" }));
		expect(fragment).toContain("§foo");
		expect(fragment).toContain("§baz");
	});
});

describe("makeDict", () => {
	it("returns AgentDict with expand and promptFragment", () => {
		const dict = makeDict(makeVocab({ foo: "bar" }));
		expect(typeof dict.expand).toBe("function");
		expect(typeof dict.promptFragment).toBe("function");
	});
	it("expand works correctly", () => {
		const dict = makeDict(makeVocab({ foo: "bar" }));
		expect(dict.expand("§foo")).toBe("bar");
	});
	it("promptFragment returns the fragment", () => {
		const dict = makeDict(makeVocab({ foo: "bar" }));
		const fragment = dict.promptFragment();
		expect(fragment).toContain("§foo");
	});
	it("empty vocabulary produces empty promptFragment", () => {
		const dict = makeDict(makeVocab({}));
		expect(dict.promptFragment()).toBe("");
	});
});

describe("emptyDict", () => {
	it("returns identity expand", () => {
		const dict = emptyDict();
		expect(dict.expand("hello")).toBe("hello");
		expect(dict.expand("§foo")).toBe("§foo");
	});
	it("returns empty promptFragment", () => {
		const dict = emptyDict();
		expect(dict.promptFragment()).toBe("");
	});
});
