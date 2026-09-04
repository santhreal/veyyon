/**
 * WHY: autoswarm is autoresearch with breadth. It reuses one engine — the same
 * session, store, tools and prompt — but it is its own command, and the serial
 * command has to stay exactly what it was.
 *
 * The class this closes is the two commands collapsing into one: autoswarm
 * disappearing behind a flag on `/autoresearch`, or `/autoresearch` quietly
 * acquiring breadth and stopping being the serial loop. Both are regressions a
 * type check cannot see, because the handlers share a body.
 *
 * What it does not catch: what the arms then do. That is the certification
 * suite, which drives `certify_arms` against a real database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { createAutoresearchExtension } from "@veyyon/coding-agent/autoresearch";
import { closeAllAutoresearchStorages, openAutoresearchStorage } from "@veyyon/coding-agent/autoresearch/storage";
import { DEFAULT_SWARM_BREADTH } from "@veyyon/coding-agent/autoresearch/swarm";
import type { ExtensionAPI, ExtensionContext } from "@veyyon/coding-agent/extensibility/extensions";
import * as git from "@veyyon/coding-agent/utils/git";
import type { AutocompleteItem } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { $ } from "bun";

interface CommandSpec {
	description: string;
	getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
	handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

interface Harness {
	commands: Map<string, CommandSpec>;
	notices: Array<{ text: string; level: string }>;
	messages: string[];
	/** Prompts sent to the model without a transcript line, as `sendMessage` received them. */
	hidden: Array<{ customType: string; content: string; display: boolean }>;
	activeTools: string[];
}

/** Keys the console is driven with, and the frames it painted while being driven. */
interface ConsoleDrive {
	opened: boolean;
	overlay: boolean;
	frames: string[][];
}

/** Theme whose colour functions are identity, so a frame assertion sees plain text. */
function passthroughTheme(): unknown {
	return { fg: (_name: string, text: string) => text, bold: (text: string) => text };
}

function buildHarness(): Harness {
	const commands = new Map<string, CommandSpec>();
	const notices: Array<{ text: string; level: string }> = [];
	const messages: string[] = [];
	const hidden: Array<{ customType: string; content: string; display: boolean }> = [];
	const activeTools: string[] = [];
	const api = {
		appendEntry(): void {},
		exec: async () => ({ code: 0, stderr: "", stdout: "" }),
		on(): void {},
		registerCommand(name: string, spec: CommandSpec): void {
			commands.set(name, spec);
		},
		registerShortcut(): void {},
		registerTool(): void {},
		getActiveTools: (): string[] => [...activeTools],
		setActiveTools: async (names: string[]): Promise<void> => {
			activeTools.splice(0, activeTools.length, ...names);
		},
		sendUserMessage(text: string): void {
			messages.push(text);
		},
		sendMessage(message: { customType: string; content: string; display: boolean }): void {
			hidden.push({ customType: message.customType, content: message.content, display: message.display });
		},
	} as unknown as ExtensionAPI;
	createAutoresearchExtension(api);
	return { commands, notices, messages, hidden, activeTools };
}

/**
 * Drives `ui.custom` the way the real surface does: build the component through
 * the factory, render it, feed each key, and resolve with whatever `done`
 * received. Feeding real keystrokes is the point — a fake that returns a
 * configuration object would pass while the console was unreachable.
 */
function makeCtx(
	cwd: string,
	notices: Array<{ text: string; level: string }>,
	keys: string[] = [],
	drive: ConsoleDrive = { opened: false, overlay: false, frames: [] },
): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		hasPendingMessages: () => false,
		ui: {
			notify: (text: string, level: string) => {
				notices.push({ text, level });
			},
			custom: async <T>(
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (result: T) => void,
				) => { render: (width: number) => string[]; handleInput: (data: string) => void },
				options?: { overlay?: boolean },
			): Promise<T> => {
				drive.opened = true;
				drive.overlay = options?.overlay === true;
				const settled: Array<{ value: T }> = [];
				const tui = { requestRender: (): void => {} };
				const component = factory(tui, passthroughTheme(), {}, (result: T) => {
					if (settled.length === 0) settled.push({ value: result });
				});
				drive.frames.push(component.render(80));
				for (const key of keys) {
					if (settled.length > 0) break;
					component.handleInput(key);
					drive.frames.push(component.render(80));
				}
				const outcome = settled[0];
				if (!outcome) throw new Error(`console never resolved for keys: ${JSON.stringify(keys)}`);
				return outcome.value;
			},
		},
		sessionManager: {
			getSessionId: () => "session-autoswarm-test",
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;
}

describe("autoswarm is its own command", () => {
	let dbDir: TempDir;
	let cwdDir: TempDir;

	beforeEach(async () => {
		dbDir = TempDir.createSync("@pi-autoswarm-cmd-db-");
		process.env.VEYYON_AUTORESEARCH_DB_DIR = dbDir.path();
		cwdDir = TempDir.createSync("@pi-autoswarm-cmd-cwd-");
		// Both commands put the session on a dedicated branch before they do
		// anything else, so the handler needs a real repository to reach the
		// behaviour under test.
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

	it("registers both commands, and they are not the same command", () => {
		const { commands } = buildHarness();
		expect(commands.has("autoresearch")).toBe(true);
		expect(commands.has("autoswarm")).toBe(true);
		expect(commands.get("autoswarm")?.handler).not.toBe(commands.get("autoresearch")?.handler);
		expect(commands.get("autoswarm")?.description).toContain("breadth");
		expect(commands.get("autoresearch")?.description).not.toContain("breadth");
	});

	it("completes every subcommand on both, and breadth on neither", () => {
		// Each of these still works, so each must still be offered — including
		// before a letter is typed, which is the only point the names are
		// discoverable without knowing them in advance. `status` and `goal` are
		// listed because reaching for an unlisted word used to be swallowed as the
		// goal and overwrite a live session's. Breadth is not a subcommand any
		// more and must not be offered on either command.
		const { commands } = buildHarness();
		for (const name of ["autoswarm", "autoresearch"]) {
			const offered = commands.get(name)?.getArgumentCompletions?.("") ?? [];
			expect(offered.map(item => item.label)).toEqual(["status", "resume", "goal", "off", "clear"]);
			expect((commands.get(name)?.getArgumentCompletions?.("s") ?? []).map(item => item.label)).toEqual(["status"]);
			expect((commands.get(name)?.getArgumentCompletions?.("r") ?? []).map(item => item.label)).toEqual(["resume"]);
			expect((commands.get(name)?.getArgumentCompletions?.("g") ?? []).map(item => item.label)).toEqual(["goal"]);
			expect((commands.get(name)?.getArgumentCompletions?.("o") ?? []).map(item => item.label)).toEqual(["off"]);
			expect((commands.get(name)?.getArgumentCompletions?.("c") ?? []).map(item => item.label)).toEqual(["clear"]);
			expect(commands.get(name)?.getArgumentCompletions?.("b") ?? []).toEqual([]);
			// `clear` takes exactly two flags, and offering them is how a reader
			// learns `--keep-tree` exists before typing the destructive default.
			expect((commands.get(name)?.getArgumentCompletions?.("clear ") ?? []).map(item => item.label)).toEqual([
				"--keep-tree",
				"--reset-tree",
			]);
		}
	});

	it("opens a setup console for autoswarm and never for autoresearch", async () => {
		const harness = buildHarness();
		const swarmDrive: ConsoleDrive = { opened: false, overlay: false, frames: [] };
		const serialDrive: ConsoleDrive = { opened: false, overlay: false, frames: [] };
		await harness.commands
			.get("autoswarm")
			?.handler("make it faster", makeCtx(cwdDir.path(), harness.notices, ["\r"], swarmDrive));
		await harness.commands
			.get("autoresearch")
			?.handler("make it faster", makeCtx(cwdDir.path(), harness.notices, ["\r"], serialDrive));
		expect(swarmDrive.opened).toBe(true);
		expect(swarmDrive.overlay).toBe(true);
		// The serial command must never open it: a console on `/autoresearch` is
		// the two commands collapsing into one, which is the defect this closes.
		expect(serialDrive.opened).toBe(false);
	});

	it("prefills the goal from the text typed after the command", async () => {
		const harness = buildHarness();
		const drive: ConsoleDrive = { opened: false, overlay: false, frames: [] };
		await harness.commands
			.get("autoswarm")
			?.handler("make startup faster", makeCtx(cwdDir.path(), harness.notices, ["\r"], drive));
		// Typed text is a goal, not an argument, so it must reach the field
		// rather than being parsed or dropped.
		expect(drive.frames[0]?.join("\n")).toContain("make startup faster");
		expect(harness.messages).toContain("make startup faster");
	});

	/**
	 * `goal <text>` is the one subcommand both loops share, and on autoswarm the
	 * console was opened with the whole argument string, so the field read
	 * `goal make startup faster` and that literal became the goal.
	 */
	it("prefills only the text after the goal subcommand, not the word itself", async () => {
		const harness = buildHarness();
		const drive: ConsoleDrive = { opened: false, overlay: false, frames: [] };
		await harness.commands
			.get("autoswarm")
			?.handler("goal make startup faster", makeCtx(cwdDir.path(), harness.notices, ["\r"], drive));
		expect(drive.frames[0]?.join("\n")).toContain("Goal          make startup faster");
		expect(harness.messages).toContain("make startup faster");
		expect(harness.messages).not.toContain("goal make startup faster");
	});

	it("parks the breadth chosen in the console, and opens at the ring-sized default", async () => {
		const harness = buildHarness();
		const drive: ConsoleDrive = { opened: false, overlay: false, frames: [] };
		const runtime = new Map<string, unknown>();
		const ctx = makeCtx(cwdDir.path(), harness.notices, ["\x1b[B", "\x1b[C", "\r"], drive);
		(ctx as unknown as { sessionState: Map<string, unknown> }).sessionState = runtime;
		await harness.commands.get("autoswarm")?.handler("make it faster", ctx);
		// Down moves to Breadth, right raises it by one from the default.
		expect(DEFAULT_SWARM_BREADTH).toBe(3);
		const opening = drive.frames[0]?.join("\n") ?? "";
		expect(opening).toContain(`Breadth       ${DEFAULT_SWARM_BREADTH}`);
		const final = drive.frames.at(-1)?.join("\n") ?? "";
		expect(final).toContain(`Breadth       ${DEFAULT_SWARM_BREADTH + 1}`);
		// The session is opened later by init_experiment, so the value is parked
		// rather than written; an autoswarm that parks nothing runs serially under
		// the swarm name, which is the whole defect.
		const storage = await openAutoresearchStorage(cwdDir.path());
		expect(storage.getActiveSession()).toBeNull();
		expect(harness.messages).toContain("make it faster");
	});

	it("starts nothing when the console is cancelled", async () => {
		const harness = buildHarness();
		const drive: ConsoleDrive = { opened: false, overlay: false, frames: [] };
		await harness.commands
			.get("autoswarm")
			?.handler("make it faster", makeCtx(cwdDir.path(), harness.notices, ["\x1b"], drive));
		// Escape means the user changed their mind: no message, no mode, no tools,
		// and a line under the command saying so, since the command itself is
		// already in the transcript.
		expect(drive.opened).toBe(true);
		expect(harness.messages).toEqual([]);
		expect(harness.activeTools).toEqual([]);
		expect(harness.notices).toEqual([{ text: "Autoswarm setup cancelled. Nothing was started.", level: "info" }]);
	});

	it("refuses to start with an empty goal, and starts once one is typed", async () => {
		const harness = buildHarness();
		const drive: ConsoleDrive = { opened: false, overlay: false, frames: [] };
		// Enter on an empty goal must not close the console. If it did, the run
		// would start with nothing to optimize. The console states it on the legend,
		// where `enter` is, rather than printing `enter start` and ignoring the key.
		const keys = ["\r", "g", "o", "\r"];
		await harness.commands.get("autoswarm")?.handler("", makeCtx(cwdDir.path(), harness.notices, keys, drive));
		const first = drive.frames[0]?.join("\n") ?? "";
		expect(first).toContain("enter needs a goal");
		expect(first).not.toContain("enter start");
		expect(harness.messages).toContain("go");
	});

	it("leaves breadth alone when autoresearch opens, so the serial loop is unchanged", async () => {
		const harness = buildHarness();
		const ctx = makeCtx(cwdDir.path(), harness.notices);
		await harness.commands.get("autoresearch")?.handler("make it faster", ctx);
		expect(harness.messages).toContain("make it faster");
		// `/autoresearch breadth 4` is a goal, not a control: the serial command
		// has no breadth subcommand and must forward the text to the model.
		await harness.commands.get("autoresearch")?.handler("breadth 4", ctx);
		expect(harness.messages).toContain("breadth 4");
		expect(harness.notices.map(notice => notice.text).join("\n")).not.toContain("breadth set to");
	});

	it("disables under the name it was invoked with", async () => {
		const harness = buildHarness();
		const ctx = makeCtx(cwdDir.path(), harness.notices);
		await harness.commands.get("autoswarm")?.handler("off", ctx);
		expect(harness.notices.at(-1)?.text).toBe("Autoswarm mode disabled");
		await harness.commands.get("autoresearch")?.handler("off", ctx);
		expect(harness.notices.at(-1)?.text).toBe("Autoresearch mode disabled");
	});

	it("resume with no session on the branch starts nothing and says what would", async () => {
		const harness = buildHarness();
		const drive: ConsoleDrive = { opened: false, overlay: false, frames: [] };
		await harness.commands.get("autoswarm")?.handler("resume", makeCtx(cwdDir.path(), harness.notices, [], drive));
		expect(drive.opened).toBe(false);
		expect(harness.messages).toEqual([]);
		expect(harness.hidden).toEqual([]);
		expect(harness.notices).toEqual([
			{ text: "No autoswarm session on this branch to resume. /autoswarm starts one.", level: "warning" },
		]);
	});

	it("resume on a live session continues it without a console, and typing the goal back adds nothing", async () => {
		const harness = buildHarness();
		const storage = await openAutoresearchStorage(cwdDir.path());
		storage.openSession({
			name: "sess-1",
			goal: "make the tokenizer faster",
			primaryMetric: "tokens_per_second",
			metricUnit: "tok/s",
			direction: "higher",
			preferredCommand: null,
			branch: "autoresearch/test",
			baselineCommit: null,
			maxIterations: null,
			scopePaths: [],
			offLimits: [],
			constraints: [],
			secondaryMetrics: [],
		});
		const drive: ConsoleDrive = { opened: false, overlay: false, frames: [] };
		await harness.commands.get("autoswarm")?.handler("resume", makeCtx(cwdDir.path(), harness.notices, [], drive));
		// `resume` is the word for continuing with nothing to add: no console to
		// walk, no transcript line, and no notice about text that was not typed.
		expect(drive.opened).toBe(false);
		expect(harness.messages).toEqual([]);
		expect(harness.hidden.map(message => message.customType)).toEqual(["autoresearch-command-resume"]);
		expect(harness.hidden[0]?.display).toBe(false);
		expect(harness.notices.map(notice => notice.text).join("\n")).not.toContain("Your text goes to the model");
		expect(harness.notices.map(notice => notice.text).join("\n")).toContain("Resuming autoswarm sess-1");

		// The serial command with the stored goal typed back is the same resume:
		// the model is not told the goal twice, and the user is not told that
		// the goal did not change.
		harness.notices.length = 0;
		await harness.commands
			.get("autoresearch")
			?.handler("make the tokenizer faster", makeCtx(cwdDir.path(), harness.notices, [], drive));
		expect(harness.hidden).toHaveLength(2);
		expect(harness.hidden[1]?.content).not.toContain("make the tokenizer faster");
		expect(harness.notices.map(notice => notice.text).join("\n")).not.toContain("Your text goes to the model");
		expect(storage.getActiveSessionForBranch("autoresearch/test")?.goal).toBe("make the tokenizer faster");

		// Free text that is not the goal reaches the model and is announced as
		// context, and the goal is still what it was.
		harness.notices.length = 0;
		await harness.commands
			.get("autoresearch")
			?.handler("try the SIMD path next", makeCtx(cwdDir.path(), harness.notices, [], drive));
		expect(harness.hidden[2]?.content).toContain("try the SIMD path next");
		expect(harness.notices.map(notice => notice.text).join("\n")).toContain("Your text goes to the model");
		expect(storage.getActiveSessionForBranch("autoresearch/test")?.goal).toBe("make the tokenizer faster");
	});
});
