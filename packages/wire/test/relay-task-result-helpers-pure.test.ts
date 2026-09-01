import { describe, expect, it } from "bun:test";
import {
	isRelayFatalCloseCode,
	RELAY_FATAL_CLOSE_REASONS,
	RELAY_MAX_PENDING_SENDS,
	relayFatalCloseReason,
} from "../src/relay";
import { stripTaskResultEnvelope } from "../src/task-result";

describe("stripTaskResultEnvelope", () => {
	it("returns text unchanged when not a task-result envelope", () => {
		expect(stripTaskResultEnvelope("hello")).toBe("hello");
	});
	it("strips output envelope", () => {
		const text = "<task-result>\n<output>\nhello world\n</output>\n</task-result>";
		expect(stripTaskResultEnvelope(text)).toBe("hello world");
	});
	it("strips preview envelope", () => {
		const text = "<task-result>\n<preview>\npreview text\n</preview>\n</task-result>";
		expect(stripTaskResultEnvelope(text)).toBe("preview text");
	});
	it("returns original text when body is empty (falsy fallback)", () => {
		const text = "<task-result>\n<output>\n\n</output>\n</task-result>";
		expect(stripTaskResultEnvelope(text)).toBe(text);
	});
	it("handles output with attributes", () => {
		const text = '<task-result>\n<output lang="en">\nhello\n</output>\n</task-result>';
		expect(stripTaskResultEnvelope(text)).toBe("hello");
	});
	it("returns original text when regex does not match", () => {
		const text = "<task-result>malformed</task-result>";
		expect(stripTaskResultEnvelope(text)).toBe(text);
	});
	it("handles multiline output", () => {
		const text = "<task-result>\n<output>\nline 1\nline 2\nline 3\n</output>\n</task-result>";
		expect(stripTaskResultEnvelope(text)).toBe("line 1\nline 2\nline 3");
	});
	it("handles text that starts with task-result but has no closing tag", () => {
		const text = "<task-result>no closing tag";
		expect(stripTaskResultEnvelope(text)).toBe(text);
	});
});

describe("RELAY_FATAL_CLOSE_REASONS", () => {
	it("has 4001 for room closed", () => {
		expect(RELAY_FATAL_CLOSE_REASONS[4001]).toBe("room closed");
	});
	it("has 4004 for no such room", () => {
		expect(RELAY_FATAL_CLOSE_REASONS[4004]).toBe("no such room");
	});
	it("has 4009 for host already connected", () => {
		expect(RELAY_FATAL_CLOSE_REASONS[4009]).toBe("a host is already connected for this room");
	});
	it("has 4029 for room full", () => {
		expect(RELAY_FATAL_CLOSE_REASONS[4029]).toBe("room is full");
	});
});

describe("isRelayFatalCloseCode", () => {
	it("returns true for 4001", () => {
		expect(isRelayFatalCloseCode(4001)).toBe(true);
	});
	it("returns true for 4004", () => {
		expect(isRelayFatalCloseCode(4004)).toBe(true);
	});
	it("returns true for 4009", () => {
		expect(isRelayFatalCloseCode(4009)).toBe(true);
	});
	it("returns true for 4029", () => {
		expect(isRelayFatalCloseCode(4029)).toBe(true);
	});
	it("returns false for 1000 (normal close)", () => {
		expect(isRelayFatalCloseCode(1000)).toBe(false);
	});
	it("returns false for 0", () => {
		expect(isRelayFatalCloseCode(0)).toBe(false);
	});
	it("returns false for unknown codes", () => {
		expect(isRelayFatalCloseCode(5000)).toBe(false);
	});
});

describe("relayFatalCloseReason", () => {
	it("returns reason for fatal code", () => {
		expect(relayFatalCloseReason(4001)).toBe("room closed");
	});
	it("returns undefined for non-fatal code", () => {
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
