import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import {
	COMPOSER_PLACEHOLDER,
	COMPOSER_RESTING_ROWS,
	ComposerHairline,
	StaticComposerFrame,
} from "@veyyon/coding-agent/modes/components/composer-chrome";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import type { Component } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { visibleWidth } from "@veyyon/utils/width";

/**
 * WHY: startup used to paint eight BLANK rows where the composer would live,
 * so the prompt appeared only when InteractiveMode.init finished — reading as
 * the composer "sliding up" seconds after launch. The first frame now paints
 * a static resting composer into those rows, and the real zone mounts into
 * the same height, so the handover changes text and never position.
 *
 * What these tests close: the static frame must render exactly
 * COMPOSER_RESTING_ROWS, must carry the real hairline bytes from the same
 * owner the mounted zone uses, must show the shared ghost placeholder, and
 * must be time-invariant — nothing on it may animate.
 *
 * The last suite closes the drift: it constructs a real InteractiveMode,
 * runs the real init, and sums what the MOUNTED zone renders at rest, so the
 * static frame is compared against the live components rather than against a
 * second copy of the same number. A footline that gains a row, a status line
 * that stops collapsing, an extra pad row inside mountComposerZone or a
 * changed bottom margin all move that sum and fail here.
 *
 * WHAT IT DOES NOT CATCH, stated plainly: it measures the resting state of a
 * fresh session on the home screen at three widths. A zone height that only
 * diverges under state the resting session never reaches — a live status
 * message, a multi-line draft, a mounted hook widget — is outside it, and so
 * is a divergence that appears only at a width not in the list.
 */

beforeAll(async () => {
	await initTheme(false);
});

describe("static first-frame composer", () => {
	it("renders exactly the resting zone's row count", () => {
		const frame = new StaticComposerFrame();
		expect(frame.render(100)).toHaveLength(COMPOSER_RESTING_ROWS);
	});

	it("shows the hairline with its real bytes", () => {
		const frame = new StaticComposerFrame();
		const rows = frame.render(100);
		const hairline = new ComposerHairline().render(100)[0];
		expect(rows).toContain(hairline);
	});

	it("shows the shared ghost placeholder inset by the composer margin", () => {
		const frame = new StaticComposerFrame();
		const inputRow = frame.render(100).find(row => row.includes(COMPOSER_PLACEHOLDER));
		expect(inputRow).toBeDefined();
		expect(visibleWidth(inputRow as string)).toBeLessThanOrEqual(100);
	});

	it("never animates: identical bytes at different wall-clock times", async () => {
		const frame = new StaticComposerFrame();
		const first = frame.render(100);
		await Bun.sleep(30);
		setSystemTime(new Date(Date.now() + 5_000));
		try {
			expect(frame.render(100)).toEqual(first);
		} finally {
			setSystemTime();
		}
	});

	it("clips to narrow widths without throwing or wrapping", () => {
		const frame = new StaticComposerFrame();
		for (const width of [1, 10, 40]) {
			const rows = frame.render(width);
			expect(rows).toHaveLength(COMPOSER_RESTING_ROWS);
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
	});
});

describe("the mounted composer zone occupies the static frame's rows", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeEach(async () => {
		// Keep ProcessTerminal.start() from probing the real terminal during init().
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-first-frame-resting-height-");
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
		mode = new InteractiveMode(session, "test");
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
		await mode.init();
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/**
	 * The zone is the tail of the root children starting at the first part
	 * mountComposerZone adds. Deriving the slice this way rather than from a
	 * child count means a row added inside mountComposerZone, or anything
	 * mounted after the zone, lands in the measurement instead of escaping it.
	 */
	function mountedZone(): Component[] {
		const children = mode.ui.children;
		const start = children.indexOf(mode.statusContainer);
		expect(start, "statusContainer must be mounted as a root child").toBeGreaterThanOrEqual(0);
		return children.slice(start);
	}

	function restingRows(width: number): number {
		return mountedZone().reduce((rows, child) => rows + child.render(width).length, 0);
	}

	it("renders the same number of rows the first frame reserved", () => {
		expect(restingRows(100)).toBe(COMPOSER_RESTING_ROWS);
	});

	it("renders the same number of rows the static frame paints", () => {
		const width = 100;
		expect(restingRows(width)).toBe(new StaticComposerFrame().render(width).length);
	});

	it("holds that height across the widths the static frame clips to", () => {
		const frame = new StaticComposerFrame();
		for (const width of [40, 100, 200]) {
			expect(restingRows(width), `width ${width}`).toBe(frame.render(width).length);
		}
	});
});
