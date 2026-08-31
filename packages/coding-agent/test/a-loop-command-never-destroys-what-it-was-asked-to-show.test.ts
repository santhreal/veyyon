/**
 * WHY: the autoresearch and autoswarm commands each carried an action that did
 * the opposite of what the words in front of the user said.
 *
 * Three defects, one class — a keystroke whose effect is not the one it reads
 * as:
 *   1. A bare `/autoresearch` on a live loop DISABLED the loop. The command you
 *      reach for to look at a run turned it off.
 *   2. `clear` scanned its arguments as a substring, so `--keeptree`,
 *      `--keep_tree` and `-keep-tree` all matched nothing, fell through to the
 *      destructive default, and reset the worktree the user was asking to keep.
 *   3. The reset itself — `git reset --hard` plus `git clean` — ran with no
 *      confirmation, from four letters typed after a slash.
 *
 * The class is: an argument the parser does not recognize, or a bare command,
 * must never resolve to the destructive branch. Each case here drives the real
 * command handler registered by the real extension against a real git worktree
 * and a real store.
 *
 * What it does not catch: whether the run screen itself renders correctly (the
 * screen-geometry suite owns that), and the storage-level effects of a clear
 * that IS confirmed, which the state suite owns.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { createAutoresearchExtension } from "@veyyon/coding-agent/autoresearch";
import { closeAllAutoresearchStorages, openAutoresearchStorage } from "@veyyon/coding-agent/autoresearch/storage";
import type { ExtensionAPI, ExtensionContext } from "@veyyon/coding-agent/extensibility/extensions";
import * as git from "@veyyon/coding-agent/utils/git";
import type { AutocompleteItem } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { $ } from "bun";
import { useTruecolorTheme } from "./helpers/theme-assertions";

interface CommandSpec {
	description: string;
	getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
	handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

interface ShortcutSpec {
	description: string;
	handler: (ctx: ExtensionContext) => Promise<void> | void;
}

interface Harness {
	commands: Map<string, CommandSpec>;
	shortcuts: Map<string, ShortcutSpec>;
	notices: Array<{ text: string; level: string }>;
	messages: string[];
	activeTools: string[];
}

/** What the surface did while a command ran, as the command's own effects. */
interface Surface {
	/** Frames the full-screen component painted, one array per render. */
	screens: string[][];
	/** Status-row texts pushed through `ui.setStatus`. */
	statuses: Array<string | undefined>;
	/** Confirmations asked, and the answer this surface gives. */
	confirms: Array<{ title: string; message: string }>;
	answer: boolean;
}

function newSurface(answer = true): Surface {
	return { screens: [], statuses: [], confirms: [], answer };
}

function buildHarness(): Harness {
	const commands = new Map<string, CommandSpec>();
	const shortcuts = new Map<string, ShortcutSpec>();
	const notices: Array<{ text: string; level: string }> = [];
	const messages: string[] = [];
	const activeTools: string[] = [];
	const api = {
		appendEntry(): void {},
		exec: async () => ({ code: 0, stderr: "", stdout: "" }),
		on(): void {},
		registerCommand(name: string, spec: CommandSpec): void {
			commands.set(name, spec);
		},
		registerShortcut(key: string, spec: ShortcutSpec): void {
			shortcuts.set(key, spec);
		},
		registerTool(): void {},
		getActiveTools: (): string[] => [...activeTools],
		setActiveTools: async (names: string[]): Promise<void> => {
			activeTools.splice(0, activeTools.length, ...names);
		},
		sendUserMessage(text: string): void {
			messages.push(text);
		},
		sendMessage(): void {},
	} as unknown as ExtensionAPI;
	createAutoresearchExtension(api);
	return { commands, shortcuts, notices, messages, activeTools };
}

/**
 * A context with a UI, so `hasUI` gating does not hide the surface under test.
 * `ui.custom` builds the component through the factory and renders it once, then
 * closes it the way Escape does — a screen that never resolves would hang the
 * command, which is itself a defect this shape can observe.
 */
function makeCtx(cwd: string, harness: Harness, surface: Surface): ExtensionContext {
	return {
		cwd,
		hasUI: true,
		hasPendingMessages: () => false,
		ui: {
			notify: (text: string, level: string) => {
				harness.notices.push({ text, level });
			},
			setStatus: (_key: string, text: string | undefined) => {
				surface.statuses.push(text);
			},
			confirm: async (title: string, message: string): Promise<boolean> => {
				surface.confirms.push({ title, message });
				return surface.answer;
			},
			custom: async <T>(
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (result: T) => void,
				) => { render: (width: number) => readonly string[]; handleInput: (data: string) => void },
			): Promise<T> => {
				const settled: Array<{ value: T }> = [];
				const component = factory({ requestRender: (): void => {} }, {}, {}, (result: T) => {
					if (settled.length === 0) settled.push({ value: result });
				});
				surface.screens.push([...component.render(100)]);
				component.handleInput("\x1b");
				const outcome = settled[0];
				if (!outcome) throw new Error("the run screen never closed on escape");
				return outcome.value;
			},
		},
		sessionManager: {
			getSessionId: () => "session-loop-command-test",
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;
}

/**
 * An open session with a real baseline commit, which is what makes `clear`
 * reach the reset at all: without one the command reports "no baseline commit
 * recorded" and the destructive branch under test is never entered.
 */
async function openSessionAtHead(cwd: string): Promise<void> {
	const storage = await openAutoresearchStorage(cwd);
	const head = (await $`git rev-parse HEAD`.cwd(cwd).quiet()).stdout.toString().trim();
	storage.openSession({
		name: "loop-command-test",
		goal: "make it faster",
		primaryMetric: "duration",
		metricUnit: "ms",
		direction: "lower",
		preferredCommand: null,
		branch: "autoresearch/test",
		baselineCommit: head,
		maxIterations: null,
		scopePaths: [],
		offLimits: [],
		constraints: [],
		secondaryMetrics: [],
	});
}

describe("a loop command never destroys what it was asked to show", () => {
	// The screen paints through the process-wide theme, so a suite that renders
	// it has to install one and put the previous instance back.
	useTruecolorTheme("dark");

	let dbDir: TempDir;
	let cwdDir: TempDir;

	beforeEach(async () => {
		dbDir = TempDir.createSync("@pi-loop-cmd-db-");
		process.env.VEYYON_AUTORESEARCH_DB_DIR = dbDir.path();
		cwdDir = TempDir.createSync("@pi-loop-cmd-cwd-");
		await Bun.write(path.join(cwdDir.path(), "README.md"), "# baseline\n");
		await $`git init --initial-branch=main && git config user.email tester@example.com && git config user.name Tester && git add -A && git commit -m baseline && git checkout -b autoresearch/test`
			.cwd(cwdDir.path())
			.quiet();
		vi.spyOn(git.branch, "current").mockResolvedValue("autoresearch/test");
		vi.spyOn(git.repo, "root").mockResolvedValue(cwdDir.path());
	});

	afterEach(() => {
		delete process.env.VEYYON_AUTORESEARCH_DB_DIR;
		closeAllAutoresearchStorages();
		cwdDir.removeSync();
		dbDir.removeSync();
		vi.restoreAllMocks();
	});

	it("shows the run screen for a bare command on a live loop, and leaves the mode on", async () => {
		const harness = buildHarness();
		const surface = newSurface();
		const ctx = makeCtx(cwdDir.path(), harness, surface);
		await harness.commands.get("autoresearch")?.handler("make it faster", ctx);
		const noticesBefore = harness.notices.length;

		await harness.commands.get("autoresearch")?.handler("", ctx);

		expect(surface.screens.length).toBe(1);
		// "mode disabled" is the effect this defect had. Its absence is the fix,
		// and the tools staying attached is the same fact from the other side.
		expect(harness.notices.slice(noticesBefore).map(notice => notice.text)).not.toContain(
			"Autoresearch mode disabled",
		);
		expect(harness.activeTools).toContain("run_experiment");
	});

	it("still leaves the mode on the word that means leave", async () => {
		const harness = buildHarness();
		const surface = newSurface();
		const ctx = makeCtx(cwdDir.path(), harness, surface);
		await harness.commands.get("autoresearch")?.handler("make it faster", ctx);

		await harness.commands.get("autoresearch")?.handler("off", ctx);

		expect(harness.notices.at(-1)?.text).toBe("Autoresearch mode disabled");
		expect(harness.activeTools).toEqual([]);
	});

	it("opens the run screen from the chord before any run exists", async () => {
		const harness = buildHarness();
		const surface = newSurface();
		const shortcut = harness.shortcuts.get("ctrl+x");
		expect(shortcut).toBeDefined();

		await shortcut?.handler(makeCtx(cwdDir.path(), harness, surface));

		// It used to refuse with "No autoresearch results yet", which is exactly
		// when a reader wants to see the goal and the harness that were configured.
		expect(surface.screens.length).toBe(1);
		expect(harness.notices.map(notice => notice.text)).not.toContain("No autoresearch results yet");
	});

	it("refuses a misspelled clear flag instead of resetting the worktree", async () => {
		const harness = buildHarness();
		const surface = newSurface();
		const ctx = makeCtx(cwdDir.path(), harness, surface);
		await openSessionAtHead(cwdDir.path());
		const dirty = path.join(cwdDir.path(), "work-in-progress.txt");
		await Bun.write(dirty, "unsaved\n");

		for (const typo of ["clear --keeptree", "clear --keep_tree", "clear -keep-tree", "clear --keep-tree extra"]) {
			await harness.commands.get("autoresearch")?.handler(typo, ctx);
			const last = harness.notices.at(-1);
			expect(last?.level).toBe("error");
			expect(last?.text).toContain("nothing was reset");
		}

		// The file the flag was trying to protect is still there, and no reset was
		// even proposed: an unparsed flag must not reach the destructive branch.
		expect(await Bun.file(dirty).exists()).toBe(true);
		expect(surface.confirms).toEqual([]);
	});

	it("asks before resetting the worktree, and keeps the files when refused", async () => {
		const harness = buildHarness();
		const surface = newSurface(false);
		const ctx = makeCtx(cwdDir.path(), harness, surface);
		await harness.commands.get("autoresearch")?.handler("make it faster", ctx);
		await openSessionAtHead(cwdDir.path());
		const dirty = path.join(cwdDir.path(), "work-in-progress.txt");
		await Bun.write(dirty, "unsaved\n");

		await harness.commands.get("autoresearch")?.handler("clear", ctx);

		expect(surface.confirms.length).toBe(1);
		expect(surface.confirms[0]?.message).toContain("--keep-tree");
		expect(await Bun.file(dirty).exists()).toBe(true);
		expect(harness.notices.at(-1)?.text).toContain("nothing was reset");
	});

	it("keeps the files on --keep-tree without asking", async () => {
		const harness = buildHarness();
		const surface = newSurface();
		const ctx = makeCtx(cwdDir.path(), harness, surface);
		await harness.commands.get("autoresearch")?.handler("make it faster", ctx);
		await openSessionAtHead(cwdDir.path());
		const dirty = path.join(cwdDir.path(), "work-in-progress.txt");
		await Bun.write(dirty, "unsaved\n");

		await harness.commands.get("autoresearch")?.handler("clear --keep-tree", ctx);

		// Nothing destructive happens, so there is nothing to confirm.
		expect(surface.confirms).toEqual([]);
		expect(await Bun.file(dirty).exists()).toBe(true);
		expect(harness.notices.at(-1)?.text).toBe("Autoresearch session cleared.");
		expect(harness.activeTools).toEqual([]);
	});
});
