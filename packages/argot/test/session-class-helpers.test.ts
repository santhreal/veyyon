import { describe, expect, it } from "bun:test";
import { DICT_FILENAME } from "../src/constants";
import { ArgotSession } from "../src/session";
import type { HandleMeta, Vocabulary } from "../src/types";

function makeVocab(handles: Record<string, string>, sigil = "§"): Vocabulary {
	const handleMap = new Map<string, string>(Object.entries(handles));
	const metaMap = new Map<string, HandleMeta>();
	for (const name of handleMap.keys()) metaMap.set(name, {});
	return { version: 1, sigil, handles: handleMap, meta: metaMap };
}

describe("ArgotSession", () => {
	it("starts unloaded", () => {
		const session = new ArgotSession();
		expect(session.loaded).toBe(false);
	});
	it("preamble is non-empty string", () => {
		const session = new ArgotSession();
		expect(typeof session.preamble).toBe("string");
		expect(session.preamble.length).toBeGreaterThan(0);
	});
	it("load makes session loaded", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ abc: "alpha beta gamma" }));
		expect(session.loaded).toBe(true);
	});
	it("expand works after load", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ abc: "alpha beta gamma" }));
		expect(session.expand("§abc")).toBe("alpha beta gamma");
	});
	it("promptFragment is non-empty after load", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ abc: "alpha beta gamma" }));
		expect(session.promptFragment().length).toBeGreaterThan(0);
	});
	it("promptFragment is empty when no entries", () => {
		const session = new ArgotSession();
		expect(session.promptFragment()).toBe("");
	});
	it("unload removes entry from teacher", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ abc: "alpha beta gamma" }));
		expect(session.unload("key1")).toBe(true);
		expect(session.loaded).toBe(true); // entry still exists, just not taught
	});
	it("unload returns false for unknown key", () => {
		const session = new ArgotSession();
		expect(session.unload("unknown")).toBe(false);
	});
	it("unload returns false for already unloaded key", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ abc: "alpha beta gamma" }));
		session.unload("key1");
		expect(session.unload("key1")).toBe(false);
	});
	it("expand still works after unload (decoder has all)", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ abc: "alpha beta gamma" }));
		session.unload("key1");
		expect(session.expand("§abc")).toBe("alpha beta gamma");
	});
	it("promptFragment is empty after unload", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ abc: "alpha beta gamma" }));
		session.unload("key1");
		expect(session.promptFragment()).toBe("");
	});
	it("observe loads dict from file content", () => {
		const session = new ArgotSession();
		const dictContent = `version = 1\nsigil = "§"\n[handles]\nabc = "alpha beta gamma"\n`;
		expect(session.observe(`/repo/${DICT_FILENAME}`, dictContent)).toBe(true);
		expect(session.loaded).toBe(true);
	});
	it("observe returns false for non-dict file", () => {
		const session = new ArgotSession();
		expect(session.observe("/repo/other.txt", "content")).toBe(false);
		expect(session.loaded).toBe(false);
	});
	it("loadVocab replaces all entries", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ abc: "alpha" }));
		session.loadVocab(makeVocab({ xyz: "x-ray" }));
		expect(session.expand("§xyz")).toBe("x-ray");
	});
	it("loadVocab with empty vocab clears entries", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ abc: "alpha" }));
		session.loadVocab(makeVocab({}));
		expect(session.loaded).toBe(false);
	});
	it("loadVocab with non-empty vocab sets single entry", () => {
		const session = new ArgotSession();
		session.loadVocab(makeVocab({ abc: "alpha" }));
		expect(session.loaded).toBe(true);
		expect(session.expand("§abc")).toBe("alpha");
	});
	it("multiple loads merge vocabularies", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ abc: "alpha" }));
		session.load("key2", makeVocab({ xyz: "x-ray" }));
		expect(session.expand("§abc")).toBe("alpha");
		expect(session.expand("§xyz")).toBe("x-ray");
	});
	it("vocabulary returns merged vocab", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ abc: "alpha" }));
		const vocab = session.vocabulary();
		expect(vocab.handles.size).toBe(1);
		expect(vocab.handles.get("abc")).toBe("alpha");
	});
	it("vocabulary returns empty for no entries", () => {
		const session = new ArgotSession();
		const vocab = session.vocabulary();
		expect(vocab.handles.size).toBe(0);
	});
	it("streamDecoder returns working decoder", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ abc: "alpha beta gamma" }));
		const dec = session.streamDecoder();
		expect(dec.push("§abc ")).toBe("alpha beta gamma ");
	});
	it("fork creates independent copy", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ abc: "alpha" }));
		const forked = session.fork();
		expect(forked.loaded).toBe(true);
		expect(forked.expand("§abc")).toBe("alpha");
	});
	it("fork is independent from original", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ abc: "alpha" }));
		const forked = session.fork();
		forked.load("key2", makeVocab({ xyz: "x-ray" }));
		expect(session.expand("§xyz")).toBe("§xyz");
		expect(forked.expand("§xyz")).toBe("x-ray");
	});
	it("load with teach=false does not add to promptFragment", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ abc: "alpha" }), { teach: false });
		expect(session.promptFragment()).toBe("");
		expect(session.expand("§abc")).toBe("alpha");
	});
	it("load with teach=true adds to promptFragment", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ abc: "alpha" }), { teach: true });
		expect(session.promptFragment().length).toBeGreaterThan(0);
	});
	it("reloading same key replaces vocab", () => {
		const session = new ArgotSession();
		session.load("key1", makeVocab({ abc: "alpha" }));
		session.load("key1", makeVocab({ xyz: "x-ray" }));
		expect(session.expand("§abc")).toBe("§abc");
		expect(session.expand("§xyz")).toBe("x-ray");
	});
});
