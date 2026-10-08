/**
 * WHY THIS SUITE EXISTS.
 *
 * THE DEFECT IT CLOSES. `interactive-mode.ts` imported `SelectorController` statically and built one in
 * its constructor, so every interactive session evaluated the settings card, the model hub, the account
 * manager, the agents and extensions dashboards, the rollback panel and the session tree before the
 * operator opened any of them: 38 modules and about 4 MiB of resident memory held for the life of an
 * idle session.
 *
 * THE CLASS. A card the selector controller opens is not in the interactive session's static import
 * graph. The cards are enumerated from the controller's own imports at run time, so a new card, or an
 * existing one that another module starts importing eagerly, turns this red until it is recorded in
 * {@link SHARED_WITH_THE_SESSION}. Deferring the load must not change how a card behaves once it is
 * open, so the suite also drives a real `InteractiveMode`: the first open shows the card once the
 * controller loads, every later open is synchronous so the key typed after it reaches the card, and a
 * picker requested before the first frame (covered in
 * `early-first-frame-actions-are-retained-and-executed.test.ts`) is open by the time `init()` returns.
 *
 * WHAT IT DOES NOT CATCH. A failed `import()` of the controller cannot be injected without replacing the
 * module registry, so the retry after a failed load is unexercised. The walk is static: a card reached
 * through `await import(...)` from another eager module is invisible to it, which is the intended cut.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { SubcommandPickerComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/subcommand-picker";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { SubcommandDef } from "@veyyon/coding-agent/slash-commands/types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";
import { buildStartupImportGraph } from "../../../helpers/startup-import-graph";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../../..");
const TERMINAL = path.join(REPO_ROOT, "packages/coding-agent/src/modes/terminal");
const INTERACTIVE_MODE = path.join(TERMINAL, "interactive-mode.ts");
const SELECTOR_CONTROLLER = path.join(TERMINAL, "controllers/selector-controller.ts");
const COMPONENTS = path.join(TERMINAL, "components");

/** Components the controller imports that the session also draws with, so they load with it. */
const SHARED_WITH_THE_SESSION = ["status-line/quiet-row.ts", "transcript/transcript-container.ts"];

/** The file a relative specifier in `from` names, as Bun resolves it. */
function resolveRelative(from: string, specifier: string): string {
	const base = path.resolve(path.dirname(from), specifier);
	const file = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base].find(candidate =>
		existsSync(candidate),
	);
	if (!file) throw new Error(`${path.relative(REPO_ROOT, from)} imports ${specifier}, which names no file`);
	return file;
}

describe("the interactive session's static import graph", () => {
	const graph = buildStartupImportGraph(REPO_ROOT, INTERACTIVE_MODE);
	const cards = moduleSpecifiersIn(readFileSync(SELECTOR_CONTROLLER, "utf8"))
		.filter(specifier => specifier.startsWith("."))
		.map(specifier => resolveRelative(SELECTOR_CONTROLLER, specifier))
		.filter(file => file.startsWith(`${COMPONENTS}${path.sep}`));

	it("is complete enough to judge by", () => {
		expect(graph.unscannable).toEqual([]);
		expect(graph.files.has(INTERACTIVE_MODE)).toBe(true);
		// The session's own editor is in it; a walk that stopped at the root would not reach it.
		expect(graph.files.has(path.join(COMPONENTS, "composer/custom-editor.ts"))).toBe(true);
		// The enumeration found the cards; an empty list would pass the pin below for the wrong reason.
		expect(cards.length).toBeGreaterThan(10);
	});

	it("does not hold the selector controller", () => {
		expect(graph.files.has(SELECTOR_CONTROLLER)).toBe(false);
	});

	it("holds only the components the controller shares with the session", () => {
		const eager = cards.filter(file => graph.files.has(file)).map(file => path.relative(COMPONENTS, file));
		expect(eager.sort()).toEqual(SHARED_WITH_THE_SESSION);
	});
});

describe("a selector card opened from a live session", () => {
	const SUBCOMMANDS: readonly SubcommandDef[] = [
		{ name: "first", description: "The first row" },
		{ name: "second", description: "The second row" },
	];
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

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
		tempDir = TempDir.createSync("@veyyon-selector-card-load-");
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
		vi.spyOn(mode.statusLine, "watchGitState").mockImplementation(() => {});
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

	/** The focused picker once the controller has loaded; fails after a bounded wait rather than hanging. */
	async function focusedPicker(): Promise<SubcommandPickerComponent> {
		for (let attempt = 0; attempt < 200; attempt += 1) {
			const focused = mode.ui.getFocused();
			if (focused instanceof SubcommandPickerComponent) return focused;
			await Bun.sleep(5);
		}
		throw new Error(`the picker never took focus; focused: ${mode.ui.getFocused()?.constructor.name}`);
	}

	it("shows the first card once its controller loads, and the card answers its keys", async () => {
		const chosen: string[] = [];
		mode.showSubcommandPicker("demo", SUBCOMMANDS, subcommand => chosen.push(subcommand.name));

		const picker = await focusedPicker();
		picker.handleInput("\r");

		expect(chosen).toEqual(["first"]);
		expect(mode.ui.getFocused()).toBe(mode.editor);
	});

	it("opens every later card synchronously, so the key typed after the shortcut reaches it", async () => {
		mode.showSubcommandPicker("demo", SUBCOMMANDS, () => {});
		(await focusedPicker()).handleInput("\x1b");
		expect(mode.ui.getFocused()).toBe(mode.editor);

		const chosen: string[] = [];
		mode.showSubcommandPicker("demo", SUBCOMMANDS, subcommand => chosen.push(subcommand.name));
		const focused = mode.ui.getFocused();
		if (!(focused instanceof SubcommandPickerComponent)) {
			throw new Error(`the second open did not focus the picker; focused: ${focused?.constructor.name}`);
		}
		focused.handleInput("\x1b[B");
		focused.handleInput("\r");

		expect(chosen).toEqual(["second"]);
		expect(mode.ui.getFocused()).toBe(mode.editor);
	});
});
