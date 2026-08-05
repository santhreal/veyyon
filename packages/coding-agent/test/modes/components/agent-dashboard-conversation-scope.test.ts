/**
 * The Live roster of the Agent Control Center, scoped to one conversation.
 *
 * WHY THESE TESTS. The registry is process-global, so a session that re-roots
 * to a different transcript (`/new`, `/resume`) left the previous
 * conversation's subagents in this card: rows an operator could select and
 * press Enter on, handing the main view to an agent working from context the
 * current conversation never had. The card now builds its roster from
 * `listInScope(deps.scope)`.
 *
 * Both directions are asserted in the same file on purpose. A filter that hid
 * EVERY agent would pass a test that only checked the other conversation was
 * absent, and an empty Control Center is a worse failure than the leak it was
 * meant to fix -- especially for the two callers that legitimately have no
 * scope to state: a collab guest, whose refs are mirrored from the host, and a
 * render-only host view.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IrcBus } from "@veyyon/coding-agent/irc/bus";
import { codeNameFor } from "@veyyon/coding-agent/modes/components/agent-activity";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

let geometry: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false);
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	const registry = AgentRegistry.global();
	// Two conversations, each a driving session with one subagent below it. The
	// subagents state no scope and inherit it from the parent, the way the task
	// executor registers them.
	registry.register({
		id: "Main-A",
		displayName: "main",
		kind: "main",
		session: null,
		status: "running",
		scope: "session-a",
	});
	registry.register({
		id: "0-Sub-A",
		displayName: "reviewer",
		kind: "sub",
		parentId: "Main-A",
		session: null,
		status: "running",
	});
	registry.register({
		id: "Main-B",
		displayName: "main",
		kind: "main",
		session: null,
		status: "running",
		scope: "session-b",
	});
	registry.register({
		id: "0-Sub-B",
		displayName: "scout",
		kind: "sub",
		parentId: "Main-B",
		session: null,
		status: "running",
	});
	geometry = stubStdoutGeometry({ columns: 120, rows: 40 });
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	geometry.restore();
});

describe("Live roster scoping", () => {
	/**
	 * The leak this closes: a row for an agent belonging to the transcript this
	 * session replaced. The in-scope row is asserted present in the same test, so
	 * a filter that emptied the roster fails here rather than looking like a fix.
	 *
	 * Call signs are positional, so the other conversation's subagent leaking in
	 * would add a SECOND sub row and print `Otter` next to `Kestrel`; the agent
	 * types name which agent each row actually is.
	 */
	test("renders only the rows of the conversation it was opened for", () => {
		const dashboard = new AgentDashboard({ terminalHeight: 40, scope: "session-a" });

		const shown = dashboard.render(120).join("\n").replace(ANSI_PATTERN, "");

		expect(shown).toContain(codeNameFor(0));
		expect(shown).toContain("reviewer");
		expect(shown).not.toContain(codeNameFor(1));
		expect(shown).not.toContain("scout");
		dashboard.dispose();
	});

	/** The other direction, from the other conversation: each card shows its own subagent. */
	test("renders the other conversation's rows when opened for that conversation", () => {
		const dashboard = new AgentDashboard({ terminalHeight: 40, scope: "session-b" });

		const shown = dashboard.render(120).join("\n").replace(ANSI_PATTERN, "");

		expect(shown).toContain(codeNameFor(0));
		expect(shown).toContain("scout");
		expect(shown).not.toContain(codeNameFor(1));
		expect(shown).not.toContain("reviewer");
		dashboard.dispose();
	});

	/**
	 * A card with no scope shows everything. This is the collab guest and the
	 * render-only host: neither has a local conversation id to state, and hiding
	 * their whole roster would be a silent blank card rather than a filtered one.
	 */
	test("shows every agent when the card states no scope", () => {
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		const shown = dashboard.render(120).join("\n").replace(ANSI_PATTERN, "");

		expect(shown).toContain("reviewer");
		expect(shown).toContain("scout");
		expect(shown).toContain(codeNameFor(0));
		expect(shown).toContain(codeNameFor(1));
		dashboard.dispose();
	});
});
