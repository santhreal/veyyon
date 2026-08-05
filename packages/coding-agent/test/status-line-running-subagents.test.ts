/**
 * Persistent running-subagent count contract for the interactive footline.
 *
 * The count is operating state, not a transient notification: zero remains
 * visible, registry lifecycle events repaint it immediately, and completed or
 * retained records never inflate it. These tests also pin the compact cell
 * width so a count change cannot leave animated/stale text behind.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/components/status-line/component";
import { countRunningSubagentBadgeAgents } from "@veyyon/coding-agent/modes/running-subagent-badge";
import { withIcon } from "@veyyon/coding-agent/modes/theme/icon-label";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

describe("persistent running-subagent footline count", () => {
	let authStorage: AuthStorage;
	let session: AgentSession;
	let tempDir: TempDir;
	let statusLine: StatusLineComponent;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-running-subagents-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		statusLine = new StatusLineComponent(session);
		statusLine.updateSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: [],
			transparent: true,
		});
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	function expected(count: number): string {
		return withIcon(theme.icon.agents, `${count}`);
	}

	function render(columns = 120): string {
		const rendered = statusLine.renderQuietLine(columns);
		if (rendered === null) throw new Error("Running-subagent count must keep the footline present");
		return stripVTControlCharacters(rendered);
	}

	/** Zero is standing state: the first frame contains the exact compact zero chip. */
	it("renders zero on the first frame with its exact cell width", () => {
		const text = expected(0);
		const rendered = render(Bun.stringWidth(text) + 1);

		expect(rendered).toBe(text);
		expect(Bun.stringWidth(rendered)).toBe(Bun.stringWidth(text));
	});

	/** One and multi-digit counts replace the same chip synchronously and obey the terminal-width budget. */
	it("renders exact one and multiple counts without animation lag", () => {
		for (const count of [1, 12]) {
			statusLine.setSubagentCount(count);
			const text = expected(count);
			const rendered = render(Bun.stringWidth(text) + 1);

			expect(rendered).toBe(text);
			expect(Bun.stringWidth(rendered)).toBe(Bun.stringWidth(text));
		}
	});

	/** Width pressure removes optional capability/location text before it can hide the persistent count. */
	it("keeps the count when the footline narrows to exactly its chip width", () => {
		statusLine.updateSettings({
			preset: "custom",
			leftSegments: ["path", "model", "mode"],
			rightSegments: ["context_pct"],
			transparent: true,
		});
		const text = expected(0);

		expect(render(Bun.stringWidth(text) + 1)).toBe(text);
	});

	/**
	 * The canonical registry projection counts only executing subagents. Its
	 * existing lifecycle event stream drives the rendered count back to zero in
	 * the same turn, without retaining the prior completed count in an animation.
	 */
	it("updates on registry transitions and has no stale count after completion", () => {
		const registry = new AgentRegistry();
		const sync = () => statusLine.setSubagentCount(countRunningSubagentBadgeAgents(registry));
		const unsubscribe = registry.onChange(sync);

		registry.register({ id: "main", displayName: "Main", kind: "main", session: null, status: "running" });
		registry.register({ id: "advisor", displayName: "Advisor", kind: "advisor", session: null, status: "running" });
		registry.register({ id: "done", displayName: "Done", kind: "sub", session: null, status: "idle" });
		registry.register({ id: "closed", displayName: "Closed", kind: "sub", session: null, status: "parked" });
		expect(render()).toBe(expected(0));

		registry.register({ id: "one", displayName: "One", kind: "sub", session: null, status: "running" });
		expect(render()).toBe(expected(1));
		registry.register({ id: "two", displayName: "Two", kind: "sub", session: null, status: "running" });
		registry.register({ id: "three", displayName: "Three", kind: "sub", session: null, status: "running" });
		expect(render()).toBe(expected(3));

		registry.setStatus("one", "idle");
		registry.setStatus("two", "parked");
		registry.setStatus("three", "idle");
		const completed = render();
		expect(completed).toBe(expected(0));
		expect(completed).not.toContain("3");
		unsubscribe();
	});
});
