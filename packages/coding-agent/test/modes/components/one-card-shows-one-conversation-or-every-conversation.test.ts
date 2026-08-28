/**
 * Switching the Agent Control Center between one conversation and every
 * conversation the process is running.
 *
 * WHY THESE TESTS. A process runs several conversations at once: `/new` can
 * leave the previous one streaming in the background, and ACP keeps every open
 * session in one map. The card was hard-scoped to the conversation that opened
 * it, so the only rows reachable anywhere in the product were the ones for the
 * transcript on screen. Work running off screen had no surface at all.
 *
 * The defect class this closes is a HALF-APPLIED scope. The card shows two
 * panes over the same registry and the same bus, plus a guard on a public
 * method that takes a bare agent id. Widening the roster and leaving the stream
 * narrow, or widening both and leaving the guard on the opening scope, each
 * produces a card that disagrees with itself: rows an operator can see and
 * cannot open, or traffic from a conversation whose agents are not listed. Each
 * consumer of the scope is asserted here, in both directions, so a new one
 * added without following the toggle is visible as a hole rather than as a
 * passing file.
 *
 * The chip and the title are pinned because the scope is otherwise invisible:
 * two conversations with similarly named agents render as one longer list, and
 * an operator who cannot tell which scope they are in cannot tell whether a
 * missing row means the agent finished or means the card is narrow.
 *
 * WHAT THIS DOES NOT CATCH. The scope lives on the card instance, so it resets
 * when the card closes; nothing here says it should persist. It also says
 * nothing about a conversation in ANOTHER process — the registry is
 * process-global and this is a per-process surface.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/dashboard/agent-dashboard";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { IrcBus } from "@veyyon/coding-agent/task/irc-bus";
import type { TUI } from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function deliveringSession(): AgentSession {
	return { deliverIrcMessage: () => true } as unknown as AgentSession;
}

let geometry: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false);
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	const registry = AgentRegistry.global();
	// Two conversations in one process, each a driving agent with one subagent.
	// The driving ids are `main:<sessionId>`, the shape the interactive session
	// registers, so nothing here can pass by matching one hardcoded name.
	for (const [scope, subName] of [
		["session-a", "alphascout"],
		["session-b", "bravoscout"],
	] as const) {
		registry.register({
			id: `main:${scope}`,
			displayName: "main",
			kind: "main",
			session: deliveringSession(),
			status: "running",
			scope,
		});
		registry.register({
			id: `sub-${scope}`,
			displayName: subName,
			kind: "sub",
			parentId: `main:${scope}`,
			session: deliveringSession(),
			status: "running",
		});
	}
	geometry = stubStdoutGeometry({ columns: 120, rows: 40 });
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	geometry.restore();
});

function textOf(dashboard: AgentDashboard): string {
	return dashboard.render(120).join("\n").replace(ANSI_PATTERN, "");
}

describe("The roster follows the scope the card is showing", () => {
	test("opening for one conversation lists only that conversation's agents", () => {
		const dashboard = new AgentDashboard({ terminalHeight: 40, scope: "session-a" });

		const shown = textOf(dashboard);

		expect(shown).toContain("alphascout");
		expect(shown).not.toContain("bravoscout");
		expect(dashboard.showingWholeProcess).toBe(false);
		dashboard.dispose();
	});

	test("opening wide lists every conversation's agents", () => {
		const dashboard = new AgentDashboard({ terminalHeight: 40, scope: "session-a", processScope: true });

		const shown = textOf(dashboard);

		expect(shown).toContain("alphascout");
		expect(shown).toContain("bravoscout");
		expect(dashboard.showingWholeProcess).toBe(true);
		dashboard.dispose();
	});

	test("`a` widens the roster and `a` again narrows it back to the opening conversation", () => {
		const dashboard = new AgentDashboard({ terminalHeight: 40, scope: "session-a" });

		dashboard.handleInput("a");
		const wide = textOf(dashboard);
		dashboard.handleInput("a");
		const narrow = textOf(dashboard);

		expect(wide).toContain("bravoscout");
		// Narrowing returns to the conversation the card was OPENED for, not to
		// whatever conversation happens to be first in the registry.
		expect(narrow).toContain("alphascout");
		expect(narrow).not.toContain("bravoscout");
		dashboard.dispose();
	});
});

describe("The stream follows the same scope as the roster", () => {
	/**
	 * The half-applied defect, pinned directly: one keystroke, both panes read
	 * after it. Widening only the roster leaves the operator looking at rows
	 * whose conversation contributes no traffic.
	 */
	test("one toggle widens the traffic as well as the rows", async () => {
		const bus = IrcBus.global();
		await bus.send({ from: `sub-session-a`, to: `main:session-a`, body: "ALPHAWORD" });
		await bus.send({ from: `sub-session-b`, to: `main:session-b`, body: "BRAVOWORD" });
		const dashboard = new AgentDashboard({ terminalHeight: 40, scope: "session-a" });
		dashboard.handleInput("\t");

		const narrow = textOf(dashboard);
		dashboard.handleInput("a");
		const wide = textOf(dashboard);

		expect(narrow).toContain("ALPHAWORD");
		expect(narrow).not.toContain("BRAVOWORD");
		expect(wide).toContain("ALPHAWORD");
		expect(wide).toContain("BRAVOWORD");
		dashboard.dispose();
	});

	/** And back: narrowing from the stream narrows the stream, not only the roster. */
	test("narrowing again hides the other conversation's traffic", async () => {
		const bus = IrcBus.global();
		await bus.send({ from: `sub-session-b`, to: `main:session-b`, body: "BRAVOWORD" });
		const dashboard = new AgentDashboard({ terminalHeight: 40, scope: "session-a", processScope: true });
		dashboard.handleInput("\t");

		expect(textOf(dashboard)).toContain("BRAVOWORD");
		dashboard.handleInput("a");

		expect(textOf(dashboard)).not.toContain("BRAVOWORD");
		dashboard.dispose();
	});
});

describe("The transcript guard follows the scope on screen", () => {
	/**
	 * `openTranscript` takes a bare id, so the id is the whole authorization. It
	 * must refuse an agent the card is not showing and admit one it is — a guard
	 * pinned to the OPENING scope would refuse a row the operator can see and
	 * select, which reads as a dead Enter key.
	 */
	function cardWithOverlaySpy(processScope: boolean): { dashboard: AgentDashboard; opened: string[] } {
		const opened: string[] = [];
		// `showOverlay` hands back the mounted overlay, and the card hides it on
		// dispose; a stub returning nothing fails there instead of here.
		const ui = {
			showOverlay: () => {
				opened.push("shown");
				return { hide: () => {} };
			},
		} as unknown as TUI;
		return {
			dashboard: new AgentDashboard({ terminalHeight: 40, scope: "session-a", processScope, ui }),
			opened,
		};
	}

	test("refuses another conversation's transcript while showing one conversation", () => {
		const { dashboard, opened } = cardWithOverlaySpy(false);

		dashboard.openTranscript("sub-session-b");

		expect(opened).toEqual([]);
		dashboard.dispose();
	});

	test("opens another conversation's transcript once the card is showing every conversation", () => {
		const { dashboard, opened } = cardWithOverlaySpy(false);

		dashboard.handleInput("a");
		dashboard.openTranscript("sub-session-b");

		expect(opened).toEqual(["shown"]);
		dashboard.dispose();
	});
});

describe("The card says which scope it is in", () => {
	test("the chip offers the scope the key would switch to, in each direction", () => {
		const narrow = new AgentDashboard({ terminalHeight: 40, scope: "session-a" });
		const wide = new AgentDashboard({ terminalHeight: 40, scope: "session-a", processScope: true });

		const narrowText = textOf(narrow);
		const wideText = textOf(wide);

		expect(narrowText).toContain("all conversations");
		expect(wideText).toContain("this conversation");
		narrow.dispose();
		wide.dispose();
	});

	test("only the wide card titles itself for the whole process", () => {
		const narrow = new AgentDashboard({ terminalHeight: 40, scope: "session-a" });
		const wide = new AgentDashboard({ terminalHeight: 40, scope: "session-a", processScope: true });

		expect(textOf(narrow)).not.toContain("Agent Control Center — all conversations");
		expect(textOf(wide)).toContain("Agent Control Center — all conversations");
		narrow.dispose();
		wide.dispose();
	});
});

describe("A card with no conversation of its own has nothing to switch", () => {
	/**
	 * The collab guest and the render-only host state no scope: their refs are
	 * mirrored from elsewhere and there is no conversation to narrow to. The key
	 * must be inert AND unadvertised, because a chip for a key that does nothing
	 * is worse than no chip.
	 */
	test("`a` changes nothing and no scope chip is offered", () => {
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		const before = textOf(dashboard);
		dashboard.handleInput("a");
		const after = textOf(dashboard);

		expect(before).toContain("alphascout");
		expect(before).toContain("bravoscout");
		expect(after).toBe(before);
		expect(dashboard.showingWholeProcess).toBe(false);
		expect(before).not.toContain("all conversations");
		expect(before).not.toContain("this conversation");
		dashboard.dispose();
	});
});
