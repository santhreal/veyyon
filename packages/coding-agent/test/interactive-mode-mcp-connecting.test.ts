import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import {
	MCP_CONNECTION_STATUS_EVENT_CHANNEL,
	type McpConnectionStatusEvent,
} from "@veyyon/coding-agent/mcp/startup-events";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { logger, TempDir } from "@veyyon/utils";

/**
 * Behavioral wiring guard for MCP startup status (mirrors
 * interactive-mode-lsp-startup.test.ts). The SDK emits connection lifecycle
 * events, and InteractiveMode renders boot health in the location line's right
 * zone — a quiet fixed home, not a floating transcript status. This pins the
 * constructor-time subscription and the zone's update path as servers connect
 * and fail.
 */

/** The location line's right zone is where MCP boot health lives. */
function locationText(mode: InteractiveMode): string {
	return stripVTControlCharacters(mode.locationLine.render(140).join("\n"));
}
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

	it("routes a mcp:connection-status event through the constructor-registered subscriber, before init()", () => {
		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "connecting",
			serverNames: ["sequential", "critic", "shannon"],
		} satisfies McpConnectionStatusEvent);

		expect(locationText(mode)).toContain("mcp 0/3");
	});

	it("does not surface MCP boot health when startup.quiet is enabled", () => {
		session.settings.set("startup.quiet", true);

		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, {
			type: "connecting",
			serverNames: ["sequential", "critic"],
		} satisfies McpConnectionStatusEvent);

		expect(locationText(mode)).not.toContain("mcp");
	});

	it("updates the zone as servers connect and fail, ending on a failure count", () => {
		const emit = (event: McpConnectionStatusEvent) => eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, event);

		emit({ type: "connecting", serverNames: ["alpha", "broken", "slow"] });
		expect(locationText(mode)).toContain("mcp 0/3");
		emit({ type: "connected", serverName: "alpha" });
		expect(locationText(mode)).toContain("mcp 1/3");
		emit({ type: "failed", serverName: "broken", error: "missing command" });
		emit({ type: "connected", serverName: "slow" });

		// Settled with one failure: a loud-enough count plus the detail pointer.
		// The raw error text never reaches the zone — it lives in `/mcp list`.
		const text = locationText(mode);
		expect(text).toContain("mcp ✗1 · /mcp list");
		expect(text).not.toContain("missing command");
	});

	it("rejects a malformed mcp:connection-status payload via the guard instead of letting it throw", () => {
		const showStatusSpy = vi.spyOn(mode, "showStatus").mockImplementation(() => {});
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, { wrong: "shape" });

		expect(showStatusSpy).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
	});
});
