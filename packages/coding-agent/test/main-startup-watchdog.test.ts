/**
 * The startup watchdog (the "Still starting after Ns" stderr interval) must
 * never outlive `runRootCommand`. A throw before the mode handoff used to leak
 * the armed interval into the calling process, which then printed a stall
 * warning naming the REAL ~/.veyyon log path every 10s for the process
 * lifetime (observed polluting whole test-suite runs).
 */
import { describe, expect, it } from "bun:test";
import type { Args } from "@veyyon/coding-agent/cli/args";
import { __startupWatchdogArmedForTests, runRootCommand } from "@veyyon/coding-agent/main";

describe("startup watchdog lifecycle", () => {
	it("disarms the watchdog when startup throws before a mode handoff", async () => {
		const parsed: Args = {
			messages: [],
			fileArgs: [],
			unknownFlags: new Map(),
			unrecognizedFlags: [],
		};
		const boom = new Error("auth discovery exploded");
		await expect(
			runRootCommand(parsed, [], {
				discoverAuthStorage: () => Promise.reject(boom),
			}),
		).rejects.toThrow("auth discovery exploded");
		expect(__startupWatchdogArmedForTests()).toBe(false);
	});
});
