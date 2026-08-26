/**
 * WHY:
 * Edit benchmark runs spend extra token budget and time if the agent loop continues
 * after the target file has already reached byte/formatted parity with expected fixture.
 * Early-stop short-circuits the loop on match.
 *
 * This suite verifies:
 * 1. buildEarlyStop opts out when earlyStopOnMatch is false or files list is empty.
 * 2. check() verifies actual files against expected fixtures using formatted/indent comparison.
 * 3. onMatch() notifies the caller and logs the early_stop event with attempt index.
 *
 * What this does not catch:
 * Race conditions inside external child process RPC communication.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { buildEarlyStop } from "../../../../src/suites/typescript-edit/adapter/runner/early-stop";
import type { BenchmarkConfig } from "../../../../src/suites/typescript-edit/adapter/runner/types";

describe("early-stop verification", () => {
	const baseConfig: BenchmarkConfig = {
		provider: "test",
		model: "test-model",
		runsPerTask: 1,
		timeout: 1000,
		taskConcurrency: 1,
		earlyStopOnMatch: true,
	};

	it("returns undefined when earlyStopOnMatch is disabled or file list is empty", () => {
		const disabled = buildEarlyStop({
			config: { ...baseConfig, earlyStopOnMatch: false },
			cwd: "/nonexistent",
			expectedDir: "/nonexistent",
			files: ["index.ts"],
			logEvent: async () => {},
			attempt: 1,
			onMatched: () => {},
		});
		expect(disabled).toBeUndefined();

		const emptyFiles = buildEarlyStop({
			config: baseConfig,
			cwd: "/nonexistent",
			expectedDir: "/nonexistent",
			files: [],
			logEvent: async () => {},
			attempt: 1,
			onMatched: () => {},
		});
		expect(emptyFiles).toBeUndefined();
	});

	it("short-circuits and emits early_stop event when file subset matches expected fixture", async () => {
		const temp = await TempDir.create("early-stop-test-");
		try {
			const expectedDir = path.join(temp.path(), "expected");
			const cwd = path.join(temp.path(), "cwd");
			await fs.mkdir(expectedDir, { recursive: true });
			await fs.mkdir(cwd, { recursive: true });
			await fs.writeFile(path.join(expectedDir, "file.ts"), "const x = 42;\n");
			await fs.writeFile(path.join(cwd, "file.ts"), "const x = 0;\n");

			let matchedCallbackCalled = false;
			const loggedEvents: Array<{ type: string; [key: string]: unknown }> = [];

			const earlyStop = buildEarlyStop({
				config: baseConfig,
				cwd,
				expectedDir,
				files: ["file.ts"],
				logEvent: async e => {
					loggedEvents.push(e as { type: string; [key: string]: unknown });
				},
				attempt: 2,
				onMatched: () => {
					matchedCallbackCalled = true;
				},
			});

			expect(earlyStop).toBeDefined();
			if (!earlyStop) throw new Error("earlyStop must be defined");

			// Initial state: not matching
			const matchBefore = await earlyStop.check();
			expect(matchBefore).toBe(false);
			expect(matchedCallbackCalled).toBe(false);

			// Mutate file to match expected content
			await fs.writeFile(path.join(cwd, "file.ts"), "const x = 42;\n");

			const matchAfter = await earlyStop.check();
			expect(matchAfter).toBe(true);

			// Trigger onMatch handler
			await earlyStop.onMatch();
			expect(matchedCallbackCalled).toBe(true);
			expect(loggedEvents).toHaveLength(1);
			expect(loggedEvents[0]).toEqual({
				type: "early_stop",
				attempt: 2,
				reason: "formatted_match",
			});
		} finally {
			await temp.remove();
		}
	});
});
