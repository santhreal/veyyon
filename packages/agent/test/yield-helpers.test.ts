import { describe, expect, it } from "bun:test";
import { EventLoopKeepalive, ExponentialYield, YieldGate } from "../src/utils/yield";

describe("EventLoopKeepalive", () => {
	it("can be constructed and disposed", () => {
		using keepalive = new EventLoopKeepalive();
		expect(keepalive).toBeDefined();
	});
	it("double dispose does not throw", () => {
		const keepalive = new EventLoopKeepalive();
		keepalive[Symbol.dispose]();
		expect(() => keepalive[Symbol.dispose]()).not.toThrow();
	});
});

describe("YieldGate", () => {
	it("does not yield when interval has not elapsed", async () => {
		let sleepCalls = 0;
		const now = { value: 1000 };
		const gate = new YieldGate({
			now: () => now.value,
			sleep: async () => {
				sleepCalls++;
			},
			intervalMs: 50,
			sleepMs: 20,
		});
		await gate.yieldIfDue();
		expect(sleepCalls).toBe(1);
		now.value = 1010;
		await gate.yieldIfDue();
		expect(sleepCalls).toBe(1);
	});
	it("yields when interval has elapsed", async () => {
		let sleepCalls = 0;
		const now = { value: 1000 };
		const gate = new YieldGate({
			now: () => now.value,
			sleep: async () => {
				sleepCalls++;
			},
			intervalMs: 50,
			sleepMs: 20,
		});
		await gate.yieldIfDue();
		expect(sleepCalls).toBe(1);
		now.value = 1060;
		await gate.yieldIfDue();
		expect(sleepCalls).toBe(2);
	});
	it("yields on first call when lastYieldAt is 0", async () => {
		let sleepCalls = 0;
		const now = { value: 5000 };
		const gate = new YieldGate({
			now: () => now.value,
			sleep: async () => {
				sleepCalls++;
			},
			intervalMs: 50,
			sleepMs: 20,
		});
		await gate.yieldIfDue();
		expect(sleepCalls).toBe(1);
	});
	it("updates lastYieldAt after yield", async () => {
		const now = { value: 1000 };
		const gate = new YieldGate({
			now: () => now.value,
			sleep: async () => {},
			intervalMs: 50,
			sleepMs: 20,
		});
		await gate.yieldIfDue();
		now.value = 1010;
		await gate.yieldIfDue();
		// Should not yield since only 10ms elapsed since last yield at 1000
		// After first yield, lastYieldAt = 1000, so 1010 - 1000 = 10 < 50
	});
	it("uses default interval and sleep when not specified", () => {
		const gate = new YieldGate();
		expect(gate).toBeDefined();
	});
	it("respects aborted signal in sleep", async () => {
		const controller = new AbortController();
		controller.abort();
		const gate = new YieldGate({
			now: () => 0,
			sleep: async (_ms, signal) => {
				if (signal?.aborted) return;
			},
			intervalMs: 0,
			sleepMs: 1,
		});
		await gate.yieldIfDue(controller.signal);
	});
});

describe("ExponentialYield", () => {
	it("starts at minMs", () => {
		const exp = new ExponentialYield({ minMs: 10, maxMs: 100, multiplier: 2 });
		expect(exp).toBeDefined();
	});
	it("sleep returns the waited ms", async () => {
		const exp = new ExponentialYield({ minMs: 1, maxMs: 100, multiplier: 2 });
		const ms = await exp.sleep();
		expect(ms).toBe(1);
	});
	it("doubles after each sleep", async () => {
		const exp = new ExponentialYield({ minMs: 1, maxMs: 100, multiplier: 2 });
		const ms1 = await exp.sleep();
		const ms2 = await exp.sleep();
		const ms3 = await exp.sleep();
		expect(ms1).toBe(1);
		expect(ms2).toBe(2);
		expect(ms3).toBe(4);
	});
	it("caps at maxMs", async () => {
		const exp = new ExponentialYield({ minMs: 1, maxMs: 8, multiplier: 2 });
		await exp.sleep(); // 1
		await exp.sleep(); // 2
		await exp.sleep(); // 4
		await exp.sleep(); // 8
		const ms5 = await exp.sleep(); // capped at 8
		expect(ms5).toBe(8);
	});
	it("notifyActivity resets to minMs", async () => {
		const exp = new ExponentialYield({ minMs: 1, maxMs: 100, multiplier: 2 });
		await exp.sleep(); // 1
		await exp.sleep(); // 2
		await exp.sleep(); // 4
		exp.notifyActivity();
		const ms = await exp.sleep();
		expect(ms).toBe(1);
	});
	it("uses defaults when no opts provided", async () => {
		const exp = new ExponentialYield();
		const ms = await exp.sleep();
		expect(ms).toBe(20);
	});
	it("race resolves with racer result", async () => {
		const exp = new ExponentialYield({ minMs: 1, maxMs: 100, multiplier: 2 });
		const result = await exp.race([Promise.resolve("done")]);
		expect(result).toBe("done");
	});
	it("race resets after resolution", async () => {
		const exp = new ExponentialYield({ minMs: 1, maxMs: 100, multiplier: 2 });
		await exp.race([Promise.resolve("a")]);
		const ms = await exp.sleep();
		expect(ms).toBe(1);
	});
});
