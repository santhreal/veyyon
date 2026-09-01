import { describe, expect, it } from "bun:test";
import { parseJsonlLenient, streamEventCeiling, streamFrameCeiling } from "../src/stream";
import {
	DEFAULT_MAX_STREAM_FRAME_BYTES,
	isStreamFrameLimitError,
	STREAM_FRAME_LIMIT_ERROR_NAME,
	StreamFrameLimitError,
} from "../src/stream-frame-limit";
import { drainModuleLoadEvents, moduleLoadBuffer } from "../src/timing-buffer";

describe("DEFAULT_MAX_STREAM_FRAME_BYTES", () => {
	it("is 64 MiB", () => {
		expect(DEFAULT_MAX_STREAM_FRAME_BYTES).toBe(64 * 1024 * 1024);
	});
});

describe("StreamFrameLimitError", () => {
	it("creates error with correct name", () => {
		const err = new StreamFrameLimitError("line", 100, 50);
		expect(err.name).toBe(STREAM_FRAME_LIMIT_ERROR_NAME);
	});

	it("stores frame kind", () => {
		const err = new StreamFrameLimitError("jsonl-record", 100, 50);
		expect(err.frame).toBe("jsonl-record");
	});

	it("stores observed and allowed bytes", () => {
		const err = new StreamFrameLimitError("sse-line", 200, 100);
		expect(err.observedBytes).toBe(200);
		expect(err.allowedBytes).toBe(100);
	});

	it("message contains frame description", () => {
		const err = new StreamFrameLimitError("line", 100, 50);
		expect(err.message).toContain("line");
		expect(err.message).toContain("100");
		expect(err.message).toContain("50");
	});

	it("is an Error instance", () => {
		const err = new StreamFrameLimitError("line", 100, 50);
		expect(err).toBeInstanceOf(Error);
	});
});

describe("isStreamFrameLimitError", () => {
	it("returns true for StreamFrameLimitError", () => {
		const err = new StreamFrameLimitError("line", 100, 50);
		expect(isStreamFrameLimitError(err)).toBe(true);
	});

	it("returns true for error with matching name", () => {
		const err = { name: STREAM_FRAME_LIMIT_ERROR_NAME };
		expect(isStreamFrameLimitError(err)).toBe(true);
	});

	it("returns false for regular Error", () => {
		expect(isStreamFrameLimitError(new Error("regular"))).toBe(false);
	});

	it("returns false for non-object", () => {
		expect(isStreamFrameLimitError("string")).toBe(false);
		expect(isStreamFrameLimitError(null)).toBe(false);
		expect(isStreamFrameLimitError(undefined)).toBe(false);
	});

	it("returns true for wrapped error via cause", () => {
		const inner = new StreamFrameLimitError("line", 100, 50);
		const wrapper = new Error("wrapper");
		wrapper.cause = inner;
		expect(isStreamFrameLimitError(wrapper)).toBe(true);
	});

	it("returns false for circular cause chain", () => {
		const err: { name?: string; cause?: unknown } = {};
		err.cause = err;
		expect(isStreamFrameLimitError(err)).toBe(false);
	});
});

describe("streamFrameCeiling", () => {
	it("returns declared when positive", () => {
		expect(streamFrameCeiling({ maxFrameBytes: 1000 })).toBe(1000);
	});

	it("returns env ceiling when declared is 0", () => {
		expect(streamFrameCeiling({ maxFrameBytes: 0 })).toBe(DEFAULT_MAX_STREAM_FRAME_BYTES);
	});

	it("returns env ceiling when declared is negative", () => {
		expect(streamFrameCeiling({ maxFrameBytes: -1 })).toBe(DEFAULT_MAX_STREAM_FRAME_BYTES);
	});

	it("returns env ceiling when no limits", () => {
		expect(streamFrameCeiling()).toBe(DEFAULT_MAX_STREAM_FRAME_BYTES);
	});

	it("returns env ceiling when limits is empty", () => {
		expect(streamFrameCeiling({})).toBe(DEFAULT_MAX_STREAM_FRAME_BYTES);
	});
});

describe("streamEventCeiling", () => {
	it("returns declared event ceiling when positive", () => {
		expect(streamEventCeiling({ maxEventBytes: 500 })).toBe(500);
	});

	it("falls back to frame ceiling when event ceiling is 0", () => {
		expect(streamEventCeiling({ maxEventBytes: 0, maxFrameBytes: 1000 })).toBe(1000);
	});

	it("falls back to frame ceiling when no event ceiling", () => {
		expect(streamEventCeiling({ maxFrameBytes: 1000 })).toBe(1000);
	});

	it("falls back to env ceiling when no limits", () => {
		expect(streamEventCeiling()).toBe(DEFAULT_MAX_STREAM_FRAME_BYTES);
	});
});

describe("parseJsonlLenient", () => {
	it("parses valid JSONL", () => {
		const result = parseJsonlLenient('{"a":1}\n{"b":2}\n');
		expect(result).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("returns empty for empty string", () => {
		expect(parseJsonlLenient("")).toEqual([]);
	});

	it("returns empty for whitespace-only", () => {
		expect(parseJsonlLenient("   ")).toEqual([]);
	});

	it("skips invalid lines and continues", () => {
		const result = parseJsonlLenient('{"a":1}\ninvalid\n{"b":2}\n');
		expect(result).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("handles single valid line", () => {
		expect(parseJsonlLenient('{"x":1}')).toEqual([{ x: 1 }]);
	});

	it("handles line without trailing newline", () => {
		expect(parseJsonlLenient('{"a":1}\n{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("calls onSkip for invalid lines", () => {
		const skips: { offset: number; snippet: string }[] = [];
		parseJsonlLenient('{"a":1}\ninvalid\n{"b":2}\n', {
			onSkip: skip => skips.push(skip),
		});
		expect(skips.length).toBe(1);
		expect(skips[0]?.offset).toBe(8);
	});

	it("handles all-invalid input", () => {
		expect(parseJsonlLenient("invalid\ntotal\njunk\n")).toEqual([]);
	});

	it("handles arrays in JSONL", () => {
		expect(parseJsonlLenient("[1,2,3]\n[4,5]\n")).toEqual([
			[1, 2, 3],
			[4, 5],
		]);
	});

	it("handles primitives in JSONL", () => {
		expect(parseJsonlLenient('42\n"hello"\ntrue\n')).toEqual([42, "hello", true]);
	});
});

describe("moduleLoadBuffer", () => {
	it("returns an array", () => {
		const buffer = moduleLoadBuffer();
		expect(Array.isArray(buffer)).toBe(true);
	});

	it("returns the same buffer on subsequent calls", () => {
		const b1 = moduleLoadBuffer();
		const b2 = moduleLoadBuffer();
		expect(b1).toBe(b2);
	});
});

describe("drainModuleLoadEvents", () => {
	it("returns empty array when buffer is empty", () => {
		drainModuleLoadEvents();
		expect(drainModuleLoadEvents()).toEqual([]);
	});

	it("drains events and clears buffer", () => {
		const buffer = moduleLoadBuffer();
		buffer.push({
			path: "test.ts",
			start: 0,
			durationMs: 10,
			imports: [],
		});
		const drained = drainModuleLoadEvents();
		expect(drained.length).toBe(1);
		expect(drained[0]?.path).toBe("test.ts");
		expect(drainModuleLoadEvents()).toEqual([]);
	});
});
