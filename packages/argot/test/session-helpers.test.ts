import { describe, expect, it } from "bun:test";
import { DEFAULT_SIGIL, SUPPORTED_VERSION } from "../src/constants";
import { ArgotSession } from "../src/session";
import type { Vocabulary } from "../src/types";

function makeVocab(handles: Record<string, string>, sigil = DEFAULT_SIGIL): Vocabulary {
	const handleMap = new Map(Object.entries(handles));
	const meta = new Map();
	return { version: SUPPORTED_VERSION, sigil, handles: handleMap, meta };
}

describe("ArgotSession", () => {
	it("starts unloaded", () => {
		const session = new ArgotSession();
		expect(session.loaded).toBe(false);
	});
	it("expand returns identity when unloaded", () => {
		const session = new ArgotSession();
		expect(session.expand("hello")).toBe("hello");
	});
	it("promptFragment returns empty when unloaded", () => {
		const session = new ArgotSession();
		expect(session.promptFragment()).toBe("");
	});
	it("load makes session loaded", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ foo: "bar" }));
		expect(session.loaded).toBe(true);
	});
	it("expand works after load", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ foo: "bar" }));
		expect(session.expand("§foo")).toBe("bar");
	});
	it("promptFragment works after load", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ foo: "bar" }));
		expect(session.promptFragment()).toContain("§foo");
	});
	it("unload disables teaching but entry remains", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ foo: "bar" }));
		expect(session.unload("key1")).toBe(true);
		expect(session.promptFragment()).toBe("");
		expect(session.expand("§foo")).toBe("bar");
	});
	it("unload returns false for already-unloaded key", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ foo: "bar" }));
		session.unload("key1");
		expect(session.unload("key1")).toBe(false);
	});
	it("unload does not make loaded false when other vocabs exist", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ foo: "bar" }));
		session.load("key2", makeVocab({ baz: "qux" }));
		session.unload("key1");
		expect(session.loaded).toBe(true);
	});
	it("loadVocab replaces all entries", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ foo: "bar" }));
		session.loadVocab(makeVocab({ baz: "qux" }));
		expect(session.expand("§foo")).toBe("§foo");
		expect(session.expand("§baz")).toBe("qux");
	});
	it("loadVocab with empty vocab clears entries", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ foo: "bar" }));
		session.loadVocab(makeVocab({}));
		expect(session.loaded).toBe(false);
	});
	it("vocabulary returns union of all loaded", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ foo: "bar" }));
		session.load("key2", makeVocab({ baz: "qux" }));
		const vocab = session.vocabulary();
		expect(vocab.handles.get("foo")).toBe("bar");
		expect(vocab.handles.get("baz")).toBe("qux");
	});
	it("streamDecoder returns working decoder", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ foo: "bar" }));
		const decoder = session.streamDecoder();
		expect(decoder.push("§foo ")).toBe("bar ");
	});
	it("fork creates independent copy", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ foo: "bar" }));
		const forked = session.fork();
		forked.unload("key1");
		expect(forked.promptFragment()).toBe("");
		expect(session.promptFragment()).toContain("§foo");
	});
	it("fork preserves loaded vocabs", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ foo: "bar" }));
		const forked = session.fork();
		expect(forked.expand("§foo")).toBe("bar");
	});
	it("observe loads dict file content", () => {
		const session = new ArgotSession();
		const dictContent = `version = 1\n\n[handles]\nfoo = "bar"\n`;
		expect(session.observe("path/to/AGENTS.dict", dictContent)).toBe(true);
		expect(session.loaded).toBe(true);
		expect(session.expand("§foo")).toBe("bar");
	});
	it("observe returns false for non-dict file", () => {
		const session = new ArgotSession();
		expect(session.observe("path/to/other.txt", "content")).toBe(false);
		expect(session.loaded).toBe(false);
	});
	it("observe uses directory as key", () => {
		const session = new ArgotSession();
		const dictContent = `version = 1\n\n[handles]\nfoo = "bar"\n`;
		session.observe("dir/sub/AGENTS.dict", dictContent);
		session.observe("other/dir/AGENTS.dict", dictContent);
		const vocab = session.vocabulary();
		expect(vocab.handles.size).toBe(1);
	});
	it("load with teach=false does not add to teacher", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ foo: "bar" }), { teach: false });
		expect(session.expand("§foo")).toBe("bar");
		expect(session.promptFragment()).toBe("");
	});
	it("load with teach=true (default) adds to teacher", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ foo: "bar" }));
		expect(session.promptFragment()).toContain("§foo");
	});
	it("unload then reload works", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ foo: "bar" }));
		session.unload("key1");
		session.load("key1", makeVocab({ foo: "bar" }));
		expect(session.expand("§foo")).toBe("bar");
		expect(session.promptFragment()).toContain("§foo");
	});
	it("preamble is accessible", () => {
		const session = new ArgotSession();
		expect(typeof session.preamble).toBe("string");
		expect(session.preamble.length).toBeGreaterThan(0);
	});
	it("multiple loads with same key replace", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ foo: "bar" }));
		session.load("key1", makeVocab({ baz: "qux" }));
		expect(session.expand("§foo")).toBe("§foo");
		expect(session.expand("§baz")).toBe("qux");
	});
});
