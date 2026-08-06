/**
 * ONE-PLACE lock for the timings the agent surfaces share.
 *
 * Why this suite exists: all three were declared in both the Agent Hub overlay and the Subagent Inbox with the
 * same values, and the inbox's own comment on the gesture window read "matching the hub", which names the
 * coupling without doing anything about it. Both views were replaced by the Agent Control Center, and the
 * coupling outlived them: the card owns the age tick and the coalesce window, and the input controller owns the
 * double-tap window for the gesture that opens the card. That is still more than one file agreeing on the same
 * three numbers, which is exactly the condition under which a copy drifts, and a drifted copy is felt rather
 * than abstract: the same relative-time column refreshing at two rates, or a gesture that needs one rhythm to
 * open a view and another to leave it, which reads to a user as the gesture not working.
 *
 * These pin the values, the reasoning behind each one where the number is a judgement about perception rather
 * than about cost, and that no consumer declares its own copy again.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	AGENT_VIEW_AGE_TICK_MS,
	AGENT_VIEW_DATA_CHANGE_COALESCE_MS,
	AGENT_VIEW_LEFT_TAP_WINDOW_MS,
} from "@veyyon/coding-agent/modes/components/agent-view-timings";
import { moduleSpecifiersIn, namedImportsFrom } from "@veyyon/utils/module-reach";

const SRC_DIR = path.resolve(import.meta.dir, "../src");
const COMPONENTS_DIR = path.join(SRC_DIR, "modes/components");
const OWNER = path.join(COMPONENTS_DIR, "agent-view-timings.ts");

/** Every file that consumes a shared timing, and the names it must take from the owner. */
const CONSUMERS = [
	{
		file: path.join(COMPONENTS_DIR, "agent-dashboard.ts"),
		proves: "class AgentDashboard",
		names: ["AGENT_VIEW_AGE_TICK_MS", "AGENT_VIEW_DATA_CHANGE_COALESCE_MS"],
		specifier: "./agent-view-timings",
	},
	{
		file: path.join(SRC_DIR, "modes/controllers/input-controller.ts"),
		proves: "class InputController",
		names: ["AGENT_VIEW_LEFT_TAP_WINDOW_MS"],
		specifier: "../../modes/components/agent-view-timings",
	},
] as const;

/**
 * Names a consumer must never declare again. The first three are the per-view copies this module replaced; the
 * fourth is the input controller's own 500ms literal, which restated the gesture window under a local name for
 * as long as the two views owned the shared one.
 */
const RETIRED_NAMES = [
	"AGE_TICK_MS",
	"DATA_CHANGE_RENDER_COALESCE_MS",
	"LEFT_TAP_WINDOW_MS",
	"LEFT_DOUBLE_TAP_MAX_GAP_MS",
];

describe("the shared agent-view timings", () => {
	/**
	 * The repaint cadence for the relative-time column. Five seconds is chosen against what the label SHOWS,
	 * not against render cost: minute-granularity text is at most five seconds stale, which nobody notices,
	 * and a shorter tick repaints for nothing.
	 */
	it("advances the age column every five seconds", () => {
		expect(AGENT_VIEW_AGE_TICK_MS).toBe(5_000);
	});

	/**
	 * The burst-coalescing window. A subagent starting emits several events in quick succession, and
	 * repainting per event flickers the table.
	 */
	it("coalesces a change burst into one repaint after 100ms", () => {
		expect(AGENT_VIEW_DATA_CHANGE_COALESCE_MS).toBe(100);
	});

	/** The double-tap window for the left-left gesture, identical going in and coming out by construction. */
	it("accepts a second left arrow within 500ms as the gesture", () => {
		expect(AGENT_VIEW_LEFT_TAP_WINDOW_MS).toBe(500);
	});

	/**
	 * The coalescing window has to stay well under the age tick, or a change burst would be repainted by the
	 * age ticker before its own timer fired and the coalescing would be doing nothing.
	 */
	it("keeps the coalesce window far below the age tick", () => {
		expect(AGENT_VIEW_DATA_CHANGE_COALESCE_MS).toBeLessThan(AGENT_VIEW_AGE_TICK_MS / 10);
	});

	/**
	 * The gesture window has to be longer than the coalesce window. If a repaint could land between two taps
	 * and the window were shorter than that repaint, the second tap would arrive after the window closed and
	 * the gesture would fail exactly when the view was busy, which is when a user most wants to leave it.
	 */
	it("keeps the gesture window longer than a coalesced repaint", () => {
		expect(AGENT_VIEW_LEFT_TAP_WINDOW_MS).toBeGreaterThan(AGENT_VIEW_DATA_CHANGE_COALESCE_MS);
	});

	/** All three are positive integers, since each is handed to a timer. */
	it("holds positive integer millisecond values", () => {
		for (const value of [AGENT_VIEW_AGE_TICK_MS, AGENT_VIEW_DATA_CHANGE_COALESCE_MS, AGENT_VIEW_LEFT_TAP_WINDOW_MS]) {
			expect(Number.isInteger(value)).toBeTrue();
			expect(value).toBeGreaterThan(0);
		}
	});
});

describe("timing ownership", () => {
	/**
	 * The ratchet. No consumer may declare any retired timing name again, and the check is keyed on the
	 * declaration rather than on a mention so a comment about the history is still allowed.
	 */
	it("declares no retired timing name in any consumer", async () => {
		const offenders: string[] = [];
		for (const consumer of CONSUMERS) {
			const text = await Bun.file(consumer.file).text();
			for (const name of RETIRED_NAMES) {
				if (new RegExp(`^\\s*const ${name}\\b`, "m").test(text)) {
					offenders.push(`${path.basename(consumer.file)} declares ${name}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * The positive half, read as an import EDGE rather than as characters. `toContain(name)` was satisfied by
	 * the name appearing in a comment, and it said nothing about where the value came from. A binding taken
	 * from the owner settles both halves at once: TypeScript refuses a module that imports a name and also
	 * declares it, so the edge is the compiler's guarantee that no private copy exists.
	 */
	it("has every consumer importing its timings from the owner", async () => {
		for (const consumer of CONSUMERS) {
			const text = await Bun.file(consumer.file).text();
			const bound = namedImportsFrom(text, consumer.specifier).sort();
			expect(bound).toEqual([...consumer.names].sort());
		}
	});

	/**
	 * Utilization: every exported timing has at least one non-test consumer. When the two views were deleted,
	 * the gesture window briefly had none while the input controller kept its own 500ms literal, which is a
	 * shared constant that no longer shares anything and a duplicate hiding behind a different name.
	 *
	 * Counted over bindings, so a name surviving only in a comment no longer answers for a consumer.
	 */
	it("has a real consumer for every exported timing", async () => {
		const bound = new Set<string>();
		for (const consumer of CONSUMERS) {
			const text = await Bun.file(consumer.file).text();
			for (const name of namedImportsFrom(text, consumer.specifier)) bound.add(name);
		}
		expect([...bound].sort()).toEqual([
			"AGENT_VIEW_AGE_TICK_MS",
			"AGENT_VIEW_DATA_CHANGE_COALESCE_MS",
			"AGENT_VIEW_LEFT_TAP_WINDOW_MS",
		]);
	});

	/**
	 * The non-vacuity twin: prove the files being read are the modules in question, so a rename or a move
	 * cannot leave the ratchet passing over the wrong content.
	 */
	it("reads the consumers it claims to", async () => {
		for (const consumer of CONSUMERS) {
			const text = await Bun.file(consumer.file).text();
			expect(text).toContain(consumer.proves);
		}
	});

	/**
	 * The owner stays a leaf, and specifically does NOT live in `agent-status-display.ts`. That module's doc
	 * makes it the owner of the AgentStatus visual language and it imports the theme engine to do it; putting a
	 * timing constant there would drag the theme engine behind a number, which is the pressure a separate cut
	 * in this codebase already removed from every code renderer.
	 */
	it("imports nothing, so a timing costs one module and never the theme engine", async () => {
		const owner = await Bun.file(OWNER).text();
		// The PARSED specifier list, not the characters: the scan this replaced also went red on a doc
		// comment containing `from "..."`, and on a free `import type`, which costs nothing at runtime.
		expect(moduleSpecifiersIn(owner)).toEqual([]);
		const statusDisplay = await Bun.file(path.join(COMPONENTS_DIR, "agent-status-display.ts")).text();
		expect(namedImportsFrom(statusDisplay, "./agent-view-timings")).toEqual([]);
	});
});
