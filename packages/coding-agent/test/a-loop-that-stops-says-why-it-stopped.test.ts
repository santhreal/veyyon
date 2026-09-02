/**
 * WHY: a loop that leaves the screen without a word reads as a broken feature.
 *
 * An autoresearch session is pinned to the branch it was opened on, and it used
 * to be looked up by that branch alone. Off the branch the lookup returned
 * nothing, which is the same answer it gives for a project that never started a
 * loop, so the two states were indistinguishable and each went wrong in its own
 * direction. A checkout mid-conversation was noticed by nothing: the loop kept
 * its experiment tools and kept injecting its system prompt while standing on
 * another branch. A session resumed off that branch loaded no runs at all, so the
 * row read `autoresearch · baseline pending` and `ctrl+x` reported nothing while
 * the database held every run. Nothing on screen named the branch, so the way
 * back was a guess.
 *
 * The class closed here: every path that suspends the mode for a branch mismatch
 * states it on the row, keeps the session's runs readable, and names the branch to
 * return to. Both paths are swept — the one that runs before a turn and the one
 * that runs when the branch event arrives — because they are separate handlers
 * that make the same decision, and the first fix landed in only one of them.
 *
 * Not caught here: what the row looks like at a width that sheds segments (the
 * status-row suites own that), and whether the tools detach, which
 * `activeToolsFor` owns.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAutoresearchExtension } from "@veyyon/coding-agent/autoresearch";
import {
	closeAllAutoresearchStorages,
	openAutoresearchStorage,
	openAutoresearchStorageIfExists,
} from "@veyyon/coding-agent/autoresearch/storage";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionBranchEvent,
	SessionStartEvent,
} from "@veyyon/coding-agent/extensibility/extensions";
import * as git from "@veyyon/coding-agent/utils/git";
import { stripAnsi, TempDir } from "@veyyon/utils";
import { useTruecolorTheme } from "./helpers/theme-assertions";

useTruecolorTheme("dark");
const execFileAsync = promisify(execFile);

const SESSION_BRANCH = "autoresearch/tokenizer-throughput";

interface Handlers {
	session_start?: ExtensionHandler<SessionStartEvent>;
	session_branch?: ExtensionHandler<SessionBranchEvent>;
	before_agent_start?: ExtensionHandler<BeforeAgentStartEvent, unknown>;
}

interface Harness {
	handlers: Handlers;
	/** The status row as the user sees it, or null once it is taken away. */
	row(): string | null;
	activeTools: string[];
	/** `/autoresearch <args>`, as the slash command runs it. */
	command(name: string, args: string, ctx: ExtensionContext): Promise<void>;
}

function buildHarness(): Harness {
	const handlers: Handlers = {};
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const activeTools: string[] = ["read"];
	const api = {
		appendEntry(): void {},
		exec: async () => ({ code: 0, stderr: "", stdout: "" }),
		on(event: string, handler: ExtensionHandler<unknown, unknown>): void {
			(handlers as Record<string, ExtensionHandler<unknown, unknown>>)[event] = handler;
		},
		registerCommand(name: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }): void {
			commands.set(name, spec.handler);
		},
		registerShortcut(): void {},
		registerTool(): void {},
		getActiveTools: (): string[] => [...activeTools],
		setActiveTools: async (names: string[]): Promise<void> => {
			activeTools.splice(0, activeTools.length, ...names);
		},
		sendUserMessage(): void {},
		sendMessage(): void {},
	} as unknown as ExtensionAPI;
	createAutoresearchExtension(api);
	let status: string | undefined;
	return {
		handlers,
		activeTools,
		row: () => status ?? null,
		command: async (name, args, ctx) => {
			const handler = commands.get(name);
			if (!handler) throw new Error(`no command ${name}`);
			await handler(args, ctx);
		},
		__setStatus: (value: string | undefined): void => {
			status = value;
		},
	} as Harness & { __setStatus: (value: string | undefined) => void };
}

/**
 * `activated` is whether this conversation ever turned autoresearch on. A tree
 * that never did has no control entry at all, which is what makes the extension
 * skip storage instead of reporting a loop nobody started.
 */
function makeCtx(harness: Harness, cwd: string, activated = true): ExtensionContext {
	const setStatus = (harness as Harness & { __setStatus: (value: string | undefined) => void }).__setStatus;
	return {
		cwd,
		hasUI: true,
		hasPendingMessages: () => false,
		ui: {
			setStatus: (_slot: string, value: string | undefined) => setStatus(value),
			notify: () => {},
			requestRender: () => {},
		},
		sessionManager: {
			getSessionId: () => "session-branch-drop",
			getBranch: () =>
				activated
					? [
							{
								type: "custom",
								customType: "autoresearch-control",
								id: "ctrl-1",
								parentId: null,
								timestamp: new Date(0).toISOString(),
								data: { mode: "on", goal: "make the tokenizer faster" },
							},
						]
					: [],
		},
	} as unknown as ExtensionContext;
}

/**
 * A session on {@link SESSION_BRANCH}. With `withRun` it also carries one logged
 * run, so a dropped state is visible as a lost run; without one the session has
 * no results at all, which is the case a run count cannot speak for.
 */
async function seedSession(cwd: string, withRun = true): Promise<void> {
	const storage = await openAutoresearchStorage(cwd);
	const session = storage.openSession({
		name: "tokenizer throughput",
		goal: "make the tokenizer faster",
		primaryMetric: "ms",
		metricUnit: "ms",
		direction: "lower",
		preferredCommand: "bash autoresearch.sh",
		branch: SESSION_BRANCH,
		baselineCommit: null,
		maxIterations: null,
		scopePaths: [],
		offLimits: [],
		constraints: [],
		secondaryMetrics: [],
		breadth: 4,
		attempts: 1,
		maxParallel: 4,
		certify: true,
	});
	if (!withRun) return;
	const run = storage.insertRun({
		sessionId: session.id,
		segment: 0,
		command: "bash autoresearch.sh",
		logPath: "run.log",
		preRunDirtyPaths: [],
		startedAt: 1,
		arm: "a0",
		model: "acme/sonnet",
	});
	storage.markRunCompleted({
		runId: run.id,
		completedAt: 2,
		durationMs: 1000,
		exitCode: 0,
		timedOut: false,
		parsedPrimary: 240.1,
		parsedMetrics: { ms: 240.1 },
		parsedAsi: null,
	});
	storage.markRunLogged({
		runId: run.id,
		status: "keep",
		description: "baseline",
		metric: 240.1,
		metrics: { ms: 240.1 },
		asi: null,
		commitHash: null,
		confidence: null,
		modifiedPaths: [],
		scopeDeviations: [],
		justification: null,
		loggedAt: 3,
		arm: "a0",
	});
}

/**
 * The suite above mocks `git.branch.current`, so it proves the decision and not
 * the read behind it. This one runs the same turn against a real repository and a
 * real checkout: the branch comes from git, the storage is resolved from the real
 * repo root, and nothing about the environment is stubbed.
 */
describe("a real checkout is what the turn reads", () => {
	let dbDir: TempDir;
	let repoDir: TempDir;

	const git_ = async (cwd: string, ...args: string[]): Promise<string> => {
		const { stdout } = await execFileAsync("git", args, { cwd });
		return stdout.trim();
	};

	beforeEach(async () => {
		dbDir = TempDir.createSync("@pi-autoresearch-realgit-db-");
		process.env.VEYYON_AUTORESEARCH_DB_DIR = dbDir.path();
		repoDir = TempDir.createSync("@pi-autoresearch-realgit-repo-");
		const cwd = repoDir.path();
		await git_(cwd, "init", "-q", "-b", "main");
		await git_(cwd, "config", "user.email", "test@example.invalid");
		await git_(cwd, "config", "user.name", "test");
		await git_(cwd, "commit", "-q", "--allow-empty", "-m", "root");
		await git_(cwd, "checkout", "-q", "-b", SESSION_BRANCH);
		await seedSession(cwd);
	});

	afterEach(() => {
		delete process.env.VEYYON_AUTORESEARCH_DB_DIR;
		closeAllAutoresearchStorages();
		repoDir.removeSync();
		dbDir.removeSync();
	});

	it("pauses on a real branch switch and resumes on a real switch back", async () => {
		const cwd = repoDir.path();
		const harness = buildHarness();
		const ctx = makeCtx(harness, cwd);
		if (!harness.handlers.session_start || !harness.handlers.before_agent_start) throw new Error("handlers missing");

		await harness.handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);
		expect(stripAnsi(harness.row() ?? "")).toContain("autoswarm");

		await git_(cwd, "checkout", "-q", "main");
		expect(await git.branch.current(cwd)).toBe("main");
		await harness.handlers.before_agent_start(
			{ type: "before_agent_start", prompt: "say ok", systemPrompt: [] },
			ctx,
		);

		const paused = stripAnsi(harness.row() ?? "");
		expect(paused).toContain("paused");
		expect(paused).toContain(SESSION_BRANCH);

		await git_(cwd, "checkout", "-q", SESSION_BRANCH);
		await harness.handlers.before_agent_start(
			{ type: "before_agent_start", prompt: "say ok", systemPrompt: [] },
			ctx,
		);
		expect(stripAnsi(harness.row() ?? "")).not.toContain("paused");
	});
});

describe("a loop that stops says why it stopped", () => {
	let dbDir: TempDir;
	let cwdDir: TempDir;

	beforeEach(async () => {
		dbDir = TempDir.createSync("@pi-autoresearch-pause-db-");
		process.env.VEYYON_AUTORESEARCH_DB_DIR = dbDir.path();
		cwdDir = TempDir.createSync("@pi-autoresearch-pause-cwd-");
		vi.spyOn(git.repo, "root").mockResolvedValue(cwdDir.path());
		vi.spyOn(git.branch, "current").mockResolvedValue(SESSION_BRANCH);
		await seedSession(cwdDir.path());
		// The fixture must be real before any behavior is asserted: a lookup that
		// returns nothing here would make every assertion below pass or fail for
		// reasons that have nothing to do with the branch.
		const seeded = await openAutoresearchStorageIfExists(cwdDir.path());
		expect(seeded?.getActiveSessionForBranch(SESSION_BRANCH)?.breadth ?? null).toBe(4);
	});

	afterEach(() => {
		delete process.env.VEYYON_AUTORESEARCH_DB_DIR;
		closeAllAutoresearchStorages();
		cwdDir.removeSync();
		dbDir.removeSync();
		vi.restoreAllMocks();
	});

	it("keeps the row and names the branch when a turn starts off the session's branch", async () => {
		const harness = buildHarness();
		const ctx = makeCtx(harness, cwdDir.path());
		if (!harness.handlers.session_start || !harness.handlers.before_agent_start) throw new Error("handlers missing");

		await harness.handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);
		const live = harness.row();
		expect(live).not.toBeNull();
		expect(stripAnsi(live ?? "")).toContain("autoswarm");

		// The user checks out another branch and sends a message.
		vi.spyOn(git.branch, "current").mockResolvedValue("main");
		await harness.handlers.before_agent_start({ type: "before_agent_start", prompt: "hi", systemPrompt: [] }, ctx);

		const paused = harness.row();
		expect(paused).not.toBeNull();
		const text = stripAnsi(paused ?? "");
		expect(text).toContain("paused");
		expect(text).toContain(SESSION_BRANCH);
		// The session's own state survived the switch rather than being reset to an
		// empty one: `autoswarm` is derived from the loaded breadth of 4, so a
		// blanked state would print `autoresearch` here. This is what makes ctrl+x
		// open the real runs instead of claiming the session is empty.
		expect(text).toContain("autoswarm");
		expect(text).not.toContain("baseline pending");
	});

	it("says the same thing when the branch event is what notices", async () => {
		const harness = buildHarness();
		const ctx = makeCtx(harness, cwdDir.path());
		if (!harness.handlers.session_start || !harness.handlers.session_branch) throw new Error("handlers missing");

		await harness.handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);
		vi.spyOn(git.branch, "current").mockResolvedValue("main");
		await harness.handlers.session_branch({ type: "session_branch" } as SessionBranchEvent, ctx);

		const text = stripAnsi(harness.row() ?? "");
		expect(text).toContain("paused");
		expect(text).toContain(SESSION_BRANCH);
	});

	it("drops the pause the moment the branch is back, without a restart", async () => {
		// A git checkout mid-conversation raises no event of its own: `session_branch`
		// is the conversation tree branching. `before_agent_start` re-reading the
		// branch each turn is the only thing that notices, in both directions, so a
		// pause it took has to be a pause it can also lift. Taking the pause and then
		// returning early on it stranded the loop until the session was restarted.
		const harness = buildHarness();
		const ctx = makeCtx(harness, cwdDir.path());
		const turn: BeforeAgentStartEvent = { type: "before_agent_start", prompt: "hi", systemPrompt: [] };
		if (!harness.handlers.session_start || !harness.handlers.before_agent_start) throw new Error("handlers missing");

		await harness.handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);
		expect(harness.activeTools).toContain("run_experiment");

		vi.spyOn(git.branch, "current").mockResolvedValue("main");
		await harness.handlers.before_agent_start(turn, ctx);
		expect(stripAnsi(harness.row() ?? "")).toContain("paused");
		expect(harness.activeTools).not.toContain("run_experiment");

		vi.spyOn(git.branch, "current").mockResolvedValue(SESSION_BRANCH);
		await harness.handlers.before_agent_start(turn, ctx);

		const text = stripAnsi(harness.row() ?? "");
		expect(text).not.toContain("paused");
		expect(text).toContain("1 runs");
		// The tools come back with the loop, or the model cannot measure anything.
		expect(harness.activeTools).toContain("run_experiment");
	});

	it("stops naming a branch when the loop is turned off while it is paused", async () => {
		// A pause is its own reason to report a row, so an explicit `off` has to
		// clear it too. Otherwise the row goes on naming a branch to return to for
		// a loop the user has just shut down, and nothing short of a restart
		// removes it.
		const harness = buildHarness();
		const ctx = makeCtx(harness, cwdDir.path());
		const turn: BeforeAgentStartEvent = { type: "before_agent_start", prompt: "hi", systemPrompt: [] };
		if (!harness.handlers.session_start || !harness.handlers.before_agent_start) throw new Error("handlers missing");

		await harness.handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);
		vi.spyOn(git.branch, "current").mockResolvedValue("main");
		await harness.handlers.before_agent_start(turn, ctx);
		expect(stripAnsi(harness.row() ?? "")).toContain("paused");

		await harness.command("autoresearch", "off", ctx);
		// The row survives `off` on a loop that has results -- it reports them with
		// `mode off` -- but it must stop naming a branch to go back to.
		const afterOff = stripAnsi(harness.row() ?? "");
		expect(afterOff).not.toContain("paused");
		expect(afterOff).toContain("mode off");
	});

	it("names the branch even before the loop has logged a run", async () => {
		// A swarm configured and left before its first run finished. There are no
		// results, so nothing about a run count can keep the row alive: the pause
		// itself has to be reason enough to report, or the session disappears at
		// exactly the moment the user has the least idea what happened to it.
		closeAllAutoresearchStorages();
		const fresh = TempDir.createSync("@pi-autoresearch-pause-fresh-");
		try {
			vi.spyOn(git.repo, "root").mockResolvedValue(fresh.path());
			vi.spyOn(git.branch, "current").mockResolvedValue(SESSION_BRANCH);
			await seedSession(fresh.path(), false);
			const harness = buildHarness();
			const ctx = makeCtx(harness, fresh.path());
			if (!harness.handlers.session_start || !harness.handlers.session_branch) throw new Error("handlers missing");

			await harness.handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);
			vi.spyOn(git.branch, "current").mockResolvedValue("main");
			await harness.handlers.session_branch({ type: "session_branch" } as SessionBranchEvent, ctx);

			const text = stripAnsi(harness.row() ?? "");
			expect(text).toContain("paused");
			expect(text).toContain(SESSION_BRANCH);
		} finally {
			fresh.removeSync();
		}
	});

	it("says nothing about a branch on a session that was never opened", async () => {
		// A tree with no session at all: the row does not exist, and inventing a
		// pause for it would put an autoresearch row on every unrelated project.
		closeAllAutoresearchStorages();
		const empty = TempDir.createSync("@pi-autoresearch-pause-empty-");
		try {
			vi.spyOn(git.repo, "root").mockResolvedValue(empty.path());
			vi.spyOn(git.branch, "current").mockResolvedValue("main");
			const harness = buildHarness();
			const ctx = makeCtx(harness, empty.path(), false);
			if (!harness.handlers.session_start) throw new Error("handlers missing");
			await harness.handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);
			expect(harness.row()).toBeNull();
		} finally {
			empty.removeSync();
		}
	});
});
