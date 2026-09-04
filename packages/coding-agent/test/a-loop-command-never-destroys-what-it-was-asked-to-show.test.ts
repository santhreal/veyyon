/**
 * WHY: the autoresearch and autoswarm commands each carried an action that did
 * the opposite of what the words on screen stated.
 *
 * Three defects, one class — a keystroke whose effect is not the one it reads
 * as:
 *   1. A bare `/autoresearch` on a live loop DISABLED the loop. The command you
 *      reach for to look at a run turned it off.
 *   2. `clear` scanned its arguments as a substring, so `--keeptree`,
 *      `--keep_tree` and `-keep-tree` all matched nothing, fell through to the
 *      destructive default, and reset the worktree the flag names as kept.
 *   3. The reset itself — `git reset --hard` plus `git clean` — ran with no
 *      confirmation, from four letters typed after a slash.
 *   4. The reset resolved its session as the newest open row rather than the one
 *      on this branch, so a second worktree elsewhere decided which commit this
 *      one was reset to.
 *
 * The class is: an argument the parser does not recognize, or a bare command,
 * must never resolve to the destructive branch, and the destructive branch acts
 * on the session of the branch it stands on. Each case here drives the real
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
import { theme } from "@veyyon/coding-agent/modes/theme/theme";
import * as git from "@veyyon/coding-agent/utils/git";
import type { AutocompleteItem } from "@veyyon/tui";
import { stripAnsi, TempDir } from "@veyyon/utils";
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
	/** Widgets pushed above the composer, which this loop must never do. */
	widgets: number;
	/** Confirmations asked, and the answer this surface gives. */
	confirms: Array<{ title: string; message: string }>;
	answer: boolean;
	/**
	 * Keys to drive the component with. Empty means the Escape that closes a
	 * screen; a console under test needs the keys that reach `start`.
	 */
	keys: string[];
}

function newSurface(answer = true): Surface {
	return { screens: [], statuses: [], widgets: 0, confirms: [], answer, keys: [] };
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
		// The resume prompt is delivered hidden (`display: false`) since the
		// command line above it already says what was asked; the context typed
		// after the command travels inside it, so it is recorded the same way.
		sendMessage(message: { content: string }): void {
			messages.push(message.content);
		},
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
			setWidget: (): void => {
				surface.widgets += 1;
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
				// The real theme the suite installed: the setup console paints through
				// `theme.fg`, so a bare object closes the console on a TypeError. The
				// run screen sizes itself from the terminal minus the pinned composer.
				const tui = { requestRender: (): void => {}, terminal: { rows: 40, columns: 100 }, pinnedFooterRows: 5 };
				const component = factory(tui, theme, {}, (result: T) => {
					if (settled.length === 0) settled.push({ value: result });
				});
				surface.screens.push([...component.render(100)]);
				for (const key of surface.keys.length > 0 ? surface.keys : ["\x1b"]) {
					if (settled.length > 0) break;
					component.handleInput(key);
				}
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
 *
 * Returns the commit the session was opened at, which is the commit a confirmed
 * clear resets this worktree to.
 */
async function openSessionAtHead(cwd: string, branch = "autoresearch/test"): Promise<string> {
	const storage = await openAutoresearchStorage(cwd);
	const head = (await $`git rev-parse HEAD`.cwd(cwd).quiet()).stdout.toString().trim();
	storage.openSession({
		name: `loop-command-test ${branch}`,
		goal: "make it faster",
		primaryMetric: "duration",
		metricUnit: "ms",
		direction: "lower",
		preferredCommand: null,
		branch,
		baselineCommit: head,
		maxIterations: null,
		scopePaths: [],
		offLimits: [],
		constraints: [],
		secondaryMetrics: [],
	});
	return head;
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

		// It used to reject the command with "No autoresearch results yet", which is
		// when the configured goal and harness are most worth reading.
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

	it("keeps the files on --keep-tree without asking, the harness among them", async () => {
		const harness = buildHarness();
		const surface = newSurface();
		const ctx = makeCtx(cwdDir.path(), harness, surface);
		await harness.commands.get("autoresearch")?.handler("make it faster", ctx);
		await openSessionAtHead(cwdDir.path());
		const dirty = path.join(cwdDir.path(), "work-in-progress.txt");
		await Bun.write(dirty, "unsaved\n");
		// `autoresearch.sh` is the live harness, not a legacy artifact, and "leave
		// every file alone" includes it: it was removed from the worktree on every
		// clear, whichever flag was passed.
		const harnessFile = path.join(cwdDir.path(), "autoresearch.sh");
		await Bun.write(harnessFile, "#!/usr/bin/env bash\necho METRIC ms=1\n");

		await harness.commands.get("autoresearch")?.handler("clear --keep-tree", ctx);

		// Nothing destructive happens, so there is nothing to confirm.
		expect(surface.confirms).toEqual([]);
		expect(await Bun.file(dirty).exists()).toBe(true);
		expect(await Bun.file(harnessFile).exists()).toBe(true);
		expect(harness.notices.at(-1)?.text).toBe("Autoresearch session cleared.");
		expect(harness.activeTools).toEqual([]);
	});

	it("leaves the committed harness in place after a confirmed reset", async () => {
		const harness = buildHarness();
		const surface = newSurface(true);
		const ctx = makeCtx(cwdDir.path(), harness, surface);
		await harness.commands.get("autoresearch")?.handler("make it faster", ctx);
		const harnessFile = path.join(cwdDir.path(), "autoresearch.sh");
		await Bun.write(harnessFile, "#!/usr/bin/env bash\necho METRIC ms=1\n");
		await $`git add autoresearch.sh && git commit -m harness`.cwd(cwdDir.path()).quiet();
		await openSessionAtHead(cwdDir.path());
		await Bun.write(path.join(cwdDir.path(), "autoresearch.md"), "legacy notes\n");

		await harness.commands.get("autoresearch")?.handler("clear", ctx);

		expect(surface.confirms.length).toBe(1);
		// The reset put the baseline back, harness included; the legacy file the
		// prompt forbids is what a reset clears away.
		expect(await Bun.file(harnessFile).exists()).toBe(true);
		expect(await Bun.file(path.join(cwdDir.path(), "autoresearch.md")).exists()).toBe(false);
		expect((await $`git status --porcelain`.cwd(cwdDir.path()).quiet()).stdout.toString().trim()).toBe("");
	});

	it("resets to the baseline of the branch it is standing on, not the newest session", async () => {
		// `clear` resolved the session as "newest still-open row", so a second
		// worktree on another branch made this one reset to a commit it had never
		// been at, and closed that other branch's session instead of its own. Every
		// other caller resolves by branch; this one now does too.
		const harness = buildHarness();
		const surface = newSurface();
		const ctx = makeCtx(cwdDir.path(), harness, surface);
		await harness.commands.get("autoresearch")?.handler("make it faster", ctx);
		const ours = await openSessionAtHead(cwdDir.path(), "autoresearch/test");
		await Bun.write(path.join(cwdDir.path(), "later.txt"), "committed after the baseline\n");
		await $`git add later.txt && git commit -m later`.cwd(cwdDir.path()).quiet();
		const theirs = await openSessionAtHead(cwdDir.path(), "autoresearch/other");
		expect(theirs).not.toBe(ours);

		await harness.commands.get("autoresearch")?.handler("clear", ctx);

		expect(surface.confirms[0]?.message).toContain(ours.slice(0, 12));
		expect(surface.confirms[0]?.message).not.toContain(theirs.slice(0, 12));
		const head = (await $`git rev-parse HEAD`.cwd(cwdDir.path()).quiet()).stdout.toString().trim();
		expect(head).toBe(ours);
		// The other branch's session is untouched, and ours is the one that closed.
		const storage = await openAutoresearchStorage(cwdDir.path());
		expect(storage.getActiveSessionForBranch("autoresearch/other")?.baselineCommit).toBe(theirs);
		expect(storage.getActiveSessionForBranch("autoresearch/test")).toBeNull();
	});

	it("occupies one status row and no widget above the composer", async () => {
		// The row replaced an eighteen-row table charged to the conversation on
		// every frame. One line, and the chord that opens the rest.
		const harness = buildHarness();
		const surface = newSurface();
		const ctx = makeCtx(cwdDir.path(), harness, surface);

		await harness.commands.get("autoresearch")?.handler("make it faster", ctx);

		const row = surface.statuses.at(-1);
		expect(row).toBeDefined();
		expect(row).not.toContain("\n");
		expect(stripAnsi(row ?? "")).toContain("autoresearch");
		expect(stripAnsi(row ?? "")).toContain("ctrl+x runs");
		expect(surface.widgets).toBe(0);
	});

	it("clears the status row when the mode is left", async () => {
		// A row that outlives its loop is a row nobody can act on: the chord it
		// advertises opens a screen for a session that is over.
		const harness = buildHarness();
		const surface = newSurface();
		const ctx = makeCtx(cwdDir.path(), harness, surface);
		await harness.commands.get("autoresearch")?.handler("make it faster", ctx);

		await harness.commands.get("autoresearch")?.handler("off", ctx);

		expect(surface.statuses.at(-1)).toBeUndefined();
	});

	it("lists its subcommands before a letter is typed", async () => {
		// An empty prefix used to return nothing, so the two words that reach
		// every remaining behaviour were discoverable only from the handbook.
		const harness = buildHarness();
		for (const name of ["autoresearch", "autoswarm"]) {
			const completions = harness.commands.get(name)?.getArgumentCompletions?.("") ?? [];
			expect(completions.map(item => item.value)).toEqual(["status", "resume", "goal ", "off", "clear"]);
		}
		const flags = harness.commands.get("autoresearch")?.getArgumentCompletions?.("clear ") ?? [];
		expect(flags.map(item => item.value)).toEqual(["clear --keep-tree", "clear --reset-tree"]);
	});

	it("answers status with the screen and leaves the stored goal alone", async () => {
		// The reported defect: `status` is not a subcommand, so it was swallowed as
		// the goal and a 20-run session had its goal replaced with the word
		// "status", which was then handed to the model as the thing to optimize.
		const harness = buildHarness();
		const surface = newSurface();
		const ctx = makeCtx(cwdDir.path(), harness, surface);
		await openSessionAtHead(cwdDir.path());

		await harness.commands.get("autoresearch")?.handler("status", ctx);

		const storage = await openAutoresearchStorage(cwdDir.path());
		expect(storage.getActiveSessionForBranch("autoresearch/test")?.goal).toBe("make it faster");
		expect(surface.screens.length).toBe(1);
		// Nothing was handed to the model: `status` is a question to the screen.
		expect(harness.messages).toEqual([]);
	});

	it("leaves the stored goal alone on any free text, and says which word changes it", async () => {
		// The class, not the one word: every unrecognized argument reached the
		// same destructive write. `status` was merely the one a user types first.
		// On autoswarm the write hid one layer down: the text prefilled the
		// console's goal field, and the Enter that starts the run stored it.
		await openSessionAtHead(cwdDir.path());
		for (const name of ["autoresearch", "autoswarm"]) {
			const harness = buildHarness();
			const surface = newSurface();
			const ctx = makeCtx(cwdDir.path(), harness, surface);

			for (const word of ["status", "state", "show", "runs", "resume", "--help", "make it slower"]) {
				// `status` opens the run screen, which Escape closes; every other word
				// on autoswarm opens the console, which Enter starts.
				surface.keys = word === "status" ? ["\x1b"] : ["\r"];
				await harness.commands.get(name)?.handler(word, ctx);
				const storage = await openAutoresearchStorage(cwdDir.path());
				expect(storage.getActiveSessionForBranch("autoresearch/test")?.goal).toBe("make it faster");
			}
			// Free text is not silently dropped either: it reaches the model as resume
			// context, and the user is told which word rewrites the goal.
			expect(harness.messages.join("\n")).toContain("make it slower");
			expect(harness.notices.map(notice => notice.text).join("\n")).toContain(`/${name} goal <text>`);
		}
	});

	it("opens the swarm console on the session's own goal, not on the text typed after the command", async () => {
		const harness = buildHarness();
		const surface = newSurface();
		surface.keys = ["\r"];
		const ctx = makeCtx(cwdDir.path(), harness, surface);
		await openSessionAtHead(cwdDir.path());

		await harness.commands.get("autoswarm")?.handler("continue where it left off", ctx);

		const consoleFrame = stripAnsi(surface.screens[0]?.join("\n") ?? "");
		expect(consoleFrame).toContain("Goal          make it faster");
		expect(consoleFrame).not.toContain("continue where it left off");
	});

	it("writes the goal a swarm console left different from the stored one", async () => {
		const harness = buildHarness();
		const surface = newSurface();
		const ctx = makeCtx(cwdDir.path(), harness, surface);
		await openSessionAtHead(cwdDir.path());
		// Backspace over "faster", type "slower", Enter.
		surface.keys = [...Array.from({ length: 6 }, () => "\x7f"), ..."slower", "\r"];

		await harness.commands.get("autoswarm")?.handler("", ctx);

		const storage = await openAutoresearchStorage(cwdDir.path());
		expect(storage.getActiveSessionForBranch("autoresearch/test")?.goal).toBe("make it slower");
	});

	it("rewrites the goal only where it is typed on purpose", async () => {
		const harness = buildHarness();
		const ctx = makeCtx(cwdDir.path(), harness, newSurface());
		await openSessionAtHead(cwdDir.path());

		await harness.commands.get("autoresearch")?.handler("goal cut the p99 latency", ctx);

		const storage = await openAutoresearchStorage(cwdDir.path());
		expect(storage.getActiveSessionForBranch("autoresearch/test")?.goal).toBe("cut the p99 latency");
	});

	it("refuses a bare goal instead of storing an empty one", async () => {
		const harness = buildHarness();
		const ctx = makeCtx(cwdDir.path(), harness, newSurface());
		await openSessionAtHead(cwdDir.path());

		await harness.commands.get("autoresearch")?.handler("goal", ctx);

		const storage = await openAutoresearchStorage(cwdDir.path());
		expect(storage.getActiveSessionForBranch("autoresearch/test")?.goal).toBe("make it faster");
		expect(harness.notices.at(-1)?.level).toBe("error");
	});

	it("raises a serial session to the breadth the swarm console returns", async () => {
		// `/autoswarm` on a live serial session left breadth at 1, so the command
		// that exists to add arms added none.
		const harness = buildHarness();
		const surface = newSurface();
		const ctx = makeCtx(cwdDir.path(), harness, surface);
		await openSessionAtHead(cwdDir.path());
		// The real console, driven by the keys a user presses: down to breadth,
		// right twice to 3, down past the models row to attempts, right to 2, then
		// the Enter that starts it.
		surface.keys = ["\x1b[B", "\x1b[C", "\x1b[C", "\x1b[B", "\x1b[B", "\x1b[C", "\r"];

		await harness.commands.get("autoswarm")?.handler("", ctx);

		const storage = await openAutoresearchStorage(cwdDir.path());
		const session = storage.getActiveSessionForBranch("autoresearch/test");
		expect(session?.breadth).toBe(3);
		expect(session?.attempts).toBe(2);
		expect(session?.goal).toBe("make it faster");
	});
});
