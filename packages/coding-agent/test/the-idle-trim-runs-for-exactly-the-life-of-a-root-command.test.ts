/**
 * The idle trim (`IdleTrim`, which discards compiled code once the process has been quiet) is
 * started when `runRootCommand` begins and stopped when it ends. Every mode runner, interactive,
 * print, RPC and ACP, is entered from inside that call, so each one is covered without its own
 * wiring, and a mode added later is covered the same way.
 *
 * Defects this closes: the trim missing from a mode because it was wired into mode runners one at a
 * time, and the trim outliving the call that started it, which in an embedder or a test process
 * would keep sampling and eventually discard the caller's compiled code.
 *
 * Not caught: a mode runner reached from outside `runRootCommand`. None exists; one added there
 * would have to start the trim itself.
 */
import { describe, expect, it } from "bun:test";
import type { Args } from "@veyyon/coding-agent/cli/args";
import { __idleTrimRunningForTests, runRootCommand } from "@veyyon/coding-agent/main";

describe("idle trim lifetime", () => {
	it("samples while the root command runs and stops when it throws", async () => {
		const parsed: Args = {
			print: true,
			messages: ["what is 2 + 2"],
			fileArgs: [],
			unknownFlags: new Map(),
			unrecognizedFlags: [],
		};
		expect(__idleTrimRunningForTests()).toBe(false);
		let runningDuringStartup: boolean | undefined;
		await expect(
			runRootCommand(parsed, [], {
				discoverAuthStorage: () => {
					runningDuringStartup = __idleTrimRunningForTests();
					return Promise.reject(new Error("auth discovery exploded"));
				},
			}),
		).rejects.toThrow("auth discovery exploded");
		expect(runningDuringStartup).toBe(true);
		expect(__idleTrimRunningForTests()).toBe(false);
	});
});
