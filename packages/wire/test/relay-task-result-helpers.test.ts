import { describe, expect, it } from "bun:test";
import {
	isRelayFatalCloseCode,
	RELAY_FATAL_CLOSE_REASONS,
	RELAY_MAX_PENDING_SENDS,
	relayFatalCloseReason,
} from "../src/relay";
import { stripTaskResultEnvelope } from "../src/task-result";

describe("RELAY_FATAL_CLOSE_REASONS", () => {
	it("has 4001 room closed", () => {
		expect(RELAY_FATAL_CLOSE_REASONS[4001]).toBe("room closed");
	});

	it("has 4004 no such room", () => {
		expect(RELAY_FATAL_CLOSE_REASONS[4004]).toBe("no such room");
	});

	it("has 4009 host already connected", () => {
		expect(RELAY_FATAL_CLOSE_REASONS[4009]).toBe("a host is already connected for this room");
	});

	it("has 4029 room is full", () => {
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

	it("returns false for 1000 (normal closure)", () => {
		expect(isRelayFatalCloseCode(1000)).toBe(false);
	});

	it("returns false for 1006 (abnormal closure)", () => {
		expect(isRelayFatalCloseCode(1006)).toBe(false);
	});

	it("returns false for 0", () => {
		expect(isRelayFatalCloseCode(0)).toBe(false);
	});

	it("returns false for unknown codes", () => {
		expect(isRelayFatalCloseCode(9999)).toBe(false);
	});
});

describe("relayFatalCloseReason", () => {
	it("returns reason for 4001", () => {
		expect(relayFatalCloseReason(4001)).toBe("room closed");
	});

	it("returns reason for 4004", () => {
		expect(relayFatalCloseReason(4004)).toBe("no such room");
	});

	it("returns undefined for non-fatal code", () => {
		expect(relayFatalCloseReason(1000)).toBeUndefined();
	});

	it("returns undefined for 0", () => {
		expect(relayFatalCloseReason(0)).toBeUndefined();
	});
});

describe("RELAY_MAX_PENDING_SENDS", () => {
	it("is 256", () => {
		expect(RELAY_MAX_PENDING_SENDS).toBe(256);
	});
});

describe("stripTaskResultEnvelope", () => {
	it("returns text unchanged when no envelope", () => {
		expect(stripTaskResultEnvelope("plain text")).toBe("plain text");
	});

	it("strips output envelope", () => {
		const text = "<task-result><output>\nhello world\n</output></task-result>";
		expect(stripTaskResultEnvelope(text)).toBe("hello world");
	});

	it("strips preview envelope", () => {
		const text = "<task-result><preview>\npreview text\n</preview></task-result>";
		expect(stripTaskResultEnvelope(text)).toBe("preview text");
	});

	it("handles output with attributes", () => {
		const text = '<task-result><output lang="en">\ntext\n</output></task-result>';
		expect(stripTaskResultEnvelope(text)).toBe("text");
	});

	it("returns text when body is empty", () => {
		const text = "<task-result><output>\n\n</output></task-result>";
		// Empty body after trim falls back to original text
		expect(stripTaskResultEnvelope(text)).toBe(text);
	});

	it("handles multi-line content", () => {
		const text = "<task-result><output>\nline1\nline2\nline3\n</output></task-result>";
		expect(stripTaskResultEnvelope(text)).toBe("line1\nline2\nline3");
	});

	it("returns text unchanged for non-task-result start", () => {
		expect(stripTaskResultEnvelope("<other>text</other>")).toBe("<other>text</other>");
	});

	it("handles empty string", () => {
		expect(stripTaskResultEnvelope("")).toBe("");
	});
});
