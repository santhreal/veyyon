/**
 * ONE-PLACE lock for the timings the Agent Hub and the Subagent Inbox share.
 *
 * Why this suite exists: all three were declared in both components with the same values, and the inbox's own
 * comment on the gesture window read "matching the hub", which names the coupling without doing anything about
 * it. The two views are separate components with separate render loops and a user moves between them without
 * being told they are different screens, so a cadence that drifts is a felt inconsistency rather than an
 * abstract duplication: the same relative-time column refreshing at two rates, or the same double-tap needing
 * two different rhythms, and the second one reads to a user as the gesture not working.
 *
 * These pin the values, the reasoning behind each one where the number is a judgement about perception rather
 * than about cost, and that neither component declares its own copy again.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	AGENT_VIEW_AGE_TICK_MS,
	AGENT_VIEW_DATA_CHANGE_COALESCE_MS,
	AGENT_VIEW_LEFT_TAP_WINDOW_MS,
} from "@veyyon/coding-agent/modes/components/agent-view-timings";

const COMPONENTS_DIR = path.resolve(import.meta.dir, "../src/modes/components");
const VIEWS = ["agent-hub.ts", "subagent-inbox.ts"];
const OWNER = "agent-view-timings.ts";
const RETIRED_NAMES = ["AGE_TICK_MS", "DATA_CHANGE_RENDER_COALESCE_MS", "LEFT_TAP_WINDOW_MS"];

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

	/** The double-tap window for the left-left close gesture, identical in both views by construction. */
	it("accepts a second left arrow within 500ms as the close gesture", () => {
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
	 * The ratchet. None of the three old names may be declared in either view again, and the check is keyed on
	 * the declaration rather than on a mention so a comment about the history is still allowed.
	 */
	it("declares no retired timing name in either view", async () => {
		const offenders: string[] = [];
		for (const view of VIEWS) {
			const text = await Bun.file(path.join(COMPONENTS_DIR, view)).text();
			for (const name of RETIRED_NAMES) {
				if (new RegExp(`^\\s*const ${name}\\b`, "m").test(text)) offenders.push(`${view} declares ${name}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	/** The positive half: both views take all three from the owner. */
	it("has both views importing all three from the owner", async () => {
		for (const view of VIEWS) {
			const text = await Bun.file(path.join(COMPONENTS_DIR, view)).text();
			expect(text).toMatch(/from "\.\/agent-view-timings";/);
			for (const name of [
				"AGENT_VIEW_AGE_TICK_MS",
				"AGENT_VIEW_DATA_CHANGE_COALESCE_MS",
				"AGENT_VIEW_LEFT_TAP_WINDOW_MS",
			]) {
				expect(text).toContain(name);
			}
		}
	});

	/**
	 * The non-vacuity twin: prove the two files being read are the components in question, so a rename or a
	 * move cannot leave the ratchet passing over the wrong content.
	 */
	it("reads the two components it claims to", async () => {
		const hub = await Bun.file(path.join(COMPONENTS_DIR, "agent-hub.ts")).text();
		const inbox = await Bun.file(path.join(COMPONENTS_DIR, "subagent-inbox.ts")).text();
		expect(hub).toContain("class AgentHubOverlayComponent");
		expect(inbox).toContain("SubagentInbox");
	});

	/**
	 * The owner stays a leaf, and specifically does NOT live in `agent-status-display.ts`. That module's doc
	 * makes it the owner of the AgentStatus visual language and it imports the theme engine to do it; putting a
	 * timing constant there would drag the theme engine behind a number, which is the pressure a separate cut
	 * in this codebase already removed from every code renderer.
	 */
	it("imports nothing, so a timing costs one module and never the theme engine", async () => {
		const owner = await Bun.file(path.join(COMPONENTS_DIR, OWNER)).text();
		expect(owner).not.toMatch(/^\s*import\s/m);
		expect(owner).not.toMatch(/\bfrom\s+"/);
		const statusDisplay = await Bun.file(path.join(COMPONENTS_DIR, "agent-status-display.ts")).text();
		expect(statusDisplay).not.toContain("AGENT_VIEW_AGE_TICK_MS");
	});
});
