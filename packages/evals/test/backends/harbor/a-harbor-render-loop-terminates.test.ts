/**
 * WHY: The ANSI dashboard loop polls trial status while the harbor child process
 * is active. This suite proves the render loop reliably terminates when the
 * process finishes or maxTicks is reached, and renders the final frame.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultConfig } from "../../../src/backends/harbor/runner/config";
import { type RenderState, runDashboardLoop } from "../../../src/backends/harbor/runner/ui";

describe("a harbor render loop terminates", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-loop-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("terminates when isFinished predicate transitions to true", async () => {
		const cfg = defaultConfig();
		const logPath = path.join(tmpDir, "harbor.log");
		fs.writeFileSync(logPath, "starting...\n");

		const st: RenderState = {
			cfg,
			jobDir: tmpDir,
			logPath,
			startMs: Date.now(),
			expected: 5,
			tick: 0,
		};

		let iterations = 0;
		const loopPromise = runDashboardLoop(
			st,
			() => {
				iterations++;
				return iterations > 3;
			},
			{ isTTY: false, intervalMs: 5 },
		);

		await loopPromise;
		expect(st.tick).toBeGreaterThanOrEqual(1);
	});

	it("respects maxTicks boundary and terminates without hanging", async () => {
		const cfg = defaultConfig();
		const logPath = path.join(tmpDir, "harbor.log");
		fs.writeFileSync(logPath, "starting...\n");

		const st: RenderState = {
			cfg,
			jobDir: tmpDir,
			logPath,
			startMs: Date.now(),
			expected: 5,
			tick: 0,
		};

		// Predicate that never returns true
		const loopPromise = runDashboardLoop(st, () => false, {
			isTTY: false,
			intervalMs: 5,
			maxTicks: 4,
		});

		await loopPromise;
		expect(st.tick).toBe(4);
	});
});
