import { describe, expect, it } from "bun:test";
import { makeStreamDecoder, StreamDecoder } from "../src/stream";
import type { HandleMeta, Vocabulary } from "../src/types";

function makeVocab(handles: Record<string, string>, sigil = "§"): Vocabulary {
	const handleMap = new Map<string, string>(Object.entries(handles));
	const metaMap = new Map<string, HandleMeta>();
	for (const name of handleMap.keys()) metaMap.set(name, {});
	return { version: 1, sigil, handles: handleMap, meta: metaMap };
}

const sampleVocab = makeVocab({ abc: "alpha beta gamma", xy: "x-ray yankee" });

describe("StreamDecoder", () => {
	it("holds complete handle until non-name char arrives", () => {
		const dec = new StreamDecoder(sampleVocab);
		expect(dec.push("§abc")).toBe("");
		expect(dec.pending).toBe("§abc");
	});
	it("expands handle when followed by space", () => {
		const dec = new StreamDecoder(sampleVocab);
		expect(dec.push("§abc ")).toBe("alpha beta gamma ");
	});
	it("expands handle when followed by non-name char", () => {
		const dec = new StreamDecoder(sampleVocab);
		expect(dec.push("§abc.")).toBe("alpha beta gamma.");
	});
	it("expands multiple handles in one chunk", () => {
		const dec = new StreamDecoder(sampleVocab);
		expect(dec.push("§abc §xy ")).toBe("alpha beta gamma x-ray yankee ");
	});
	it("holds incomplete sigil at end of chunk", () => {
		const dec = new StreamDecoder(sampleVocab);
		const out = dec.push("text §");
		expect(out).toBe("text ");
		expect(dec.pending).toBe("§");
	});
	it("holds incomplete handle name at end of chunk", () => {
		const dec = new StreamDecoder(sampleVocab);
		const out = dec.push("text §ab");
		expect(out).toBe("text ");
		expect(dec.pending).toBe("§ab");
	});
	it("completes handle on next push with non-name char", () => {
		const dec = new StreamDecoder(sampleVocab);
		dec.push("text §ab");
		expect(dec.push("c ")).toBe("alpha beta gamma ");
	});
	it("flush expands partial pending as-is when not a valid handle", () => {
		const dec = new StreamDecoder(sampleVocab);
		dec.push("text §ab");
		expect(dec.flush()).toBe("§ab");
	});
	it("flush expands complete pending handle", () => {
		const dec = new StreamDecoder(sampleVocab);
		dec.push("§abc");
		expect(dec.flush()).toBe("alpha beta gamma");
	});
	it("flush returns empty when nothing pending", () => {
		const dec = new StreamDecoder(sampleVocab);
		dec.push("§abc ");
		expect(dec.flush()).toBe("");
	});
	it("reset clears pending", () => {
		const dec = new StreamDecoder(sampleVocab);
		dec.push("text §ab");
		dec.reset();
		expect(dec.pending).toBe("");
	});
	it("returns empty string for empty chunk", () => {
		const dec = new StreamDecoder(sampleVocab);
		expect(dec.push("")).toBe("");
	});
	it("passes through text without handles", () => {
		const dec = new StreamDecoder(sampleVocab);
		expect(dec.push("hello world")).toBe("hello world");
	});
	it("returns chunk unchanged when vocab has no handles", () => {
		const dec = new StreamDecoder(makeVocab({}));
		expect(dec.push("§abc text")).toBe("§abc text");
	});
	it("flush returns empty when vocab has no handles (nothing held)", () => {
		const dec = new StreamDecoder(makeVocab({}));
		dec.push("held text");
		expect(dec.flush()).toBe("");
	});
	it("pending is empty after flush", () => {
		const dec = new StreamDecoder(sampleVocab);
		dec.push("text §ab");
		dec.flush();
		expect(dec.pending).toBe("");
	});
	it("handles sigil not followed by name chars", () => {
		const dec = new StreamDecoder(sampleVocab);
		expect(dec.push("§. text")).toBe("§. text");
	});
	it("handles handle name not in vocab", () => {
		const dec = new StreamDecoder(sampleVocab);
		expect(dec.push("§zzz ")).toBe("§zzz ");
	});
	it("handles multiple sigils in sequence", () => {
		const dec = new StreamDecoder(sampleVocab);
		expect(dec.push("§abc§xy ")).toBe("alpha beta gammax-ray yankee ");
	});
	it("handles sigil at start of chunk", () => {
		const dec = new StreamDecoder(sampleVocab);
		expect(dec.push("§abc rest")).toBe("alpha beta gamma rest");
	});
	it("handles chunk that is just the sigil", () => {
		const dec = new StreamDecoder(sampleVocab);
		expect(dec.push("§")).toBe("");
		expect(dec.pending).toBe("§");
	});
	it("handles partial sigil prefix at end", () => {
		const longSigilVocab = makeVocab({ test: "testing" }, ">>");
		const dec = new StreamDecoder(longSigilVocab);
		const out = dec.push("text >");
		expect(out).toBe("text ");
		expect(dec.pending).toBe(">");
	});
	it("completes multi-char sigil on next push", () => {
		const longSigilVocab = makeVocab({ test: "testing" }, ">>");
		const dec = new StreamDecoder(longSigilVocab);
		dec.push("text >");
		expect(dec.push(">test ")).toBe("testing ");
	});
});

describe("makeStreamDecoder", () => {
	it("creates a StreamDecoder instance", () => {
		const dec = makeStreamDecoder(sampleVocab);
		expect(dec).toBeInstanceOf(StreamDecoder);
	});
	it("decoder from factory works the same", () => {
		const dec = makeStreamDecoder(sampleVocab);
		expect(dec.push("§abc ")).toBe("alpha beta gamma ");
	});
});
