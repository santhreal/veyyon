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
	it("matches case-insensitively", () => {
		expect(isPreResponseStallMessage("TIMED OUT")).toBe(true);
	});
	it("does not match unrelated message", () => {
		expect(isPreResponseStallMessage("connection refused")).toBe(false);
	});
	it("does not match empty string", () => {
		expect(isPreResponseStallMessage("")).toBe(false);
	});
});

describe("isPreResponseStall", () => {
	it("returns false for non-Error", () => {
		expect(isPreResponseStall("string")).toBe(false);
		expect(isPreResponseStall(42)).toBe(false);
		expect(isPreResponseStall(null)).toBe(false);
		expect(isPreResponseStall(undefined)).toBe(false);
	});
	it("returns true for Error with timeout message", () => {
		expect(isPreResponseStall(new Error("timed out"))).toBe(true);
	});
	it("returns true for Error with 'timeout' in message", () => {
		expect(isPreResponseStall(new Error("operation timeout"))).toBe(true);
	});
	it("returns true for AnthropicConnectionTimeoutError", () => {
		const err = new Error("connection failed");
		err.name = "AnthropicConnectionTimeoutError";
		expect(isPreResponseStall(err)).toBe(true);
	});
	it("returns false for unrelated Error", () => {
		expect(isPreResponseStall(new Error("not found"))).toBe(false);
	});
});

describe("PRE_RESPONSE_STALL_ATTEMPTS", () => {
	it("is 2", () => {
		expect(PRE_RESPONSE_STALL_ATTEMPTS).toBe(2);
	});
});

describe("openStallLadderBudget", () => {
	it("returns budget with undefined total when perAttemptMs is undefined", () => {
		const budget = openStallLadderBudget(undefined, () => 0);
		expect(budget.totalMs).toBeUndefined();
		expect(budget.remainingMs()).toBeUndefined();
		expect(budget.spent()).toBe(false);
	});
	it("returns budget with undefined total when perAttemptMs is 0", () => {
		const budget = openStallLadderBudget(0, () => 0);
		expect(budget.totalMs).toBeUndefined();
	});
	it("returns budget with undefined total when perAttemptMs is negative", () => {
		const budget = openStallLadderBudget(-100, () => 0);
		expect(budget.totalMs).toBeUndefined();
	});
	it("returns budget with doubled total for valid perAttemptMs", () => {
		const budget = openStallLadderBudget(5000, () => 0);
		expect(budget.totalMs).toBe(10000);
	});
	it("remainingMs decreases over time", () => {
		let time = 0;
		const budget = openStallLadderBudget(5000, () => time);
		expect(budget.remainingMs()).toBe(10000);
		time = 3000;
		expect(budget.remainingMs()).toBe(7000);
	});
	it("spent returns true when remaining is 0", () => {
		let time = 0;
		const budget = openStallLadderBudget(5000, () => time);
		time = 10000;
		expect(budget.remainingMs()).toBe(0);
		expect(budget.spent()).toBe(true);
	});
	it("remainingMs clamps to 0", () => {
		let time = 0;
		const budget = openStallLadderBudget(5000, () => time);
		time = 20000;
		expect(budget.remainingMs()).toBe(0);
	});
	it("fence returns caller signal when total is undefined", () => {
		const budget = openStallLadderBudget(undefined, () => 0);
		const ac = new AbortController();
		const fence = budget.fence(ac.signal);
		expect(fence.signal).toBe(ac.signal);
		fence.cancel();
	});
});

describe("openBoundedFirstEventBudget", () => {
	it("returns ceiling when declared is undefined", () => {
		const budget = openBoundedFirstEventBudget(undefined, 30000, () => 0);
		expect(budget.totalMs).toBe(30000);
	});
	it("returns ceiling when declared is 0", () => {
		const budget = openBoundedFirstEventBudget(0, 30000, () => 0);
		expect(budget.totalMs).toBe(30000);
	});
	it("returns ceiling when declared is negative", () => {
		const budget = openBoundedFirstEventBudget(-1, 30000, () => 0);
		expect(budget.totalMs).toBe(30000);
	});
	it("returns declared when less than ceiling", () => {
		const budget = openBoundedFirstEventBudget(5000, 30000, () => 0);
		expect(budget.totalMs).toBe(5000);
	});
	it("returns ceiling when declared is greater", () => {
		const budget = openBoundedFirstEventBudget(60000, 30000, () => 0);
		expect(budget.totalMs).toBe(30000);
	});
	it("returns declared when equal to ceiling", () => {
		const budget = openBoundedFirstEventBudget(30000, 30000, () => 0);
		expect(budget.totalMs).toBe(30000);
	});
});
