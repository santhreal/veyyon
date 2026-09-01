import { describe, expect, it } from "bun:test";
import {
	isRelayFatalCloseCode,
	RELAY_FATAL_CLOSE_REASONS,
	RELAY_MAX_PENDING_SENDS,
	relayFatalCloseReason,
} from "../src/relay";

describe("RELAY_FATAL_CLOSE_REASONS", () => {
	it("maps 4001 to room closed", () => {
		expect(RELAY_FATAL_CLOSE_REASONS[4001]).toBe("room closed");
	});

	it("maps 4004 to no such room", () => {
		expect(RELAY_FATAL_CLOSE_REASONS[4004]).toBe("no such room");
	});

	it("maps 4009 to host already connected", () => {
		expect(RELAY_FATAL_CLOSE_REASONS[4009]).toBe("a host is already connected for this room");
	});

	it("maps 4029 to room is full", () => {
		expect(RELAY_FATAL_CLOSE_REASONS[4029]).toBe("room is full");
	});

	it("has exactly 4 fatal codes", () => {
		expect(Object.keys(RELAY_FATAL_CLOSE_REASONS).length).toBe(4);
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

	it("returns false for 1001 (going away)", () => {
		expect(isRelayFatalCloseCode(1001)).toBe(false);
	});

	it("returns false for 0", () => {
		expect(isRelayFatalCloseCode(0)).toBe(false);
	});

	it("returns false for negative codes", () => {
		expect(isRelayFatalCloseCode(-1)).toBe(false);
	});

	it("returns false for 4010 (not in map)", () => {
		expect(isRelayFatalCloseCode(4010)).toBe(false);
	});

	it("returns false for 4000 (not in map)", () => {
		expect(isRelayFatalCloseCode(4000)).toBe(false);
	});
});

describe("relayFatalCloseReason", () => {
	it("returns reason for 4001", () => {
		expect(relayFatalCloseReason(4001)).toBe("room closed");
	});

	it("returns reason for 4004", () => {
		expect(relayFatalCloseReason(4004)).toBe("no such room");
	});

	it("returns reason for 4009", () => {
		expect(relayFatalCloseReason(4009)).toBe("a host is already connected for this room");
	});

	it("returns reason for 4029", () => {
		expect(relayFatalCloseReason(4029)).toBe("room is full");
	});

	it("returns undefined for non-fatal code", () => {
		expect(relayFatalCloseReason(1000)).toBeUndefined();
	});

	it("returns undefined for unknown code", () => {
		expect(relayFatalCloseReason(9999)).toBeUndefined();
	});

	it("returns undefined for 0", () => {
		expect(relayFatalCloseReason(0)).toBeUndefined();
	});
});

describe("RELAY_MAX_PENDING_SENDS", () => {
	it("is 256", () => {
		expect(RELAY_MAX_PENDING_SENDS).toBe(256);
	});

	it("is a positive integer", () => {
		expect(Number.isInteger(RELAY_MAX_PENDING_SENDS)).toBe(true);
		expect(RELAY_MAX_PENDING_SENDS).toBeGreaterThan(0);
	});
});
