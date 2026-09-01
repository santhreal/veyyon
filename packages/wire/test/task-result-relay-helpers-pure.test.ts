import { describe, expect, it } from "bun:test";
import {
	isRelayFatalCloseCode,
	RELAY_FATAL_CLOSE_REASONS,
	RELAY_MAX_PENDING_SENDS,
	relayFatalCloseReason,
} from "../src/relay";
import { stripTaskResultEnvelope } from "../src/task-result";

describe("stripTaskResultEnvelope", () => {
	it("returns text unchanged when not a task-result", () => {
		expect(stripTaskResultEnvelope("hello world")).toBe("hello world");
	});
	it("returns text unchanged for empty string", () => {
		expect(stripTaskResultEnvelope("")).toBe("");
	});
	it("extracts output body from task-result envelope", () => {
		const text = '<task-result status="completed"><output>\nhello world\n</output></task-result>';
		expect(stripTaskResultEnvelope(text)).toBe("hello world");
	});
	it("extracts preview body from task-result envelope", () => {
		const text = '<task-result status="completed"><preview>\npreview text\n</preview></task-result>';
		expect(stripTaskResultEnvelope(text)).toBe("preview text");
	});
	it("returns original when envelope has no body", () => {
		const text = '<task-result status="completed"></task-result>';
		expect(stripTaskResultEnvelope(text)).toBe(text);
	});
	it("returns original when body is empty", () => {
		const text = '<task-result status="completed"><output>\n\n</output></task-result>';
		// trim() on empty string is empty, so falls back to original
		expect(stripTaskResultEnvelope(text)).toBe(text);
	});
	it("handles output with attributes", () => {
		const text = '<task-result status="completed"><output type="text">\nbody\n</output></task-result>';
		expect(stripTaskResultEnvelope(text)).toBe("body");
	});
	it("handles multiline body", () => {
		const text = "<task-result><output>\nline1\nline2\nline3\n</output></task-result>";
		expect(stripTaskResultEnvelope(text)).toBe("line1\nline2\nline3");
	});
	it("does not match when task-result is not at start", () => {
		const text = "prefix <task-result><output>body</output></task-result>";
		expect(stripTaskResultEnvelope(text)).toBe(text);
	});
});

describe("RELAY_FATAL_CLOSE_REASONS", () => {
	it("has reason for 4001 (room closed)", () => {
		expect(RELAY_FATAL_CLOSE_REASONS[4001]).toBe("room closed");
	});
	it("has reason for 4004 (no such room)", () => {
		expect(RELAY_FATAL_CLOSE_REASONS[4004]).toBe("no such room");
	});
	it("has reason for 4009 (host already connected)", () => {
		expect(RELAY_FATAL_CLOSE_REASONS[4009]).toBe("a host is already connected for this room");
	});
	it("has reason for 4029 (room full)", () => {
		expect(RELAY_FATAL_CLOSE_REASONS[4029]).toBe("room is full");
	});
	it("has exactly 4 fatal codes", () => {
		expect(Object.keys(RELAY_FATAL_CLOSE_REASONS).length).toBe(4);
	});
});

describe("isRelayFatalCloseCode", () => {
	it("returns true for known fatal codes", () => {
		expect(isRelayFatalCloseCode(4001)).toBe(true);
		expect(isRelayFatalCloseCode(4004)).toBe(true);
		expect(isRelayFatalCloseCode(4009)).toBe(true);
		expect(isRelayFatalCloseCode(4029)).toBe(true);
	});
	it("returns false for unknown codes", () => {
		expect(isRelayFatalCloseCode(1000)).toBe(false);
		expect(isRelayFatalCloseCode(4000)).toBe(false);
		expect(isRelayFatalCloseCode(5000)).toBe(false);
	});
	it("returns false for 0", () => {
		expect(isRelayFatalCloseCode(0)).toBe(false);
	});
});

describe("relayFatalCloseReason", () => {
	it("returns reason for fatal code", () => {
		expect(relayFatalCloseReason(4001)).toBe("room closed");
	});
	it("returns undefined for transient code", () => {
		expect(relayFatalCloseReason(1000)).toBeUndefined();
	});
	it("returns undefined for unknown code", () => {
		expect(relayFatalCloseReason(9999)).toBeUndefined();
	});
});

describe("RELAY_MAX_PENDING_SENDS", () => {
	it("is 256", () => {
		expect(RELAY_MAX_PENDING_SENDS).toBe(256);
	});
});
