/**
 * WHY: mounting the session forced a full-viewport repaint. Measured on a pty against the built
 * binary, the handover wrote 2.6KB at 613ms: `CSI 25 A` back to the top of the viewport, then every
 * one of 25 rows erased (`CSI K`) and rewritten with the bytes already on them. The card had
 * painted those rows at 52ms and nothing about them had changed, so the operator saw the hero, the
 * branch and the composer blink darker and back for one frame. Synchronized output would only hide
 * it: no `CSI ? 2026 h` was emitted anywhere in the launch, and it is off by default on the VTE
 * family and on any terminal the DECRQM probe has not answered for.
 *
 * THE CLASS: mounting a session never repaints a row it did not change, whatever was on the screen
 * first. The engine writes only rows that differ from the window it last committed, and both launch
 * paths leave it a window to diff against: with a card, the rows the card painted through this same
 * `TUI`; without one, the frame `ui.start()` painted over its own `ED 2`. Neither needs the mount to
 * claim the viewport a second time, and the claim is the flicker.
 *
 * The two halves are asserted where each is observable. The first suite drives the engine and reads
 * the bytes, because "a forced render rewrites rows that did not change" is a claim about what
 * reaches the terminal. The second drives the real mount and reads which render it asked for,
 * because the mode's choice IS the defect: the bytes it produces land inside `init`'s own later
 * awaits, mixed with writes that carry real changes (the transcript zone mounting, a status value
 * resolving), and no byte window separates them. Both take the terminal out of headless mode, which
 * otherwise suppresses every write and makes a repaint indistinguishable from a diff.
 *
 * NOT CAUGHT: what the operator's terminal does with the bytes. Whether a given terminal renders a
 * diffed row without flicker is the terminal's business. Also outside: repaints after the handover
 * (a resize, a theme swap, `/clear`), which are forced deliberately and are meant to rewrite the
 * viewport.
 *
 * Deleting the mount's render outright also stays green here, and that is a real hole rather than
 * a claim it is dead code: a mount reaches this point through other renders that cover for it in
 * this harness, so the suite can prove the render is not FORCED but not that it happens at all. A
 * mount that drew nothing would leave a stale frame until the next event, which is the class
 * `a-git-read-that-lands-late-repaints-the-status-row.test.ts` holds for the row it affects.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { setTimeout } from "node:timers/promises";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { resetLaunchFactsForTest } from "@veyyon/coding-agent/modes/launch-facts";
import { paintFirstFrame, takeFirstFrame } from "@veyyon/coding-agent/modes/terminal/first-frame";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { ProcessTerminal, type RenderRequestOptions, Text, TUI, type TUIStartOptions } from "@veyyon/tui";
import { setTerminalHeadless, TempDir } from "@veyyon/utils";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../utils/test/helpers/isolated-config-root";

let isolated: IsolatedConfigRoot;
let previousHeadless: boolean;
/** Every byte the engine hands the terminal, in order. */
let writes: string[];
/** Everything a test opened, closed in reverse however the test ended. */
const opened: (() => Promise<void> | void)[] = [];

beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	// The real `ProcessTerminal` probes and writes to the developer's own terminal otherwise, and
	// the screens here are painted for real.
	writes = [];
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
		writes.push(String(chunk));
		return true;
	});
	vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
	vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
	vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
	if (typeof process.stdin.setRawMode === "function") {
		vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
	}
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

	previousHeadless = setTerminalHeadless(false);
	isolated = enterIsolatedConfigRoot("handover-repaint", { defaultProfile: true });
	resetLaunchFactsForTest();
	resetSettingsForTest();
});

afterEach(async () => {
	for (const close of opened.reverse()) await close();
	opened.length = 0;
	// A card no mode adopted still holds the process singleton and a started screen.
	takeFirstFrame()?.ui.stop();
	vi.restoreAllMocks();
	resetSettingsForTest();
	resetLaunchFactsForTest();
	setTerminalHeadless(previousHeadless);
	isolated?.restore();
});

/** The bytes a render writes, after the frame has settled. */
async function bytesFrom(render: () => void): Promise<string> {
	writes.length = 0;
	render();
	// Renders are scheduled rather than written inline.
	await setTimeout(40);
	return writes.join("");
}

describe("a repaint of rows that did not change is bytes on the wire", () => {
	it("writes nothing for an ordinary render and rewrites every row for a forced one", async () => {
		const ui = new TUI(new ProcessTerminal(), false);
		opened.push(() => ui.stop());
		for (let row = 0; row < 6; row++) ui.addChild(new Text(`row ${row}`));
		ui.start();
		await setTimeout(40);

		// Nothing about the tree changed between these two calls. The only difference is whether the
		// engine is allowed to compare against the window it already committed.
		expect(await bytesFrom(() => ui.requestRender())).toBe("");
		const forced = await bytesFrom(() => ui.requestRender(true));

		expect(forced.length).toBeGreaterThan(0);
		// One erase per row: the whole viewport cleared and rewritten with what it already said.
		expect((forced.match(/\x1b\[K/g) ?? []).length).toBeGreaterThanOrEqual(6);
	});
});

/** A session on its own storage. */
async function freshSession(): Promise<AgentSession> {
	const tempDir = TempDir.createSync("@pi-handover-repaint-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings: Settings.isolated(),
		modelRegistry,
	});
	opened.push(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});
	return session;
}

/**
 * Mount a session the way `main.ts` does, and report the renders the mount asked the engine for.
 *
 * `ui.start()` is excluded: on the card-less path it is what paints the screen the mount then
 * diffs against, and its `ED 2` is the claim on the viewport. Every OTHER forced render is a
 * repaint of rows the engine could have compared.
 */
async function mount(options: { withCard: boolean }): Promise<{ mode: InteractiveMode; forcedAfterStart: number }> {
	const session = await freshSession();
	const card = options.withCard ? paintFirstFrame("1.1.1") : undefined;
	const mode = new InteractiveMode(session, "test");
	opened.push(() => mode.stop());
	// Both would run a subprocess and an animation timer inside `init`, and neither decides how the
	// viewport is painted; the git read is what
	// `a-git-read-that-lands-late-repaints-the-status-row.test.ts` covers.
	vi.spyOn(mode.statusLine, "watchGitState").mockImplementation(() => {});
	vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
	let forcedAfterStart = 0;
	let started = options.withCard;
	const start = mode.ui.start.bind(mode.ui);
	vi.spyOn(mode.ui, "start").mockImplementation((startOptions?: TUIStartOptions) => {
		// After, not before: `start` claims the viewport with its own forced render, and that claim
		// is the baseline every later render diffs against rather than a repaint over it.
		start(startOptions);
		started = true;
	});
	const render = mode.ui.requestRender.bind(mode.ui);
	vi.spyOn(mode.ui, "requestRender").mockImplementation((force?: boolean, renderOptions?: RenderRequestOptions) => {
		if (force === true && started) forcedAfterStart++;
		render(force, renderOptions);
	});
	await mode.init();
	await setTimeout(60);
	if (card) expect(mode.ui).toBe(card.ui);
	return { mode, forcedAfterStart };
}

describe("the session mounts without repainting what is already on screen", () => {
	// Both launch paths, from the same mount, so a repaint reintroduced for one of them is caught
	// whichever one it is. The card path is the reported defect; the card-less path is where a
	// "restore the forced paint" edit would go looking for cover.
	for (const withCard of [true, false]) {
		it(`asks for no forced repaint ${withCard ? "when the card painted the screen" : "on a launch with no card"}`, async () => {
			expect((await mount({ withCard })).forcedAfterStart).toBe(0);
		});
	}

	it("puts the mounted tree on screen on a launch with no card", async () => {
		// The card-less path has no adopted components to compare against, so what proves the
		// ordinary render is enough is that the session's own rows reached the terminal: the status
		// row the mode mounts is on screen after init, over the frame `ui.start()` painted.
		const { mode } = await mount({ withCard: false });
		const onScreen = writes.join("");

		const row = mode.statusLine.renderQuietLine(mode.ui.terminal.columns);
		expect(mode.ui.children).toContain(mode.statusContainer);
		expect(row).not.toBeNull();
		// A prefix, because the row the engine wrote carries the cursor and padding around it.
		expect(onScreen).toContain((row as string).slice(0, 24));
	});

	it("leaves the mounted screen holding the card's own composer", async () => {
		const session = await freshSession();
		const card = paintFirstFrame("1.1.1");
		const mode = new InteractiveMode(session, "test");
		opened.push(() => mode.stop());
		vi.spyOn(mode.statusLine, "watchGitState").mockImplementation(() => {});
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
		await mode.init();

		// Skipping the repaint is only correct because the mode adopts what the card mounted: a
		// second editor would mean the rows really did change, and a handover that repainted nothing
		// would leave the old composer on screen.
		expect(mode.editor).toBe(card.editor);
		expect(mode.ui).toBe(card.ui);
	});
});
