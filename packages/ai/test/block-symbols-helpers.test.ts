import { describe, expect, it } from "bun:test";
import {
	clearStreamingPartialJson,
	type DemotedThinkingCarrier,
	getStreamingPartialJson,
	isDemotedThinking,
	kCursorExecResolved,
	kDemotedThinking,
	kStreamingArgumentsDone,
	kStreamingBlockIndex,
	kStreamingBlockKind,
	kStreamingLastParseLen,
	kStreamingPartialJson,
	type StreamingPartialJsonCarrier,
	setStreamingPartialJson,
} from "../src/utils/block-symbols";

describe("kStreamingPartialJson", () => {
	it("is a symbol with a descriptive description", () => {
		expect(typeof kStreamingPartialJson).toBe("symbol");
		expect(kStreamingPartialJson.description).toBe("provider.block.partialJson");
	});
});

describe("getStreamingPartialJson", () => {
	it("returns undefined for null", () => {
		expect(getStreamingPartialJson(null)).toBeUndefined();
	});
	it("returns undefined for undefined", () => {
		expect(getStreamingPartialJson(undefined)).toBeUndefined();
	});
	it("returns undefined for empty object", () => {
		expect(getStreamingPartialJson({})).toBeUndefined();
	});
	it("returns value when set", () => {
		const block: StreamingPartialJsonCarrier = {};
		setStreamingPartialJson(block, "partial");
		expect(getStreamingPartialJson(block)).toBe("partial");
	});
	it("returns undefined when cleared", () => {
		const block: StreamingPartialJsonCarrier = {};
		setStreamingPartialJson(block, "partial");
		clearStreamingPartialJson(block);
		expect(getStreamingPartialJson(block)).toBeUndefined();
	});
});

describe("setStreamingPartialJson", () => {
	it("sets value on block", () => {
		const block: StreamingPartialJsonCarrier = {};
		setStreamingPartialJson(block, "data");
		expect(block[kStreamingPartialJson]).toBe("data");
	});
	it("overwrites existing value", () => {
		const block: StreamingPartialJsonCarrier = {};
		setStreamingPartialJson(block, "first");
		setStreamingPartialJson(block, "second");
		expect(block[kStreamingPartialJson]).toBe("second");
	});
	it("can set undefined", () => {
		const block: StreamingPartialJsonCarrier = {};
		setStreamingPartialJson(block, "data");
		setStreamingPartialJson(block, undefined);
		expect(block[kStreamingPartialJson]).toBeUndefined();
	});
});

describe("clearStreamingPartialJson", () => {
	it("clears existing value to undefined", () => {
		const block: StreamingPartialJsonCarrier = {};
		setStreamingPartialJson(block, "data");
		clearStreamingPartialJson(block);
		expect(block[kStreamingPartialJson]).toBeUndefined();
	});
	it("is a no-op when property does not exist", () => {
		const block: StreamingPartialJsonCarrier = {};
		clearStreamingPartialJson(block);
		expect(block[kStreamingPartialJson]).toBeUndefined();
	});
	it("preserves own-ness check (does not set property if absent)", () => {
		const block: StreamingPartialJsonCarrier = {};
		clearStreamingPartialJson(block);
		expect(Object.hasOwn(block, kStreamingPartialJson)).toBe(false);
	});
	it("sets to undefined when property exists", () => {
		const block: StreamingPartialJsonCarrier = {};
		setStreamingPartialJson(block, "data");
		clearStreamingPartialJson(block);
		expect(Object.hasOwn(block, kStreamingPartialJson)).toBe(true);
		expect(block[kStreamingPartialJson]).toBeUndefined();
	});
});

describe("remaining symbols", () => {
	it("kStreamingBlockIndex is a symbol", () => {
		expect(typeof kStreamingBlockIndex).toBe("symbol");
		expect(kStreamingBlockIndex.description).toBe("provider.block.index");
	});
	it("kStreamingLastParseLen is a symbol", () => {
		expect(typeof kStreamingLastParseLen).toBe("symbol");
		expect(kStreamingLastParseLen.description).toBe("provider.block.lastParseLen");
	});
	it("kStreamingArgumentsDone is a symbol", () => {
		expect(typeof kStreamingArgumentsDone).toBe("symbol");
		expect(kStreamingArgumentsDone.description).toBe("provider.block.argumentsDone");
	});
	it("kStreamingBlockKind is a symbol", () => {
		expect(typeof kStreamingBlockKind).toBe("symbol");
		expect(kStreamingBlockKind.description).toBe("provider.block.kind");
	});
	it("kCursorExecResolved is a symbol", () => {
		expect(typeof kCursorExecResolved).toBe("symbol");
		expect(kCursorExecResolved.description).toBe("provider.block.cursorExecResolved");
	});
	it("kDemotedThinking is a symbol", () => {
		expect(typeof kDemotedThinking).toBe("symbol");
		expect(kDemotedThinking.description).toBe("provider.block.demotedThinking");
	});
});

describe("isDemotedThinking", () => {
	it("returns false for null", () => {
		expect(isDemotedThinking(null)).toBe(false);
	});
	it("returns false for undefined", () => {
		expect(isDemotedThinking(undefined)).toBe(false);
	});
	it("returns false for empty object", () => {
		expect(isDemotedThinking({})).toBe(false);
	});
	it("returns false when not set", () => {
		const block: DemotedThinkingCarrier = {};
		expect(isDemotedThinking(block)).toBe(false);
	});
	it("returns true when set to true", () => {
		const block: DemotedThinkingCarrier = {};
		block[kDemotedThinking] = true;
		expect(isDemotedThinking(block)).toBe(true);
	});
	it("returns false when set to false", () => {
		const block: DemotedThinkingCarrier = {};
		block[kDemotedThinking] = false;
		expect(isDemotedThinking(block)).toBe(false);
	});
});
