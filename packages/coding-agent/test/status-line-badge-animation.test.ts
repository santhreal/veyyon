/**
 * Footline badge slot animation — agents/jobs badges ease open and closed
 * over 240ms instead of snapping the right group sideways. The operator's
 * design order (2026-07-23): badge arrivals should read as a smooth,
 * intentional merge, not a layout accident. These tests pin the contract:
 * the group never changes width instantaneously, the slot fully closes when
 * the badges vanish (no permanent dead space), and the settled state shows
 * the full badge.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/components/status-line/component";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

describe("footline badge slot animation", () => {
	let authStorage: AuthStorage;
	let session: AgentSession;
	let tempDir: TempDir;
	let statusLine: StatusLineComponent;
	const T0 = new Date("2026-07-23T10:00:00Z");

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		setSystemTime(T0);
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-badge-anim-");
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
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setSystemTime();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	function line(): string {
		const rendered = statusLine.renderQuietLine(120);
		return rendered === null ? "" : stripVTControlCharacters(rendered).trimEnd();
	}

	/** Non-space cell count: the footline is middle-padded to full width, so
	 * total line width is constant; the ink is what the badge slot changes. */
	function ink(s: string): number {
		return Bun.stringWidth(s.replace(/ /g, ""));
	}

	it("eases the badge open: the group never jumps to full width in one frame", () => {
		const before = line();
		expect(before).not.toContain("agent");
		const beforeInk = ink(before);

		statusLine.setSubagentCount(2);
		// First frame after the change: the slot has just started opening, so
		// no badge ink has appeared yet — never the full badge at once.
		const opening = line();
		expect(opening).not.toContain("agents");
		expect(ink(opening)).toBe(beforeInk);

		// Mid-animation: the slot is part-open, showing a clipped badge prefix
		// (the icon and maybe a character) but never the full word.
		setSystemTime(new Date(T0.getTime() + 120));
		const midway = line();
		expect(ink(midway)).toBeGreaterThan(beforeInk);
		expect(midway).not.toContain("agents");

		// Settled: the full badge renders.
		setSystemTime(new Date(T0.getTime() + 300));
		const settled = line();
		expect(settled).toContain("2 agents");
	});

	it("eases closed and leaves no permanent dead space behind", () => {
		statusLine.setSubagentCount(1);
		line(); // first render after the change: animation starts here
		setSystemTime(new Date(T0.getTime() + 300));
		const withBadge = line();
		expect(withBadge).toContain("1 agent");
		const settledInk = ink(withBadge);

		// The close starts at the full slot: the badge is still fully visible
		// on the first frame, then clips away as the slot eases shut.
		statusLine.setSubagentCount(0);
		const closing = line();
		expect(closing).toContain("1 agent");

		setSystemTime(new Date(T0.getTime() + 420));
		expect(line()).not.toContain("1 agent");

		setSystemTime(new Date(T0.getTime() + 600));
		const closed = line();
		expect(closed).not.toContain("agent");
		// The slot is fully gone: no dead space left behind.
		expect(ink(closed)).toBeLessThan(settledInk);
		expect(ink(closed)).toBe(ink(line()));
	});

	it("keeps the settled geometry stable across repeated renders", () => {
		// After the animation completes, repeated renders produce byte-identical
		// lines — the animation must not become its own churn source.
		statusLine.setSubagentCount(3);
		line(); // animation starts
		setSystemTime(new Date(T0.getTime() + 300));
		const first = line();
		const second = line();
		expect(first).toBe(second);
		expect(first).toContain("3 agents");
	});
});
