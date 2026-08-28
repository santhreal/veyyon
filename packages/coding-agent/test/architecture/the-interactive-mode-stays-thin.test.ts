/**
 * WHY: `interactive-mode.ts` was 5605 lines and was the place every terminal
 * feature landed, because it already had every import. The defect class is
 * accretion: a subsystem written inline against the mode's private fields, which
 * then cannot be tested, reused by the RPC/ACP modes, or read by anyone deciding
 * where a change belongs. Three subsystems came out of it in this change — the
 * working line, push-to-talk, and goal mode — and the only thing that keeps them
 * out is a ratchet.
 *
 * The ceiling is a MEASURED number with a recorded reason, not the plan's ~500
 * lines. Reaching 500 means rewriting the interaction layer so every surface
 * draws from a view-model, which is what the shrink-only ledger in
 * `modes-terminal-imports-wire-not-agent.test.ts` records as still owed. What
 * remains here after the extractions is the mode's own state machine plus the
 * `InteractiveModeContext` facade: about 215 members, most of them one-line
 * delegations to a controller, which is the contract every controller is written
 * against and cannot be split without splitting the interface.
 *
 * The second half of the gate is the part that actually bites: no controller may
 * be larger than the mode it was carved out of, and the six controllers that
 * predate this change and already exceed the per-controller ceiling are pinned
 * by exact equality, so a seventh cannot join them without a decision.
 *
 * What it does NOT catch: complexity pushed into a controller's private state
 * rather than lines, and it says nothing about whether the split is at the right
 * seam.
 */

import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import { isDirectory, lineCount, repoPath, repoRelative, typeScriptFiles } from "./helpers/module-graph";

const TERMINAL = repoPath("packages/coding-agent/src/modes/terminal");
const INTERACTIVE_MODE = `${TERMINAL}/interactive-mode.ts`;
const CONTROLLERS = `${TERMINAL}/controllers`;

/**
 * MEASURED 2026-08-28 at 4495 lines, down from 5605, with headroom of roughly
 * ten percent so an ordinary edit does not fail the gate and a new subsystem
 * written inline does.
 */
const INTERACTIVE_MODE_CEILING = 4900;

/**
 * Per-controller ceiling. MEASURED 2026-08-28: the largest controller carved out
 * in this change is `goal-mode-controller.ts` at 916 lines, which carries goal
 * mode whole — the commands, the status badge, the session-event bookkeeping and
 * the autonomous continuation turn.
 */
const CONTROLLER_CEILING = 1000;

/**
 * Controllers that predate this change and already exceed the ceiling. Each one
 * is a subsystem that was written inline and then moved wholesale, and slimming
 * it is its own change. The list is expected to shrink, never grow.
 */
const LEGACY_OVERSIZED_CONTROLLERS: readonly string[] = [
	"command-controller.ts",
	"event-controller.ts",
	"extension-ui-controller.ts",
	"input-controller.ts",
	"mcp-command-controller.ts",
	"selector-controller.ts",
];

function controllers(): string[] {
	return typeScriptFiles(CONTROLLERS).filter(file => !file.endsWith(".test.ts"));
}

describe("the interactive mode stays thin", () => {
	test("the mode and its controllers exist where the gate looks", () => {
		// A moved file would otherwise pass this by measuring nothing.
		expect(isDirectory(CONTROLLERS)).toBe(true);
		expect(lineCount(INTERACTIVE_MODE)).toBeGreaterThan(0);
		expect(controllers().length).toBeGreaterThan(0);
	});

	test("interactive-mode.ts stays under its measured ceiling", () => {
		expect(lineCount(INTERACTIVE_MODE)).toBeLessThanOrEqual(INTERACTIVE_MODE_CEILING);
	});

	test("the ceiling is tight enough to fail", () => {
		// A ceiling more than a quarter above the measured size is not a ratchet.
		expect(INTERACTIVE_MODE_CEILING).toBeLessThanOrEqual(Math.round(lineCount(INTERACTIVE_MODE) * 1.25));
	});

	test("no controller is larger than the mode it was carved out of", () => {
		// An extraction that empties the mode into one enormous sibling has
		// decoupled nothing, and this is the shape that catches it.
		const mode = lineCount(INTERACTIVE_MODE);
		const larger = controllers()
			.filter(file => lineCount(file) >= mode)
			.map(file => `${repoRelative(file)}: ${lineCount(file)} lines`);
		expect(larger).toEqual([]);
	});

	test("only the recorded legacy controllers exceed the per-controller ceiling", () => {
		// Exact equality, derived from the directory: a controller that grows past
		// the ceiling has to be recorded on purpose, and one that is slimmed below
		// it has to be removed.
		const over = controllers()
			.filter(file => lineCount(file) > CONTROLLER_CEILING)
			.map(file => basename(file))
			.sort();
		expect(over).toEqual([...LEGACY_OVERSIZED_CONTROLLERS].sort());
	});

	test("the three subsystems extracted in this change are their own modules", () => {
		// Not a source grep: these are the modules whose absence means the
		// extraction was reverted and the ceiling above was raised to hide it.
		const present = controllers()
			.map(file => basename(file))
			.filter(name => ["goal-mode-controller.ts", "voice-controller.ts", "working-loader.ts"].includes(name))
			.sort();
		expect(present).toEqual(["goal-mode-controller.ts", "voice-controller.ts", "working-loader.ts"]);
	});
});
