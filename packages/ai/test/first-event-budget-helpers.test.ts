import { describe, expect, it } from "bun:test";
import {
	isPreResponseStall,
	isPreResponseStallMessage,
	openBoundedFirstEventBudget,
	openStallLadderBudget,
	PRE_RESPONSE_STALL_ATTEMPTS,
} from "../src/utils/first-event-budget";

describe("isPreResponseStallMessage", () => {
	it("matches 'timed out'", () => {
		expect(isPreResponseStallMessage("request timed out")).toBe(true);
	});

	it("matches 'timeout'", () => {
		expect(isPreResponseStallMessage("timeout occurred")).toBe(true);
	});

	it("matches 'stream stall'", () => {
		expect(isPreResponseStallMessage("stream stall detected")).toBe(true);
	});

	it("matches 'timedout' (no space)", () => {
		expect(isPreResponseStallMessage("request timedout")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isPreResponseStallMessage("REQUEST TIMED OUT")).toBe(true);
		expect(isPreResponseStallMessage("Timeout")).toBe(true);
	});

	it("does not match unrelated message", () => {
		expect(isPreResponseStallMessage("connection refused")).toBe(false);
	});

	it("does not match empty string", () => {
		expect(isPreResponseStallMessage("")).toBe(false);
	});
});

describe("isPreResponseStall", () => {
	it("returns false for non-Error values", () => {
		expect(isPreResponseStall("string")).toBe(false);
		expect(isPreResponseStall(42)).toBe(false);
		expect(isPreResponseStall(null)).toBe(false);
		expect(isPreResponseStall(undefined)).toBe(false);
		expect(isPreResponseStall({})).toBe(false);
	});

	it("returns true for Error with timeout message", () => {
		expect(isPreResponseStall(new Error("request timed out"))).toBe(true);
	});

	it("returns true for Error with 'timeout' in message", () => {
		expect(isPreResponseStall(new Error("timeout occurred"))).toBe(true);
	});

	it("returns true for Error with 'stream stall' in message", () => {
		expect(isPreResponseStall(new Error("stream stall"))).toBe(true);
	});

	it("returns false for Error with unrelated message", () => {
		expect(isPreResponseStall(new Error("connection refused"))).toBe(false);
	});

	it("returns true for Error named AnthropicConnectionTimeoutError", () => {
		const err = new Error("connection failed");
		err.name = "AnthropicConnectionTimeoutError";
		expect(isPreResponseStall(err)).toBe(true);
	});

	it("returns false for Error with unrelated name", () => {
		const err = new Error("failed");
		err.name = "ConnectionRefusedError";
		expect(isPreResponseStall(err)).toBe(false);
	});
});

describe("PRE_RESPONSE_STALL_ATTEMPTS", () => {
	it("is 2", () => {
		expect(PRE_RESPONSE_STALL_ATTEMPTS).toBe(2);
	});
});

describe("openStallLadderBudget", () => {
	it("returns budget with total = perAttempt * attempts", () => {
		const time = 0;
		const budget = openStallLadderBudget(5000, () => time);
		expect(budget.totalMs).toBe(5000 * PRE_RESPONSE_STALL_ATTEMPTS);
	});

	it("returns undefined total when perAttempt is undefined", () => {
		const budget = openStallLadderBudget(undefined);
		expect(budget.totalMs).toBeUndefined();
	});

	it("returns undefined total when perAttempt is 0", () => {
		const budget = openStallLadderBudget(0);
		expect(budget.totalMs).toBeUndefined();
	});

	it("returns undefined total when perAttempt is negative", () => {
		const budget = openStallLadderBudget(-100);
		expect(budget.totalMs).toBeUndefined();
	});

	it("remainingMs decreases over time", () => {
		let time = 0;
		const budget = openStallLadderBudget(5000, () => time);
		expect(budget.remainingMs()).toBe(10000);
		time = 3000;
		expect(budget.remainingMs()).toBe(7000);
	});

	it("remainingMs clamps to 0", () => {
		let time = 0;
		const budget = openStallLadderBudget(5000, () => time);
		time = 20000;
		expect(budget.remainingMs()).toBe(0);
	});

	it("spent returns true when remaining is 0", () => {
		let time = 0;
		const budget = openStallLadderBudget(5000, () => time);
		time = 20000;
		expect(budget.spent()).toBe(true);
	});

	it("spent returns false when remaining > 0", () => {
		const time = 0;
		const budget = openStallLadderBudget(5000, () => time);
		expect(budget.spent()).toBe(false);
	});

	it("spent returns false when total is undefined", () => {
		const budget = openStallLadderBudget(undefined);
		expect(budget.spent()).toBe(false);
	});

	it("fence returns signal with remaining time", () => {
		const time = 0;
		const budget = openStallLadderBudget(5000, () => time);
		const fence = budget.fence();
		expect(fence.signal).toBeDefined();
		fence.cancel();
	});

	it("fence returns caller signal when total is undefined", () => {
		const budget = openStallLadderBudget(undefined);
		const callerSignal = AbortSignal.abort();
		const fence = budget.fence(callerSignal);
		expect(fence.signal).toBe(callerSignal);
	});
});

describe("openBoundedFirstEventBudget", () => {
	it("returns declared when below ceiling", () => {
		const budget = openBoundedFirstEventBudget(5000, 10000);
		expect(budget.totalMs).toBe(5000);
	});

	it("returns ceiling when declared is undefined", () => {
		const budget = openBoundedFirstEventBudget(undefined, 10000);
		expect(budget.totalMs).toBe(10000);
	});

	it("returns ceiling when declared exceeds ceiling", () => {
		const budget = openBoundedFirstEventBudget(20000, 10000);
		expect(budget.totalMs).toBe(10000);
	});

	it("returns ceiling when declared is 0", () => {
		const budget = openBoundedFirstEventBudget(0, 10000);
		expect(budget.totalMs).toBe(10000);
	});

	it("returns ceiling when declared is negative", () => {
		const budget = openBoundedFirstEventBudget(-100, 10000);
		expect(budget.totalMs).toBe(10000);
	});

	it("remainingMs decreases over time", () => {
		let time = 0;
		const budget = openBoundedFirstEventBudget(10000, 20000, () => time);
		expect(budget.remainingMs()).toBe(10000);
		time = 4000;
		expect(budget.remainingMs()).toBe(6000);
	});

	it("spent returns true when time exceeds total", () => {
		let time = 0;
		const budget = openBoundedFirstEventBudget(5000, 10000, () => time);
		time = 6000;
		expect(budget.spent()).toBe(true);
	});

	it("fence returns signal when budget is active", () => {
		const time = 0;
		const budget = openBoundedFirstEventBudget(10000, 20000, () => time);
		const fence = budget.fence();
		expect(fence.signal).toBeDefined();
		fence.cancel();
	});
});
