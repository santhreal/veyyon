/**
 * WHY: `InteractiveMode` builds a screen in its constructor and a harness
 * replaces it (`mode.ui = new TUI(terminal)`) before `init`. The home anchor
 * (`HomeAnchorLayout`), the welcome controller and the per-frame sizing hook
 * were bound to the constructor's screen, so the fills that pin the composer
 * were sized against a screen that never painted — a 40-row default under a
 * non-tty stdout — and rendered stale on the 24-row one that did. The defect
 * only showed once a stray frame ran on the discarded screen, which is why the
 * todo HUD suites passed alone and failed after enough predecessors.
 *
 * Class closed: every mode-owned surface that takes the screen as a port reads
 * the mode's current screen, and the compose hook is installed on the screen
 * the fills mount on. Both assertions here fail against a constructor-bound
 * port: the hero lands on the discarded screen, and the composer stays where
 * the content ends instead of the viewport bottom.
 *
 * Not caught: a surface bound to the constructor screen that neither mounts a
 * child nor moves the composer (a selection notice, an inline image budget).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { initTheme, stopThemeWatcher } from "@veyyon/coding-agent/theme/theme";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TUI } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { VirtualTerminal } from "../../../../../../hosts/terminal/engine/test/virtual-terminal";

const ROWS = 24;

describe("a screen assigned before init is the screen the anchor sizes", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let mode: InteractiveMode | undefined;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-assigned-screen-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
		stopThemeWatcher();
	});

	async function mount(quiet: boolean): Promise<VirtualTerminal> {
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": quiet }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "1.2.3");
		const terminal = new VirtualTerminal(100, ROWS);
		mode.ui = new TUI(terminal);
		vi.spyOn(mode.statusLine, "watchGitState").mockImplementation(() => {});
		await mode.init();
		await terminal.waitForRender();
		return terminal;
	}

	/** Row of the composer footline (the model chip), the zone's last painted
	 * row. Searched from the bottom: the hero states the model too. */
	function footlineRow(terminal: VirtualTerminal): number {
		const rows = terminal.getViewport();
		for (let i = rows.length - 1; i >= 0; i--) if (Bun.stripANSI(rows[i] ?? "").includes("Sonnet 4.5")) return i;
		return -1;
	}

	/** The footline sits above the zone's quiet row and its one-row margin. */
	const PINNED_FOOTLINE_ROW = ROWS - 3;

	it("pins the composer zone to the bottom of the assigned screen on a quiet start", async () => {
		const terminal = await mount(true);
		expect(footlineRow(terminal)).toBe(PINNED_FOOTLINE_ROW);
		// Quiet is the SESSION's setting; the process singleton is not quiet here.
		const screen = terminal.getViewport().map(row => Bun.stripANSI(row));
		expect(screen.some(row => row.includes("v1.2.3"))).toBe(false);
	});

	it("mounts the welcome hero on the assigned screen with the composer still pinned", async () => {
		const terminal = await mount(false);
		const screen = terminal.getViewport().map(row => Bun.stripANSI(row));
		const heroRow = screen.findIndex(row => row.includes("v1.2.3"));
		expect(heroRow).toBeGreaterThan(0);
		expect(footlineRow(terminal)).toBe(PINNED_FOOTLINE_ROW);
	});

	it("re-sizes the anchor on every frame of the assigned screen once a conversation starts", async () => {
		const terminal = await mount(true);
		const controller = mode?.eventController;
		if (!controller) throw new Error("mode not mounted");
		await controller.handleEvent({ type: "agent_start" } as never);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "b1",
			toolName: "bash",
			args: { command: "echo marker" },
		} as never);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "b1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "marker" }] },
			isError: false,
		} as never);
		await controller.handleEvent({ type: "agent_end" } as never);
		await terminal.waitForRender();

		// A conversation routes the slack ABOVE the transcript: the card hugs the
		// composer at the bottom instead of sitting at the top over a band of blank
		// rows. Sized at the frame the card lands in, not at mount, so a hook left
		// on the discarded screen leaves the seed's bottom fill under the card.
		const screen = terminal.getViewport().map(row => Bun.stripANSI(row));
		const cardRow = screen.findIndex(row => row.includes("echo marker"));
		expect(cardRow).toBeGreaterThan(0);
		expect(footlineRow(terminal)).toBe(PINNED_FOOTLINE_ROW);
		const hairlineRow = screen.findIndex(row => row.trimStart().startsWith("─"));
		expect(hairlineRow).toBeGreaterThan(cardRow);
		const blankBand = screen.slice(cardRow + 1, hairlineRow).filter(row => row.trim() === "").length;
		expect(blankBand).toBeLessThanOrEqual(2);
	});
});
