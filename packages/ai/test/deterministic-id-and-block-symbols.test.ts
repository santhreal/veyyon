import { describe, expect, it } from "bun:test";
import {
	clearStreamingPartialJson,
	type DemotedThinkingCarrier,
	getStreamingPartialJson,
	isDemotedThinking,
	kDemotedThinking,
	kStreamingPartialJson,
	type StreamingPartialJsonCarrier,
	setStreamingPartialJson,
} from "../src/utils/block-symbols";
import { deterministicUuid } from "../src/utils/deterministic-id";

describe("deterministicUuid", () => {
	it("returns a UUID-shaped string", () => {
		const uuid = deterministicUuid("test");
		expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it("is deterministic for same seed", () => {
		expect(deterministicUuid("seed1")).toBe(deterministicUuid("seed1"));
	});

	it("returns different UUIDs for different seeds", () => {
		expect(deterministicUuid("seed1")).not.toBe(deterministicUuid("seed2"));
	});

	it("handles empty seed", () => {
		const uuid = deterministicUuid("");
		expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it("handles long seed", () => {
		const uuid = deterministicUuid("a".repeat(1000));
		expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it("handles unicode seed", () => {
		const uuid = deterministicUuid("🦀");
		expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it("produces different UUIDs for different unicode seeds", () => {
		expect(deterministicUuid("🦀")).not.toBe(deterministicUuid("🐍"));
	});
});

describe("getStreamingPartialJson", () => {
	it("returns undefined for null", () => {
		expect(getStreamingPartialJson(null)).toBeUndefined();
	});

	it("returns undefined for undefined", () => {
		expect(getStreamingPartialJson(undefined)).toBeUndefined();
	});

	it("returns undefined for object without symbol", () => {
		expect(getStreamingPartialJson({})).toBeUndefined();
	});

	it("returns value when set", () => {
		const block: StreamingPartialJsonCarrier = {};
		setStreamingPartialJson(block, "partial");
		expect(getStreamingPartialJson(block)).toBe("partial");
	});

	it("returns undefined when set to undefined", () => {
		const block: StreamingPartialJsonCarrier = {};
		setStreamingPartialJson(block, undefined);
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
		expect(getStreamingPartialJson(block)).toBe("second");
	});

	it("sets undefined to clear", () => {
		const block: StreamingPartialJsonCarrier = {};
		setStreamingPartialJson(block, "data");
		setStreamingPartialJson(block, undefined);
		expect(getStreamingPartialJson(block)).toBeUndefined();
	});
});

describe("clearStreamingPartialJson", () => {
	it("clears existing value", () => {
		const block: StreamingPartialJsonCarrier = {};
		setStreamingPartialJson(block, "data");
		clearStreamingPartialJson(block);
		expect(getStreamingPartialJson(block)).toBeUndefined();
	});

	it("does nothing on block without symbol", () => {
		const block: StreamingPartialJsonCarrier = {};
		expect(() => clearStreamingPartialJson(block)).not.toThrow();
	});

	it("does nothing on already-cleared block", () => {
		const block: StreamingPartialJsonCarrier = {};
		setStreamingPartialJson(block, "data");
		clearStreamingPartialJson(block);
		clearStreamingPartialJson(block);
		expect(getStreamingPartialJson(block)).toBeUndefined();
	});
});

describe("isDemotedThinking", () => {
	it("returns false for null", () => {
		expect(isDemotedThinking(null)).toBe(false);
	});

	it("returns false for undefined", () => {
		expect(isDemotedThinking(undefined)).toBe(false);
	});

	it("returns false for object without symbol", () => {
		expect(isDemotedThinking({})).toBe(false);
	});

	it("returns true when demoted flag is true", () => {
		const block: DemotedThinkingCarrier = {};
		block[kDemotedThinking] = true;
		expect(isDemotedThinking(block)).toBe(true);
	});

	it("returns false when demoted flag is false", () => {
		const block: DemotedThinkingCarrier = {};
		block[kDemotedThinking] = false;
		expect(isDemotedThinking(block)).toBe(false);
	});

	it("returns false when demoted flag is undefined", () => {
		const block: DemotedThinkingCarrier = {};
		block[kDemotedThinking] = undefined;
		expect(isDemotedThinking(block)).toBe(false);
	});
});
