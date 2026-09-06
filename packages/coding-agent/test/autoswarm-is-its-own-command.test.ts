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
import * as initExperimentTool from "@veyyon/coding-agent/autoresearch/tools/init-experiment";
import type { AutoresearchRuntime } from "@veyyon/coding-agent/autoresearch/types";
import type { ExtensionAPI, ExtensionContext } from "@veyyon/coding-agent/extensibility/extensions";
import { theme } from "@veyyon/coding-agent/theme/theme";
import * as git from "@veyyon/coding-agent/utils/git";
import "@veyyon/coding-agent/modes/terminal/controllers/extension-ui-controller";
import { stripAnsi, TempDir } from "@veyyon/utils";
import type { AutocompleteItem } from "@veyyon/utils/autocomplete";
import { $ } from "bun";
import { useTruecolorTheme } from "./helpers/theme-assertions";

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
	getRuntime: (ctx: ExtensionContext) => AutoresearchRuntime | undefined;
}

/** Keys the console is driven with, and the frames it painted while being driven. */
interface ConsoleDrive {
	opened: boolean;
	overlay: boolean;
	frames: string[][];
	confirms: Array<{ title: string; message: string }>;
	answer: boolean;
}

interface TestExtensionContext extends ExtensionContext {
	sessionState: AutoresearchRuntime | null;
	runtime: AutoresearchRuntime | null;
}

function buildHarness(): Harness {
	const commands = new Map<string, CommandSpec>();
	const notices: Array<{ text: string; level: string }> = [];
	const messages: string[] = [];
	const hidden: Array<{ customType: string; content: string; display: boolean }> = [];
	const activeTools: string[] = [];
	let getRuntimeRef: ((ctx: ExtensionContext) => AutoresearchRuntime) | undefined;
	const orig = initExperimentTool.createInitExperimentTool;
	vi.spyOn(initExperimentTool, "createInitExperimentTool").mockImplementation(opts => {
		getRuntimeRef = opts.getRuntime;
		return orig(opts);
	});
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
	return {
		commands,
		notices,
		messages,
		hidden,
		activeTools,
		getRuntime: (ctx: ExtensionContext) => getRuntimeRef?.(ctx),
	};
}

/**
 * Drives `ui.custom` the way the real surface does: build the component through
 * the factory, render it, feed each key, and resolve with whatever `done`
 * received. Feeding real keystrokes is the point — a fake that returns a
 * configuration object would pass while the console was unreachable.
 */
function makeCtx(
	cwd: string,
	harness: Harness,
	keys: string[] = [],
	drive: ConsoleDrive = { opened: false, overlay: false, frames: [], confirms: [], answer: true },
	hasUI = true,
): TestExtensionContext {
	const ctx: TestExtensionContext = {
		cwd,
		hasUI,
		isIdle: () => true,
		hasPendingMessages: () => false,
		get sessionState(): AutoresearchRuntime | null {
			return harness.getRuntime(ctx) ?? null;
		},
		get runtime(): AutoresearchRuntime | null {
			return harness.getRuntime(ctx) ?? null;
		},
		models: {
			resolve: (_spec: string) => undefined,
		},
		ui: {
			setStatus: () => {},
			notify: (text: string, level: string) => {
				harness.notices.push({ text, level });
			},
			confirm: async (title: string, message: string): Promise<boolean> => {
				drive.confirms.push({ title, message });
				return drive.answer;
			},
			terminal: {
				custom: async <T>(
					factory: (
						tui: unknown,
						theme: unknown,
						keybindings: unknown,
						done: (result: T) => void,
					) => { render: (width: number) => readonly string[]; handleInput: (data: string) => void },
					options?: { overlay?: boolean | { anchor?: string } },
				): Promise<T> => {
					drive.opened = true;
					// The launcher opens as a centered card; the dashboard as a plain overlay.
					drive.overlay = options?.overlay === true || typeof options?.overlay === "object";
					const settled: Array<{ value: T }> = [];
					const tui = { requestRender: (): void => {}, terminal: { rows: 40, columns: 80 }, pinnedFooterRows: 5 };
					const component = factory(tui, theme, {}, (result: T) => {
						if (settled.length === 0) settled.push({ value: result });
					});
					drive.frames.push([...component.render(80)]);
					for (const key of keys) {
						if (settled.length > 0) break;
						component.handleInput(key);
						drive.frames.push([...component.render(80)]);
					}
					const outcome = settled[0];
					if (!outcome) throw new Error(`console never resolved for keys: ${JSON.stringify(keys)}`);
					return outcome.value;
				},
			},
		},
		sessionManager: {
			getSessionId: () => "session-autoswarm-test",
			getBranch: () => [],
		},
	} as unknown as TestExtensionContext;
	return ctx;
}

describe("autoswarm is its own command", () => {
	useTruecolorTheme("dark");

	let dbDir: TempDir;
	let cwdDir: TempDir;

	beforeEach(async () => {
		dbDir = TempDir.createSync("@pi-autoswarm-cmd-db-");
		process.env.VEYYON_AUTORESEARCH_DB_DIR = dbDir.path();
		cwdDir = TempDir.createSync("@pi-autoswarm-cmd-cwd-");
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

	it("leaves getArgumentCompletions undefined on autoswarm, and defines it on autoresearch", () => {
		const { commands } = buildHarness();
		expect(commands.get("autoswarm")?.getArgumentCompletions).toBeUndefined();
		const completions = commands.get("autoresearch")?.getArgumentCompletions?.("") ?? [];
		expect(completions.map(item => item.label)).toEqual(["status", "resume", "goal", "off", "clear"]);
	});

	it("opens the console overlay at 3 arms with models row for /autoswarm", async () => {
		const harness = buildHarness();
		const swarmDrive: ConsoleDrive = { opened: false, overlay: false, frames: [], confirms: [], answer: true };
		expect(DEFAULT_SWARM_BREADTH).toBe(3);

		await harness.commands.get("autoswarm")?.handler("", makeCtx(cwdDir.path(), harness, ["\x1b"], swarmDrive));
		expect(swarmDrive.opened).toBe(true);
		expect(swarmDrive.overlay).toBe(true);
		const swarmFrame = stripAnsi(swarmDrive.frames[0]?.join("\n") ?? "");
		expect(swarmFrame).toMatch(/Breadth\s+◂ 3 arms ▸/);
		expect(swarmFrame).toContain("Models");
	});

	it("/autoswarm with arguments warns and does not put the text into the console frame", async () => {
		const harness = buildHarness();
		const drive: ConsoleDrive = { opened: false, overlay: false, frames: [], confirms: [], answer: true };
		await harness.commands
			.get("autoswarm")
			?.handler("make it faster", makeCtx(cwdDir.path(), harness, ["\x1b"], drive));

		expect(drive.opened).toBe(true);
		expect(drive.overlay).toBe(true);
		expect(harness.notices.some(n => n.level === "warning" && n.text.includes("takes no arguments"))).toBe(true);
		const frame = stripAnsi(drive.frames[0]?.join("\n") ?? "");
		expect(frame).not.toContain("make it faster");
	});

	it("/autoresearch with a goal starts the serial loop without opening a console", async () => {
		const harness = buildHarness();
		const drive: ConsoleDrive = { opened: false, overlay: false, frames: [], confirms: [], answer: true };
		await harness.commands.get("autoresearch")?.handler("make it faster", makeCtx(cwdDir.path(), harness, [], drive));

		expect(drive.opened).toBe(false);
		expect(harness.messages).toContain("make it faster");
		expect(harness.activeTools).toContain("run_experiment");
	});

	it("starts nothing when the console is closed with Escape", async () => {
		const harness = buildHarness();
		const drive: ConsoleDrive = { opened: false, overlay: false, frames: [], confirms: [], answer: true };
		await harness.commands.get("autoswarm")?.handler("", makeCtx(cwdDir.path(), harness, ["\x1b"], drive));

		expect(drive.opened).toBe(true);
		expect(harness.messages).toEqual([]);
		expect(harness.activeTools).toEqual([]);
		expect(harness.notices.some(n => n.text.toLowerCase().includes("cancel"))).toBe(false);
	});

	it("refuses to start from an empty Goal row on /autoswarm, then starts on Enter once the goal is typed", async () => {
		const harness = buildHarness();
		const drive: ConsoleDrive = { opened: false, overlay: false, frames: [], confirms: [], answer: true };
		// The console opens on Goal with nothing to start. Enter is blocked, the
		// goal is typed, and Enter on the same row starts: three keys, no Up.
		const keys = ["\r", "f", "a", "s", "t", "\r"];
		await harness.commands.get("autoswarm")?.handler("", makeCtx(cwdDir.path(), harness, keys, drive));

		const firstFrame = stripAnsi(drive.frames[0]?.join("\n") ?? "");
		expect(firstFrame).toContain("needs a goal");
		expect(firstFrame).toMatch(/▸ Goal/);
		expect(harness.messages).toContain("fast");
		expect(harness.activeTools).toContain("run_experiment");
	});

	it("parks the breadth set on the Breadth row, by arrow and by digit", async () => {
		const harness = buildHarness();
		const drive: ConsoleDrive = { opened: false, overlay: false, frames: [], confirms: [], answer: true };
		// Opens on Goal (autoswarm, no goal). Type the goal, Down past Preset to
		// Breadth, → raises 3 to 4, `6` sets it outright, Up to Goal, Enter starts.
		const keys = [..."make it faster", "\x1b[B", "\x1b[B", "\x1b[C", "6", "\x1b[A", "\x1b[A", "\r"];
		const ctx = makeCtx(cwdDir.path(), harness, keys, drive);
		await harness.commands.get("autoswarm")?.handler("", ctx);

		const storage = await openAutoresearchStorage(cwdDir.path());
		expect(storage.getActiveSession()).toBeNull();
		expect(ctx.sessionState?.pendingSwarm?.breadth).toBe(6);
		expect(harness.messages).toContain("make it faster");
	});

	it("leaves the stored goal alone when /autoresearch is passed text over an existing session", async () => {
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
		const drive: ConsoleDrive = { opened: false, overlay: false, frames: [], confirms: [], answer: true };
		await harness.commands
			.get("autoresearch")
			?.handler("continue where it left off", makeCtx(cwdDir.path(), harness, [], drive));

		expect(drive.opened).toBe(false);
		expect(harness.notices.some(n => n.level === "info" && n.text.includes("Your text goes to the model"))).toBe(
			true,
		);
		expect(storage.getActiveSessionForBranch("autoresearch/test")?.goal).toBe("make the tokenizer faster");
		expect(harness.hidden.map(m => m.customType)).toEqual(["autoresearch-command-resume"]);
		expect(harness.hidden[0]?.content).toContain("continue where it left off");
	});

	it("dispatches a hidden resume message and notifies per breadth on Resume", async () => {
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
			breadth: 3,
		});
		const drive: ConsoleDrive = { opened: false, overlay: false, frames: [], confirms: [], answer: true };
		// Over a session the dashboard opens: `s` resumes.
		await harness.commands.get("autoswarm")?.handler("", makeCtx(cwdDir.path(), harness, ["s"], drive));

		expect(harness.hidden).toHaveLength(1);
		expect(harness.hidden[0]?.customType).toBe("autoresearch-command-resume");
		expect(harness.hidden[0]?.display).toBe(false);
		expect(harness.notices.some(n => n.text.includes("Resuming autoswarm sess-1"))).toBe(true);

		// Now test serial session notifying Resuming autoresearch sess-2
		harness.notices.length = 0;
		storage.closeSession(storage.getActiveSessionForBranch("autoresearch/test")!.id);
		storage.openSession({
			name: "sess-2",
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
			breadth: 1,
		});
		const serialDrive: ConsoleDrive = { opened: false, overlay: false, frames: [], confirms: [], answer: true };
		await harness.commands.get("autoresearch")?.handler("resume", makeCtx(cwdDir.path(), harness, [], serialDrive));

		expect(harness.notices.some(n => n.text.includes("Resuming autoresearch sess-2"))).toBe(true);
	});

	it("starts without a console on /autoresearch with a goal when hasUI is false, and bare /autoswarm warns", async () => {
		const harness = buildHarness();
		const drive: ConsoleDrive = { opened: false, overlay: false, frames: [], confirms: [], answer: true };
		await harness.commands
			.get("autoresearch")
			?.handler("make it faster", makeCtx(cwdDir.path(), harness, [], drive, false));

		expect(drive.opened).toBe(false);
		expect(harness.messages).toContain("make it faster");

		await harness.commands.get("autoswarm")?.handler("", makeCtx(cwdDir.path(), harness, [], drive, false));

		expect(drive.opened).toBe(false);
		expect(
			harness.notices.some(n => n.level === "warning" && n.text.includes("console needs an interactive terminal")),
		).toBe(true);
	});

	it("disables mode and active tools when Stop is chosen from the autoswarm console", async () => {
		const harness = buildHarness();
		const storage = await openAutoresearchStorage(cwdDir.path());
		storage.openSession({
			name: "sess-stop",
			goal: "make it faster",
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
			breadth: 3,
		});

		// Turn mode on first: `s` resumes.
		const driveStart: ConsoleDrive = { opened: false, overlay: false, frames: [], confirms: [], answer: true };
		await harness.commands.get("autoswarm")?.handler("", makeCtx(cwdDir.path(), harness, ["s"], driveStart));
		expect(harness.activeTools).toContain("run_experiment");

		// Over a live loop with mode on the bar offers Stop on `x`.
		const driveStop: ConsoleDrive = { opened: false, overlay: false, frames: [], confirms: [], answer: true };
		await harness.commands.get("autoswarm")?.handler("", makeCtx(cwdDir.path(), harness, ["x"], driveStop));

		expect(harness.notices.at(-1)?.text).toBe("Autoswarm mode disabled");
		expect(harness.activeTools).toEqual([]);
	});

	it("closes the session and keeps every file without asking on Clear session from the console", async () => {
		const harness = buildHarness();
		const storage = await openAutoresearchStorage(cwdDir.path());
		storage.openSession({
			name: "sess-clear",
			goal: "make it faster",
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
			breadth: 3,
		});
		const dirty = path.join(cwdDir.path(), "work-in-progress.txt");
		await Bun.write(dirty, "unsaved\n");
		const harnessFile = path.join(cwdDir.path(), "autoresearch.sh");
		await Bun.write(harnessFile, "#!/usr/bin/env bash\necho METRIC ms=1\n");

		// Mode off, no baseline: Clear session is on `c`.
		const drive: ConsoleDrive = { opened: false, overlay: false, frames: [], confirms: [], answer: true };
		await harness.commands.get("autoswarm")?.handler("", makeCtx(cwdDir.path(), harness, ["c"], drive));

		expect(drive.confirms).toEqual([]);
		expect(await Bun.file(dirty).exists()).toBe(true);
		expect(await Bun.file(harnessFile).exists()).toBe(true);
		expect(harness.notices.at(-1)?.text).toBe("Autoresearch session cleared.");
		expect(storage.getActiveSessionForBranch("autoresearch/test")).toBeNull();
	});

	it("asks before resetting worktree on Reset worktree from the console, and resets on confirm", async () => {
		const harness = buildHarness();
		const head = (await $`git rev-parse HEAD`.cwd(cwdDir.path()).quiet()).stdout.toString().trim();
		const storage = await openAutoresearchStorage(cwdDir.path());
		storage.openSession({
			name: "sess-reset",
			goal: "make it faster",
			primaryMetric: "tokens_per_second",
			metricUnit: "tok/s",
			direction: "higher",
			preferredCommand: null,
			branch: "autoresearch/test",
			baselineCommit: head,
			maxIterations: null,
			scopePaths: [],
			offLimits: [],
			constraints: [],
			secondaryMetrics: [],
			breadth: 3,
		});
		const dirty = path.join(cwdDir.path(), "work-in-progress.txt");
		await Bun.write(dirty, "unsaved\n");

		// Mode off, with baseline: Reset worktree is on `r`. Decline first.
		const driveDecline: ConsoleDrive = { opened: false, overlay: false, frames: [], confirms: [], answer: false };
		await harness.commands.get("autoswarm")?.handler("", makeCtx(cwdDir.path(), harness, ["r"], driveDecline));

		expect(driveDecline.confirms.length).toBe(1);
		expect(driveDecline.confirms[0]?.title).toBe("Reset worktree to baseline?");
		expect(await Bun.file(dirty).exists()).toBe(true);
		expect(harness.notices.at(-1)?.text).toBe("Clear cancelled; nothing was reset.");
		expect(storage.getActiveSessionForBranch("autoresearch/test")).not.toBeNull();

		// Test confirm
		const driveConfirm: ConsoleDrive = { opened: false, overlay: false, frames: [], confirms: [], answer: true };
		await harness.commands.get("autoswarm")?.handler("", makeCtx(cwdDir.path(), harness, ["r"], driveConfirm));

		expect(driveConfirm.confirms.length).toBe(1);
		expect(await Bun.file(dirty).exists()).toBe(false);
		expect(harness.notices.some(n => n.text.includes("Autoresearch session cleared."))).toBe(true);
		expect(storage.getActiveSessionForBranch("autoresearch/test")).toBeNull();
	});

	it("closes branch session keeping files and starts a fresh session on New session from the console", async () => {
		const harness = buildHarness();
		const storage = await openAutoresearchStorage(cwdDir.path());
		const session = storage.openSession({
			name: "sess-new",
			goal: "make it faster",
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
			breadth: 3,
		});

		// Insert 2 runs
		for (let i = 0; i < 2; i++) {
			const run = storage.insertRun({
				sessionId: session.id,
				segment: 0,
				command: "bash autoresearch.sh",
				logPath: "run.log",
				preRunDirtyPaths: [],
				startedAt: 1 + i,
				arm: "a0",
				model: "acme/sonnet",
			});
			storage.markRunCompleted({
				runId: run.id,
				completedAt: 2 + i,
				durationMs: 1000,
				exitCode: 0,
				timedOut: false,
				parsedPrimary: 200,
				parsedMetrics: { ms: 200 },
				parsedAsi: null,
			});
			storage.markRunLogged({
				runId: run.id,
				status: "keep",
				description: `run ${i}`,
				metric: 200,
				metrics: { ms: 200 },
				asi: null,
				commitHash: null,
				confidence: null,
				modifiedPaths: [],
				scopeDeviations: [],
				justification: null,
				loggedAt: 3 + i,
				arm: "a0",
			});
		}

		const dirty = path.join(cwdDir.path(), "work-in-progress.txt");
		await Bun.write(dirty, "keep this\n");

		// New session is on `n`.
		const drive: ConsoleDrive = { opened: false, overlay: false, frames: [], confirms: [], answer: true };
		await harness.commands.get("autoswarm")?.handler("", makeCtx(cwdDir.path(), harness, ["n"], drive));

		expect(await Bun.file(dirty).exists()).toBe(true);
		expect(
			harness.notices.some(n => n.text === "Closed sess-new · 2 runs kept in the store. Starting a new session."),
		).toBe(true);
		expect(storage.listLoggedRuns(session.id)).toHaveLength(2);
		expect(harness.messages).toContain("make it faster");
		expect(harness.activeTools).toContain("run_experiment");
	});
});
