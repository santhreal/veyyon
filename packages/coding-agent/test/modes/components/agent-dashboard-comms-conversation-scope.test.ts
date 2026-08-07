/**
 * The Comms stream of the Agent Control Center, across TWO conversations in one
 * process.
 *
 * WHY TWO. The pane reads a PROCESS-GLOBAL bus log. With one conversation
 * registered there is no foreign line to hide and no foreign line to leak, so a
 * one-conversation test passes whether the pane filters correctly, filters by
 * the wrong key, or does not filter at all. This is the shape ACP produces:
 * `session/new` keeps every open session in one map, each registered as its own
 * `kind: "main"` with its own scope.
 *
 * Both directions are pinned, because each is a real defect:
 * - a stranger's exchange must not appear;
 * - and a line from THIS conversation whose agent has since been released must
 *   still appear. Filtering by who is in the registry right now got that
 *   backwards, dropping the last words of an agent released moments ago, which
 *   is the same defect pointed the other way, and the one the pane's own
 *   documentation promises not to have.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IrcBus } from "@veyyon/coding-agent/irc/bus";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function deliveringSession(): AgentSession {
	return {
		deliverIrcMessage: async () => "delivered",
		emitIrcRelayObservation: () => {},
	} as unknown as AgentSession;
}

let geometry: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false);
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	const registry = AgentRegistry.global();
	for (const [scope, rootId, subId, peerId] of [
		["session-a", "acp:a", "Scout-A", "Writer-A"],
		["session-b", "acp:b", "Scout-B", "Writer-B"],
	] as const) {
		registry.register({
			id: rootId,
			displayName: "main",
			kind: "main",
			session: deliveringSession(),
			status: "running",
			scope,
		});
		for (const id of [subId, peerId]) {
			registry.register({
				id,
				displayName: "sub",
				kind: "sub",
				parentId: rootId,
				session: deliveringSession(),
				status: "running",
			});
		}
	}
	geometry = stubStdoutGeometry({ columns: 120, rows: 40 });
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	geometry.restore();
});

/** Open the card on the Comms tab and return its rendered text, ANSI stripped. */
function renderComms(scope: string | undefined): { text: string; dispose: () => void } {
	const dashboard = new AgentDashboard({ terminalHeight: 40, scope });
	dashboard.handleInput("\t");
	return { text: dashboard.render(120).join("\n").replace(ANSI_PATTERN, ""), dispose: () => dashboard.dispose() };
}

describe("Comms stream scoping", () => {
	test("shows this conversation's traffic and not another conversation's", async () => {
		const bus = IrcBus.global();
		await bus.send({ from: "Scout-A", to: "Writer-A", body: "ALPHAWORD" });
		await bus.send({ from: "Scout-B", to: "Writer-B", body: "BRAVOWORD" });

		const shown = renderComms("session-a");

		expect(shown.text).toContain("ALPHAWORD");
		expect(shown.text).not.toContain("BRAVOWORD");
		shown.dispose();
	});

	/**
	 * The reverse defect, and the reason the filter reads a RECORDED scope rather
	 * than current registry membership. Re-injecting the membership filter
	 * (`listInScope(scope)` mapped to ids, then `mine.has(from) || mine.has(to)`)
	 * drops this line the moment the agent is unregistered, and passes every
	 * other test in this file.
	 */
	test("keeps the last words of an agent this conversation has since released", async () => {
		const bus = IrcBus.global();
		await bus.send({ from: "Scout-A", to: "Writer-A", body: "ALPHAWORD" });
		AgentRegistry.global().unregister("Scout-A");
		AgentRegistry.global().unregister("Writer-A");

		const shown = renderComms("session-a");

		expect(shown.text).toContain("ALPHAWORD");
		shown.dispose();
	});

	/**
	 * A card with no scope still shows everything: the collab guest and the
	 * render-only host have no conversation id to state, and a blank stream is a
	 * worse failure than an unfiltered one.
	 */
	test("shows every conversation's traffic when the card states no scope", async () => {
		const bus = IrcBus.global();
		await bus.send({ from: "Scout-A", to: "Writer-A", body: "ALPHAWORD" });
		await bus.send({ from: "Scout-B", to: "Writer-B", body: "BRAVOWORD" });

		const shown = renderComms(undefined);

		expect(shown.text).toContain("ALPHAWORD");
		expect(shown.text).toContain("BRAVOWORD");
		shown.dispose();
	});
});
