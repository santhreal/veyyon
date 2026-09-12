/**
 * WHY. The debug tool's text result and the debug card both print a session through
 * `formatSessionSnapshot`, and the tool's "stopped at" sentence reads `formatLocation`. A session
 * that is running has no source position; printing `undefined:undefined` for it, or dropping the
 * column when the adapter reported one, is what a reader of either surface would notice first.
 *
 * Covers the location predicate (path and line both required, column optional) and which lines a
 * snapshot adds beyond the fixed header. Does not cover the card's chrome or the tool's transport;
 * `differential/the-debug-card-draws-what-main-drew.test.ts` compares the drawn card.
 */

import { describe, expect, it } from "bun:test";
import type { DapSessionSummary } from "@veyyon/coding-agent/debug/dap/types";
import { formatLocation, formatSessionSnapshot } from "@veyyon/coding-agent/debug/session-snapshot";

function summary(overrides: Partial<DapSessionSummary> = {}): DapSessionSummary {
	return {
		id: "dbg-1",
		adapter: "debugpy",
		cwd: "/repo",
		status: "running",
		launchedAt: "2026-01-01T00:00:00.000Z",
		lastUsedAt: "2026-01-01T00:00:01.000Z",
		breakpointFiles: 0,
		breakpointCount: 0,
		functionBreakpointCount: 0,
		outputBytes: 0,
		outputTruncated: false,
		needsConfigurationDone: false,
		...overrides,
	};
}

describe("a debug snapshot reports where the program stopped", () => {
	it("has no location without both a source path and a line", () => {
		expect(formatLocation(undefined)).toBeNull();
		expect(formatLocation(summary())).toBeNull();
		expect(formatLocation(summary({ source: { path: "/repo/app.py" } }))).toBeNull();
		expect(formatLocation(summary({ line: 12 }))).toBeNull();
		expect(formatLocation(summary({ source: { name: "app.py" }, line: 12 }))).toBeNull();
	});

	it("prints path:line, and the column only when the adapter reported one", () => {
		expect(formatLocation(summary({ source: { path: "/repo/app.py" }, line: 12 }))).toBe("/repo/app.py:12");
		expect(formatLocation(summary({ source: { path: "/repo/app.py" }, line: 12, column: 0 }))).toBe(
			"/repo/app.py:12:0",
		);
	});

	it("prints the fixed header alone for a running session with nothing else to report", () => {
		expect(formatSessionSnapshot(summary())).toEqual([
			"Session dbg-1",
			"Adapter: debugpy",
			"Status: running",
			"CWD: /repo",
		]);
	});

	it("adds one line per reported fact, in reading order, for a stopped session", () => {
		const lines = formatSessionSnapshot(
			summary({
				status: "stopped",
				program: "app.py",
				stopReason: "breakpoint",
				frameName: "main",
				instructionPointerReference: "0x401000",
				source: { path: "/repo/app.py" },
				line: 12,
				column: 4,
				needsConfigurationDone: true,
			}),
		);
		expect(lines).toEqual([
			"Session dbg-1",
			"Adapter: debugpy",
			"Status: stopped",
			"CWD: /repo",
			"Program: app.py",
			"Stop reason: breakpoint",
			"Frame: main",
			"Instruction pointer: 0x401000",
			"Location: /repo/app.py:12:4",
			"Configuration: pending configurationDone; set breakpoints, then continue.",
		]);
	});

	it("reports an exit code of zero for a terminated session", () => {
		expect(formatSessionSnapshot(summary({ status: "terminated", exitCode: 0 })).at(-1)).toBe("Exit code: 0");
	});
});
