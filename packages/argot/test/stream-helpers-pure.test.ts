import { describe, expect, it } from "bun:test";
import { DEFAULT_SIGIL, SUPPORTED_VERSION } from "../src/constants";
import { makeStreamDecoder, StreamDecoder } from "../src/stream";
import type { Vocabulary } from "../src/types";

function makeVocab(handles: Record<string, string>, sigil = DEFAULT_SIGIL): Vocabulary {
	const handleMap = new Map(Object.entries(handles));
	const meta = new Map();
	return { version: SUPPORTED_VERSION, sigil, handles: handleMap, meta };
}

describe("StreamDecoder", () => {
	it("passes through text when vocab has no handles", () => {
		const decoder = new StreamDecoder(makeVocab({}));
		expect(decoder.push("hello world")).toBe("hello world");
	});
	it("expands handle followed by non-name char", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }));
		expect(decoder.push("§foo ")).toBe("bar ");
	});
	it("expands handle in context with trailing text", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }));
		expect(decoder.push("hello §foo world")).toBe("hello bar world");
	});
	it("holds partial sigil and completes on next chunk", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }));
		expect(decoder.push("hello §")).toBe("hello ");
		expect(decoder.push("foo rest")).toBe("bar rest");
	});
	it("holds partial handle name and completes with non-name char", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }));
		expect(decoder.push("§fo")).toBe("");
		expect(decoder.push("o!")).toBe("bar!");
	});
	it("flushes held partial as-is when no match", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }));
		decoder.push("§fo");
		expect(decoder.flush()).toBe("§fo");
	});
	it("flush expands complete held handle", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }));
		decoder.push("§foo");
		expect(decoder.flush()).toBe("bar");
	});
	it("flushes empty when nothing held", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }));
		expect(decoder.flush()).toBe("");
	});
	it("reset clears held content", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }));
		decoder.push("§fo");
		decoder.reset();
		expect(decoder.pending).toBe("");
	});
	it("pending returns held content", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }));
		decoder.push("§fo");
		expect(decoder.pending).toBe("§fo");
	});
	it("handles empty chunk", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }));
		expect(decoder.push("")).toBe("");
	});
	it("expands multiple handles with separators", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar", baz: "qux" }));
		expect(decoder.push("§foo §baz ")).toBe("bar qux ");
	});
	it("does not expand handle followed by word char", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }));
		expect(decoder.push("§foobar ")).toBe("§foobar ");
	});
	it("handles handle at end with trailing space", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }));
		expect(decoder.push("text §foo ")).toBe("text bar ");
	});
	it("handles handle split across three chunks", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }));
		expect(decoder.push("§")).toBe("");
		expect(decoder.push("fo")).toBe("");
		expect(decoder.push("o!")).toBe("bar!");
	});
	it("releases held text when non-name char arrives", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }));
		expect(decoder.push("§fo")).toBe("");
		expect(decoder.push("!")).toBe("§fo!");
	});
	it("handles multiple sigils in one chunk with separators", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }));
		expect(decoder.push("§foo §foo ")).toBe("bar bar ");
	});
	it("handles unknown handle after sigil", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }));
		expect(decoder.push("§unknown ")).toBe("§unknown ");
	});
	it("handles sigil at very start with trailing text", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }));
		expect(decoder.push("§foo rest")).toBe("bar rest");
	});
	it("flush after push with trailing space returns empty", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }));
		decoder.push("§foo ");
		expect(decoder.flush()).toBe("");
	});
	it("handles custom sigil with trailing space", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }, "@"));
		expect(decoder.push("@foo ")).toBe("bar ");
	});
	it("holds partial custom sigil", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }, "@"));
		expect(decoder.push("text @")).toBe("text ");
		expect(decoder.push("foo ")).toBe("bar ");
	});
	it("flush after complete handle returns expanded", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }));
		decoder.push("§foo");
		expect(decoder.flush()).toBe("bar");
	});
	it("push after flush starts fresh", () => {
		const decoder = new StreamDecoder(makeVocab({ foo: "bar" }));
		decoder.push("§foo");
		decoder.flush();
		expect(decoder.push("§foo ")).toBe("bar ");
	});
});

describe("makeStreamDecoder", () => {
	it("returns StreamDecoder instance", () => {
		const decoder = makeStreamDecoder(makeVocab({ foo: "bar" }));
		expect(decoder).toBeInstanceOf(StreamDecoder);
	});
	it("decoder works correctly with trailing space", () => {
		const decoder = makeStreamDecoder(makeVocab({ foo: "bar" }));
		expect(decoder.push("§foo ")).toBe("bar ");
	});
	it("creates independent instances", () => {
		const d1 = makeStreamDecoder(makeVocab({ foo: "bar" }));
		const d2 = makeStreamDecoder(makeVocab({ foo: "bar" }));
		d1.push("§fo");
		expect(d1.pending).toBe("§fo");
		expect(d2.pending).toBe("");
	});
});
