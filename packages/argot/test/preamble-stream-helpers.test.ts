import { describe, expect, it } from "bun:test";
import { ARGOT_PREAMBLE, renderPreamble } from "../src/preamble";
import { makeStreamDecoder, StreamDecoder } from "../src/stream";
import type { Vocabulary } from "../src/types";

function makeVocab(handles: Record<string, string>): Vocabulary {
	const map = new Map(Object.entries(handles));
	return {
		version: 1,
		sigil: "§",
		handles: map,
		meta: new Map(),
	};
}

describe("renderPreamble", () => {
	it("returns non-empty string", () => {
		expect(renderPreamble().length).toBeGreaterThan(0);
	});

	it("contains Argot heading", () => {
		expect(renderPreamble()).toContain("Argot");
	});

	it("contains § sigil example", () => {
		expect(renderPreamble()).toContain("§");
	});

	it("includes tool instructions when tools=true", () => {
		const text = renderPreamble({ tools: true });
		expect(text).toContain("argot_load");
		expect(text).toContain("argot_unload");
	});

	it("includes AGENTS.dict reference when tools=false", () => {
		const text = renderPreamble({ tools: false });
		expect(text).toContain("AGENTS.dict");
	});

	it("does not include tool instructions by default", () => {
		const text = renderPreamble();
		expect(text).not.toContain("argot_load");
	});
});

describe("ARGOT_PREAMBLE", () => {
	it("is a non-empty string", () => {
		expect(typeof ARGOT_PREAMBLE).toBe("string");
		expect(ARGOT_PREAMBLE.length).toBeGreaterThan(0);
	});
});

describe("StreamDecoder", () => {
	it("returns chunk unchanged when no handles", () => {
		const decoder = new StreamDecoder(makeVocab({}));
		expect(decoder.push("hello world")).toBe("hello world");
	});

	it("expands handles in complete chunks", () => {
		const decoder = new StreamDecoder(makeVocab({ db: "database.ts" }));
		expect(decoder.push("edit §db now")).toBe("edit database.ts now");
	});

	it("holds partial handle at end of chunk", () => {
		const decoder = new StreamDecoder(makeVocab({ db: "database.ts" }));
		const out1 = decoder.push("edit §");
		expect(out1).toBe("edit ");
		const out2 = decoder.push("db now");
		expect(out2).toBe("database.ts now");
	});

	it("flushes held content", () => {
		const decoder = new StreamDecoder(makeVocab({ db: "database.ts" }));
		decoder.push("edit §");
		const flushed = decoder.flush();
		expect(flushed).toBe("§");
	});

	it("flush returns empty when nothing held", () => {
		const decoder = new StreamDecoder(makeVocab({ db: "database.ts" }));
		decoder.push("hello");
		expect(decoder.flush()).toBe("");
	});

	it("reset clears held content", () => {
		const decoder = new StreamDecoder(makeVocab({ db: "database.ts" }));
		decoder.push("edit §");
		decoder.reset();
		expect(decoder.pending).toBe("");
	});

	it("pending returns held content", () => {
		const decoder = new StreamDecoder(makeVocab({ db: "database.ts" }));
		decoder.push("edit §");
		expect(decoder.pending).toBe("§");
	});

	it("returns empty string for empty chunk", () => {
		const decoder = new StreamDecoder(makeVocab({ db: "database.ts" }));
		expect(decoder.push("")).toBe("");
	});

	it("handles sigil not followed by name char", () => {
		const decoder = new StreamDecoder(makeVocab({ db: "database.ts" }));
		expect(decoder.push("edit § now")).toBe("edit § now");
	});

	it("handles unknown handle", () => {
		const decoder = new StreamDecoder(makeVocab({ db: "database.ts" }));
		expect(decoder.push("edit §unknown now")).toBe("edit §unknown now");
	});

	it("handles multiple handles in one chunk", () => {
		const decoder = new StreamDecoder(makeVocab({ db: "database.ts", svc: "service.ts" }));
		const out = decoder.push("§db and §svc");
		decoder.flush();
		expect(out).toBe("database.ts and ");
	});

	it("handles handle at start of chunk", () => {
		const decoder = new StreamDecoder(makeVocab({ db: "database.ts" }));
		expect(decoder.push("§db start")).toBe("database.ts start");
	});

	it("handles handle at end of chunk (held until flush)", () => {
		const decoder = new StreamDecoder(makeVocab({ db: "database.ts" }));
		const out = decoder.push("end §db");
		decoder.flush();
		expect(out).toBe("end ");
	});

	it("flush returns held partial handle unchanged", () => {
		const decoder = new StreamDecoder(makeVocab({ db: "database.ts" }));
		decoder.push("edit §d");
		const flushed = decoder.flush();
		expect(flushed).toBe("§d");
	});
});

describe("makeStreamDecoder", () => {
	it("creates a StreamDecoder instance", () => {
		const decoder = makeStreamDecoder(makeVocab({}));
		expect(decoder).toBeInstanceOf(StreamDecoder);
	});

	it("created decoder is functional", () => {
		const decoder = makeStreamDecoder(makeVocab({ x: "expanded" }));
		decoder.push("§x");
		expect(decoder.flush()).toBe("expanded");
	});
});
