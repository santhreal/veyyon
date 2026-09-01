import { describe, expect, it } from "bun:test";
import {
	DEFAULT_MAX_STREAM_FRAME_BYTES,
	isStreamFrameLimitError,
	STREAM_FRAME_LIMIT_ERROR_NAME,
	StreamFrameLimitError,
} from "../src/stream-frame-limit";
import { drainModuleLoadEvents, type ModuleLoadEvent, moduleLoadBuffer } from "../src/timing-buffer";

describe("moduleLoadBuffer", () => {
	it("returns an array", () => {
		expect(Array.isArray(moduleLoadBuffer())).toBe(true);
	});
	it("returns the same buffer on repeated calls", () => {
		const buf1 = moduleLoadBuffer();
		const buf2 = moduleLoadBuffer();
		expect(buf1).toBe(buf2);
	});
	it("can push and drain events", () => {
		const buffer = moduleLoadBuffer();
		const event: ModuleLoadEvent = {
			path: "test.ts",
			start: 1000,
			durationMs: 5,
			imports: [],
		};
		buffer.push(event);
		const drained = drainModuleLoadEvents();
		expect(drained).toContain(event);
	});
	it("drain returns empty array after draining", () => {
		const buffer = moduleLoadBuffer();
		buffer.push({ path: "x.ts", start: 0, durationMs: 1, imports: [] });
		drainModuleLoadEvents();
		expect(drainModuleLoadEvents()).toEqual([]);
	});
	it("drain returns empty array when buffer is empty", () => {
		drainModuleLoadEvents();
		expect(drainModuleLoadEvents()).toEqual([]);
	});
	it("drain clears the buffer", () => {
		const buffer = moduleLoadBuffer();
		buffer.push({ path: "a.ts", start: 0, durationMs: 1, imports: [] });
		buffer.push({ path: "b.ts", start: 1, durationMs: 2, imports: [] });
		const drained = drainModuleLoadEvents();
		expect(drained.length).toBe(2);
		expect(moduleLoadBuffer().length).toBe(0);
	});
});

describe("DEFAULT_MAX_STREAM_FRAME_BYTES", () => {
	it("is 64 MiB", () => {
		expect(DEFAULT_MAX_STREAM_FRAME_BYTES).toBe(64 * 1024 * 1024);
	});
});

describe("STREAM_FRAME_LIMIT_ERROR_NAME", () => {
	it("is 'StreamFrameLimitError'", () => {
		expect(STREAM_FRAME_LIMIT_ERROR_NAME).toBe("StreamFrameLimitError");
	});
});

describe("StreamFrameLimitError", () => {
	it("creates error with correct name", () => {
		const error = new StreamFrameLimitError("line", 100, 50);
		expect(error.name).toBe(STREAM_FRAME_LIMIT_ERROR_NAME);
	});
	it("carries frame kind", () => {
		const error = new StreamFrameLimitError("jsonl-record", 100, 50);
		expect(error.frame).toBe("jsonl-record");
	});
	it("carries observed and allowed bytes", () => {
		const error = new StreamFrameLimitError("sse-line", 200, 100);
		expect(error.observedBytes).toBe(200);
		expect(error.allowedBytes).toBe(100);
	});
	it("message includes byte counts", () => {
		const error = new StreamFrameLimitError("line", 200, 100);
		expect(error.message).toContain("200");
		expect(error.message).toContain("100");
	});
	it("message includes frame limit description", () => {
		const error = new StreamFrameLimitError("line", 200, 100);
		expect(error.message).toContain("frame limit");
	});
	it("is an Error instance", () => {
		const error = new StreamFrameLimitError("line", 100, 50);
		expect(error).toBeInstanceOf(Error);
	});
	it("describes line frame correctly", () => {
		const error = new StreamFrameLimitError("line", 100, 50);
		expect(error.message).toContain("line");
	});
	it("describes sse-event frame correctly", () => {
		const error = new StreamFrameLimitError("sse-event", 100, 50);
		expect(error.message).toContain("blank-line dispatch");
	});
});

describe("isStreamFrameLimitError", () => {
	it("returns true for StreamFrameLimitError", () => {
		const error = new StreamFrameLimitError("line", 100, 50);
		expect(isStreamFrameLimitError(error)).toBe(true);
	});
	it("returns false for regular Error", () => {
		expect(isStreamFrameLimitError(new Error("regular"))).toBe(false);
	});
	it("returns false for non-error values", () => {
		expect(isStreamFrameLimitError(null)).toBe(false);
		expect(isStreamFrameLimitError(undefined)).toBe(false);
		expect(isStreamFrameLimitError("string")).toBe(false);
		expect(isStreamFrameLimitError(42)).toBe(false);
	});
	it("returns true for wrapped error with cause chain", () => {
		const frameError = new StreamFrameLimitError("line", 100, 50);
		const wrapped = new Error("wrapper", { cause: frameError });
		expect(isStreamFrameLimitError(wrapped)).toBe(true);
	});
	it("returns true for deeply nested cause chain", () => {
		const frameError = new StreamFrameLimitError("line", 100, 50);
		const mid = new Error("mid", { cause: frameError });
		const outer = new Error("outer", { cause: mid });
		expect(isStreamFrameLimitError(outer)).toBe(true);
	});
	it("returns false for cause chain without StreamFrameLimitError", () => {
		const inner = new Error("inner");
		const outer = new Error("outer", { cause: inner });
		expect(isStreamFrameLimitError(outer)).toBe(false);
	});
	it("handles circular cause references", () => {
		const error: Error & { cause?: unknown } = new Error("circular");
		error.cause = error;
		expect(isStreamFrameLimitError(error)).toBe(false);
	});
	it("returns false for object with wrong name", () => {
		expect(isStreamFrameLimitError({ name: "OtherError" })).toBe(false);
	});
	it("returns true for object with matching name (duck-typed)", () => {
		expect(isStreamFrameLimitError({ name: "StreamFrameLimitError" })).toBe(true);
	});
});
