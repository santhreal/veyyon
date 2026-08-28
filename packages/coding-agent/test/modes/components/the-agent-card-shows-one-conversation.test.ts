/**
 * The Agent Control Center is scoped to the conversation that opened it.
 *
 * WHY THESE TESTS. A process runs several conversations at once: `/new` can
 * leave the previous one streaming in the background, and ACP keeps every open
 * session in one map. The registry and the bus are process-global, so every
 * pane of this card reads a set that is wider than what it may show, and a
 * `/resume` in a long-lived process once listed the subagents of every
 * conversation the process had ever driven.
 *
 * The defect class this closes is a HALF-APPLIED scope. The card shows two
 * panes over the same registry and the same bus, plus a guard on a public
 * method that takes a bare agent id. A pane that forgets the filter produces a
 * card that disagrees with itself: rows an operator can see and cannot open, or
 * traffic from a conversation whose agents are not listed. Each consumer of the
 * scope is asserted here, so a new one added without the filter is visible as a
 * hole rather than as a passing file.
 *
 * A process-wide scope, reached by `/process-manager` and an `a` toggle, was
 * removed as an unfinished surface; the last case pins that `a` is inert, so
 * restoring the key without restoring the rest of the card cannot pass.
 *
 * WHAT THIS DOES NOT CATCH. Nothing here says anything about a conversation in
 * ANOTHER process, and nothing here covers the status line's background chip,
 * which is the only remaining surface for a conversation running off screen.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IrcBus } from "@veyyon/coding-agent/irc/bus";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
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

describe("The roster is the opening conversation's", () => {
	test("lists that conversation's agents and no other's", () => {
		const dashboard = new AgentDashboard({ terminalHeight: 40, scope: "session-a" });

		const shown = textOf(dashboard);

		expect(shown).toContain("alphascout");
		expect(shown).not.toContain("bravoscout");
		dashboard.dispose();
	});
});

describe("The stream is filtered the same way as the roster", () => {
	/**
	 * The half-applied defect, pinned directly: both panes read from the same
	 * card. A stream that skips the filter shows traffic from a conversation
	 * whose agents the roster beside it refuses to list.
	 */
	test("carries this conversation's traffic and not another's", async () => {
		const bus = IrcBus.global();
		await bus.send({ from: "sub-session-a", to: "main:session-a", body: "ALPHAWORD" });
		await bus.send({ from: "sub-session-b", to: "main:session-b", body: "BRAVOWORD" });
		const dashboard = new AgentDashboard({ terminalHeight: 40, scope: "session-a" });
		dashboard.handleInput("\t");

		const shown = textOf(dashboard);

		expect(shown).toContain("ALPHAWORD");
		expect(shown).not.toContain("BRAVOWORD");
		dashboard.dispose();
	});
});

describe("The transcript guard is the scope on screen", () => {
	/**
	 * `openTranscript` takes a bare id, so the id is the whole authorization. It
	 * must refuse an agent the card is not showing and admit one it is — a guard
	 * that refuses a row the operator can see and select reads as a dead Enter
	 * key, and one that admits any id makes the filter above cosmetic.
	 */
	function cardWithOverlaySpy(scope: string | undefined): { dashboard: AgentDashboard; opened: string[] } {
		const opened: string[] = [];
		// `showOverlay` hands back the mounted overlay, and the card hides it on
		// dispose; a stub returning nothing fails there instead of here.
		const ui = {
			showOverlay: () => {
				opened.push("shown");
				return { hide: () => {} };
			},
		} as unknown as TUI;
		return { dashboard: new AgentDashboard({ terminalHeight: 40, scope, ui }), opened };
	}

	test("refuses another conversation's transcript", () => {
		const { dashboard, opened } = cardWithOverlaySpy("session-a");

		dashboard.openTranscript("sub-session-b");

		expect(opened).toEqual([]);
		dashboard.dispose();
	});

	test("opens a transcript from the conversation it is showing", () => {
		const { dashboard, opened } = cardWithOverlaySpy("session-a");

		dashboard.openTranscript("sub-session-a");

		expect(opened).toEqual(["shown"]);
		dashboard.dispose();
	});

	test("a card opened without a conversation opens any of them", () => {
		const { dashboard, opened } = cardWithOverlaySpy(undefined);

		dashboard.openTranscript("sub-session-b");

		expect(opened).toEqual(["shown"]);
		dashboard.dispose();
	});
});

describe("A card opened without a conversation shows every agent it can reach", () => {
	/**
	 * The collab guest and the render-only host state no scope: their refs are
	 * mirrored from elsewhere and there is no conversation to narrow to.
	 */
	test("lists both conversations' agents", () => {
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		const shown = textOf(dashboard);

		expect(shown).toContain("alphascout");
		expect(shown).toContain("bravoscout");
		dashboard.dispose();
	});
});

describe("There is no process-wide scope to switch to", () => {
	/**
	 * `a` widened the card across every conversation in the process. That
	 * surface is gone, so the key does nothing, the frame never advertises it,
	 * and the title carries no scope suffix.
	 */
	test("`a` changes nothing and no scope chip or wide title is offered", () => {
		const dashboard = new AgentDashboard({ terminalHeight: 40, scope: "session-a" });

		const before = textOf(dashboard);
		dashboard.handleInput("a");
		const after = textOf(dashboard);

		expect(after).toBe(before);
		expect(before).not.toContain("bravoscout");
		expect(before).not.toContain("all conversations");
		expect(before).not.toContain("this conversation");
		expect(before).toContain("Agent Control Center");
		dashboard.dispose();
	});
});
