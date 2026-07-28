/**
 * The Comms view names the expand key it was actually given.
 *
 * WHY THIS SUITE EXISTS. The card's key HANDLER already read `app.tools.expand`
 * from the keys the host injected, with a comment saying so: "read off
 * `app.tools.expand` rather than hardcoded here, so a rebound key moves both". The
 * two places that NAME the gesture did not. The footer chip was the literal string
 * `"ctrl+o expand"` and the fold line ended in the literal `· ctrl+o`, so a user who
 * rebound the action was shown a key that no longer unfolds anything, sitting next
 * to a key that does.
 *
 * The empty case is worse and is why the chip is dropped rather than blanked.
 * `expandKeys` defaults to `[]`, so a host that mounts the card without injecting
 * them has no expand gesture at all, and the old chip advertised one anyway.
 *
 * The fold LINE keeps its count in that case. A fold that announces nothing reads
 * as a short message, which is the thing the line exists to prevent, so it degrades
 * to "… 4 more lines" rather than disappearing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IrcBus } from "@veyyon/coding-agent/irc/bus";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** Lines long enough that the stream folds them, so the fold hint is on screen. */
const LONG_BODY = Array.from({ length: 12 }, (_, index) => `line ${index} of a message the stream will fold`).join(
	"\n",
);

let geometry: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false);
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	geometry = stubStdoutGeometry({ columns: 120, rows: 40 });
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	geometry.restore();
});

/**
 * The Comms view of a card built with these expand keys, styling stripped.
 *
 * The message goes through the real `send`, not a hand-built log entry, because
 * the log is written by delivery and a fake row would not prove the stream renders
 * what the bus records.
 */
async function commsView(expandKeys: readonly string[]): Promise<string> {
	for (const id of ["sub-000", "sub-001"]) {
		AgentRegistry.global().register({ id, displayName: id, kind: "sub", session: null, status: "running" });
	}
	await IrcBus.global().send({ from: "sub-000", to: "sub-001", body: LONG_BODY });
	const dashboard = new AgentDashboard({ terminalHeight: 40, expandKeys: [...expandKeys] as never });
	dashboard.handleInput("\x1b[C");
	const text = dashboard
		.render(120)
		.map(line => line.replace(ANSI_PATTERN, ""))
		.join("\n");
	dashboard.dispose();
	return text;
}

describe("the Comms card names the key that expands it", () => {
	/**
	 * The default, and the non-vacuity check for everything below: the view really
	 * is showing, really folded a message, and really printed a chip. A card that
	 * failed to switch views would satisfy a rule written as "does not contain
	 * ctrl+o" while proving nothing.
	 */
	test("shows the fold and the chip for the shipped expand key", async () => {
		const view = await commsView(["ctrl+o"]);

		expect(view).toContain("more lines · ctrl+o");
		expect(view).toContain("ctrl+o expand");
	});

	/**
	 * The regression. A rebound action moves BOTH places that name it, and neither
	 * one is allowed to keep saying `ctrl+o`, because that key no longer expands
	 * anything for this user.
	 */
	test("names the rebound key in the chip and the fold line", async () => {
		const view = await commsView(["alt+shift+j"]);

		expect(view).toContain("more lines · alt+shift+j");
		expect(view).toContain("alt+shift+j expand");
		expect(view).not.toContain("ctrl+o");
	});

	/**
	 * Several keys read as several keys, in the same `a/b` form the settings UI and
	 * `/hotkeys` use, rather than only the first one.
	 */
	test("names every expand key when the action has more than one", async () => {
		const view = await commsView(["ctrl+o", "alt+o"]);

		expect(view).toContain("ctrl+o/alt+o expand");
	});

	/**
	 * No expand key means no chip, because a chip for a gesture nothing can trigger
	 * is worse than one fewer chip. The other chips stay, so this is a dropped chip
	 * rather than a broken footer.
	 */
	test("drops the chip when no expand key reached the card", async () => {
		const view = await commsView([]);

		expect(view).not.toContain("expand");
		expect(view).toContain("up/down scroll");
		expect(view).toContain("esc close");
	});

	/**
	 * And the fold still announces its count with no key to name, because a fold
	 * that says nothing reads as a message that was simply short.
	 */
	test("still counts the folded lines when there is no key to name", async () => {
		const view = await commsView([]);

		expect(view).toMatch(/… \d+ more lines/);
		expect(view).not.toContain("more lines ·");
	});
});
