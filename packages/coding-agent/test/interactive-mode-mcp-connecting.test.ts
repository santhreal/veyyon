import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@veyyon/pi-agent-core";
import { ModelRegistry } from "@veyyon/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/pi-coding-agent/config/settings";
import {
	MCP_CONNECTION_STATUS_EVENT_CHANNEL,
	type McpConnectionStatusEvent,
} from "@veyyon/pi-coding-agent/mcp/startup-events";
import { InteractiveMode } from "@veyyon/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@veyyon/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/pi-coding-agent/session/session-manager";
import { EventBus } from "@veyyon/pi-coding-agent/utils/event-bus";
import { logger, TempDir } from "@veyyon/pi-utils";

/**
 * Behavioral wiring guard for MCP startup status (mirrors
 * interactive-mode-lsp-startup.test.ts). The SDK emits connection lifecycle
 * events, and InteractiveMode paints the aggregate in the location line's
 * right zone (progress while connecting, a failure pointer once settled) —
 * never a floating transcript banner. This pins the constructor-time
 * subscription and the zone's progression as servers connect or fail.
 */
describe("InteractiveMode MCP connection status", () => {
	let authStorage: AuthStorage;
	let eventBus: EventBus;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		// Keep ProcessTerminal.start() from probing the real terminal; the test
		// only drives the event bus and spies on showStatus.
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-interactive-mode-mcp-connecting-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

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
			settings: Settings.isolated(),
			modelRegistry,
		});
		eventBus = new EventBus();
		mode = new InteractiveMode(session, "test", () => {}, [], undefined, eventBus);
		// This contract is the banner wiring, not git branch watching; a real
		// fs.watch in a parallel Bun worker can trip an unrelated-worker SIGTRAP.
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	const zoneText = (width = 140): string =>
		mode.locationLine
		.render(width)
		.map(line => stripVTControlCharacters(line))
		.join("\n");

	it("routes a mcp:connection-status event through the constructor-registered subscriber, before init()", () => {
		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "connecting",
			serverNames: ["sequential", "critic", "shannon"],
		} satisfies McpConnectionStatusEvent);

		expect(zoneText()).toContain("mcp 0/3");
	});

	it("does not paint the MCP zone when startup.quiet is enabled", () => {
		session.settings.set("startup.quiet", true);

		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "connecting",
			serverNames: ["sequential", "critic"],
		} satisfies McpConnectionStatusEvent);

		expect(zoneText()).not.toContain("mcp");
	});

	it("progresses the zone as servers connect, then settles on a failure pointer", () => {
		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "connecting",
			serverNames: ["alpha", "broken", "slow"],
		} satisfies McpConnectionStatusEvent);
		expect(zoneText()).toContain("mcp 0/3");

		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "connected",
			serverName: "alpha",
		} satisfies McpConnectionStatusEvent);
		expect(zoneText()).toContain("mcp 1/3");

		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "failed",
			serverName: "broken",
			error: "missing command",
		} satisfies McpConnectionStatusEvent);
		expect(zoneText()).toContain("mcp 1/3");

		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "connected",
			serverName: "slow",
		} satisfies McpConnectionStatusEvent);
		// Settled with a failure: the count and the detail pointer, loudly colored,
		// and the per-server error text never leaks into the quiet zone.
		const settled = zoneText();
		expect(settled).toContain("mcp ✗1");
		expect(settled).toContain("/mcp list");
		expect(settled).not.toContain("missing command");
	});

	it("says nothing once every server connects cleanly", () => {
		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "connecting",
			serverNames: ["alpha"],
		} satisfies McpConnectionStatusEvent);
		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "connected",
			serverName: "alpha",
		} satisfies McpConnectionStatusEvent);

		expect(zoneText()).not.toContain("mcp");
	});

	it("rejects a malformed mcp:connection-status payload via the guard instead of letting it throw", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, { wrong: "shape" });

		expect(zoneText()).not.toContain("mcp");
		expect(warnSpy).toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
	});
});
