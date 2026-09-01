import { describe, expect, it } from "bun:test";
import {
	CREDENTIAL_CLOCK_TOLERANCE_MS,
	epochSecondsToMs,
	isRecordFromFutureClock,
	msToEpochSeconds,
} from "../src/credential-clock";

describe("CREDENTIAL_CLOCK_TOLERANCE_MS", () => {
	it("is 5000", () => {
		expect(CREDENTIAL_CLOCK_TOLERANCE_MS).toBe(5000);
	});
});

describe("isRecordFromFutureClock", () => {
	it("returns false for undefined writtenAtMs", () => {
		expect(isRecordFromFutureClock(undefined, 1000)).toBe(false);
	});
	it("returns false for NaN writtenAtMs", () => {
		expect(isRecordFromFutureClock(Number.NaN, 1000)).toBe(false);
	});
	it("returns false for Infinity writtenAtMs", () => {
		expect(isRecordFromFutureClock(Number.POSITIVE_INFINITY, 1000)).toBe(false);
	});
	it("returns false when writtenAt is in the past", () => {
		expect(isRecordFromFutureClock(500, 1000)).toBe(false);
	});
	it("returns false when writtenAt equals now", () => {
		expect(isRecordFromFutureClock(1000, 1000)).toBe(false);
	});
	it("returns false when writtenAt is within tolerance", () => {
		expect(isRecordFromFutureClock(6000, 1000)).toBe(false);
	});
	it("returns true when writtenAt exceeds tolerance", () => {
		expect(isRecordFromFutureClock(6001, 1000)).toBe(true);
	});
	it("returns false when writtenAt is exactly now + tolerance", () => {
		expect(isRecordFromFutureClock(6000, 1000)).toBe(false);
	});
});

describe("epochSecondsToMs", () => {
	it("converts seconds to milliseconds", () => {
		expect(epochSecondsToMs(5)).toBe(5000);
	});
	it("returns undefined for undefined", () => {
		expect(epochSecondsToMs(undefined)).toBeUndefined();
	});
	it("returns undefined for NaN", () => {
		expect(epochSecondsToMs(Number.NaN)).toBeUndefined();
	});
	it("returns undefined for Infinity", () => {
		expect(epochSecondsToMs(Number.POSITIVE_INFINITY)).toBeUndefined();
	});
	it("handles zero", () => {
		expect(epochSecondsToMs(0)).toBe(0);
	});
	it("handles negative values", () => {
		expect(epochSecondsToMs(-1)).toBe(-1000);
	});
	it("handles fractional seconds", () => {
		expect(epochSecondsToMs(1.5)).toBe(1500);
	});
});

describe("msToEpochSeconds", () => {
	it("converts milliseconds to seconds (floor)", () => {
		expect(msToEpochSeconds(5000)).toBe(5);
	});
	it("floors fractional milliseconds", () => {
		expect(msToEpochSeconds(5999)).toBe(5);
	});
	it("handles zero", () => {
		expect(msToEpochSeconds(0)).toBe(0);
	});
	it("handles negative values", () => {
		expect(msToEpochSeconds(-1000)).toBe(-1);
	});
	it("handles 1ms", () => {
		expect(msToEpochSeconds(1)).toBe(0);
	});
	it("handles 1000ms", () => {
		expect(msToEpochSeconds(1000)).toBe(1);
	});
});
