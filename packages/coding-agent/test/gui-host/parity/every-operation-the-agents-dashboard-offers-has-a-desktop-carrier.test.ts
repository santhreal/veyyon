/**
 * WHY: the terminal's agents dashboard opens from keybindings and offers its
 * operations as public methods of `AgentDashboard`. A new opening key or a new
 * card operation with no desktop decision leaves the window unable to do what
 * the card does, with nothing to say so. This sweep enumerates both at run time
 * and fails on a member with no row and on a row whose member is gone.
 *
 * Not caught: an in-card key handled inside `handleInput` with no public method
 * (the card's letter keys are private to it), and whether the window draws the
 * section a member is mapped to.
 */
import { describe, expect, it } from "bun:test";
import { KEYBINDINGS } from "../../../src/config/keybinding-defs";
import { AGENTS_DASHBOARD_CARRIERS, isAgentsDashboardKey } from "../../../src/gui-host/desktop-parity/agents";
import { membersCarriedBy } from "../../../src/gui-host/desktop-parity/carrier";
import { AgentDashboard } from "../../../src/modes/terminal/components/dashboard/agent-dashboard";

/** Prototype members that are the component's own lifecycle, not an operation the card offers. */
const CARD_LIFECYCLE = ["constructor", "dispose", "handleInput", "isEmpty", "render"];

function dashboardOperations(): string[] {
	const keys = Object.keys(KEYBINDINGS)
		.filter(isAgentsDashboardKey)
		.map(id => `key:${id}`);
	const card = Object.getOwnPropertyNames(AgentDashboard.prototype)
		.filter(name => !CARD_LIFECYCLE.includes(name))
		.map(name => `card:${name}`);
	return [...keys, ...card].sort();
}

describe("the agents dashboard on the desktop", () => {
	it("decides every operation the terminal card offers, and only those", () => {
		const operations = dashboardOperations();
		expect(operations.filter(operation => !(operation in AGENTS_DASHBOARD_CARRIERS))).toEqual([]);
		expect(Object.keys(AGENTS_DASHBOARD_CARRIERS).filter(operation => !operations.includes(operation))).toEqual([]);
	});

	it("carries every operation: no opt-out and no recorded gap", () => {
		expect(membersCarriedBy(AGENTS_DASHBOARD_CARRIERS, "optOut")).toEqual([]);
		expect(membersCarriedBy(AGENTS_DASHBOARD_CARRIERS, "gap")).toEqual([]);
	});

	it("excludes only lifecycle members the card defines", () => {
		const own = Object.getOwnPropertyNames(AgentDashboard.prototype);
		expect(CARD_LIFECYCLE.filter(name => !own.includes(name))).toEqual([]);
	});
});
