/**
 * WHY: `certify_arms` was attached to every autoresearch session, including a
 * serial one with breadth 1.
 *
 * A serial loop has one candidate and no review ring, so the tool has nothing to
 * triage. Offered anyway, it invites a model to invent an arm identity, review
 * its single run against itself, and log the result as certified — a verdict
 * nobody produced. The class this closes is a breadth-only tool reaching a
 * serial session, in either direction: attached when breadth is 1, or missing
 * when breadth is greater.
 *
 * The variant space is the tool registry itself, read at run time from
 * `EXPERIMENT_TOOL_NAMES`, so a new experiment tool that is neither classified
 * as swarm-only nor confirmed serial-safe turns this red rather than inheriting
 * whichever default the newest edit happened to pick.
 *
 * What it does not catch: whether the extension calls `activeToolsFor` at every
 * point it changes modes. The command suite drives those paths.
 */
import { describe, expect, it } from "bun:test";
import {
	activeToolsChanged,
	activeToolsFor,
	EXPERIMENT_TOOL_NAMES,
	SWARM_TOOL_NAMES,
} from "@veyyon/coding-agent/autoresearch/tools/index";

const SERIAL_SAFE = EXPERIMENT_TOOL_NAMES.filter(name => !SWARM_TOOL_NAMES.includes(name));

describe("a swarm-only tool is not offered to a serial loop", () => {
	it("classifies every experiment tool as swarm-only or serial-safe", () => {
		// Pinned by equality, not by count: a new tool lands in neither list and
		// fails here, where the decision is recorded, rather than silently
		// attaching to sessions that cannot use it.
		expect(SWARM_TOOL_NAMES).toEqual(["certify_arms", "start_arm"]);
		expect(SERIAL_SAFE).toEqual(["init_experiment", "run_experiment", "log_experiment", "update_notes"]);
		for (const name of SWARM_TOOL_NAMES) {
			expect(EXPERIMENT_TOOL_NAMES).toContain(name);
		}
	});

	it("withholds the swarm tools from breadth 1 and attaches them above it", () => {
		expect(activeToolsFor([], true, 1)).toEqual(SERIAL_SAFE);
		for (const breadth of [2, 3, 8]) {
			expect(activeToolsFor([], true, breadth)).toEqual(EXPERIMENT_TOOL_NAMES);
		}
	});

	it("detaches every owned tool when the mode goes off, whatever the breadth now says", () => {
		// A session dropping from swarm to serial must not keep the swarm tool it
		// was attached with, so detaching ignores breadth entirely.
		const active = ["bash", ...EXPERIMENT_TOOL_NAMES];
		for (const breadth of [1, 4]) {
			expect(activeToolsFor(active, false, breadth)).toEqual(["bash"]);
		}
	});

	it("drops the swarm tool when a swarm session is re-armed as serial", () => {
		const active = ["bash", ...EXPERIMENT_TOOL_NAMES];
		expect(activeToolsFor(active, true, 1)).toEqual(["bash", ...SERIAL_SAFE]);
	});

	it("preserves the caller's other tools, once each, in their own order", () => {
		// The extension unions this set into whatever the session already had. A
		// duplicate entry would attach a tool twice, and a reorder would churn the
		// tool set on every mode flip.
		const active = ["bash", "read", "log_experiment", "edit"];
		expect(activeToolsFor(active, true, 2)).toEqual(["bash", "read", "edit", ...EXPERIMENT_TOOL_NAMES]);
	});

	it("reports no change for a set that is already correct", () => {
		// This guard is what stops the extension re-arming the tool set on every
		// rehydrate, which reaches the model as a tool-set change per turn.
		const armed = activeToolsFor(["bash"], true, 3);
		expect(activeToolsChanged(armed, activeToolsFor(armed, true, 3))).toBe(false);
		expect(activeToolsChanged(armed, activeToolsFor(armed, true, 1))).toBe(true);
		expect(activeToolsChanged(armed, activeToolsFor(armed, false, 3))).toBe(true);
	});
});
