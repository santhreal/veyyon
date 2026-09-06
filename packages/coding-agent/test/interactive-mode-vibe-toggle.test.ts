/**
 * Contracts: /vibe mode toggle on InteractiveMode.
 *
 * 1. Vibe tools do not exist in the session registry before the mode is entered.
 * 2. Entering registers and activates exactly `read` plus the vibe tools.
 * 3. Exiting unregisters the vibe tools and restores the pre-vibe active toolset
 *    exactly, including the legitimate empty set.
 *
 * Deferred factories must finish before the active toolset or registry changes;
 * rejection must preserve both. This catches treating a pending factory as an
 * array. It does not measure module evaluation or worker execution latency.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { VIBE_TOOL_NAMES } from "@veyyon/coding-agent/tools/agent/vibe";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

describe("InteractiveMode vibe mode toggle", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	let vibeTools: () => AgentTool[] | Promise<AgentTool[]>;
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-vibe-toggle-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		const registryTools = [stubTool("read")];
		vibeTools = () => VIBE_TOOL_NAMES.map(stubTool);

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
			toolRegistry: new Map(registryTools.map(tool => [tool.name, tool])),
			createVibeTools: () => vibeTools(),
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, new EventBus());
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("restores the exact pre-vibe toolset on exit, including an empty one", async () => {
		expect(session.getAllToolNames()).toEqual(["read"]);
		expect(session.getActiveToolNames()).toEqual([]);

		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(true);
		const inMode = session.getActiveToolNames();
		expect(inMode).toContain("read");
		for (const name of VIBE_TOOL_NAMES) {
			expect(inMode).toContain(name);
		}
		expect(inMode.toSorted()).toEqual(["read", ...VIBE_TOOL_NAMES].toSorted());
		expect(session.getAllToolNames().toSorted()).toEqual(["read", ...VIBE_TOOL_NAMES].toSorted());

		// Toggle off: the empty previous toolset must come back — vibe tools
		// must not leak past the mode.
		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(false);
		expect(session.getActiveToolNames()).toEqual([]);
		expect(session.getAllToolNames()).toEqual(["read"]);
	});

	it("waits for deferred tools before activating the complete mode toolset", async () => {
		const deferred = Promise.withResolvers<AgentTool[]>();
		vibeTools = () => deferred.promise;
		let settled = false;
		const activation = session.activateVibeTools(["read"]).finally(() => {
			settled = true;
		});
		void activation.catch(() => {});
		await scheduler.yield();
		expect(settled).toBe(false);
		expect(session.getAllToolNames()).toEqual(["read"]);
		expect(session.getActiveToolNames()).toEqual([]);
		deferred.resolve(VIBE_TOOL_NAMES.map(stubTool));
		await activation;
		expect(session.getActiveToolNames().toSorted()).toEqual(["read", ...VIBE_TOOL_NAMES].toSorted());
		await session.deactivateVibeTools([]);
		expect(session.getAllToolNames()).toEqual(["read"]);
		expect(session.getActiveToolNames()).toEqual([]);
	});

	it("preserves the registry and active tools when deferred construction fails", async () => {
		const deferred = Promise.withResolvers<AgentTool[]>();
		vibeTools = () => deferred.promise;
		const activation = session.activateVibeTools(["read"]);
		void activation.catch(() => {});
		deferred.reject(new Error("Vibe module could not load"));
		await expect(activation).rejects.toThrow("Vibe module could not load");
		expect(session.getAllToolNames()).toEqual(["read"]);
		expect(session.getActiveToolNames()).toEqual([]);
	});
});
