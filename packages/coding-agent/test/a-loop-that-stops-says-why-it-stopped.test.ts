/**
 * WHY: a loop that leaves the screen without a word reads as a broken feature.
 *
 * An autoresearch session is pinned to the branch it was opened on. Checking out
 * another branch — to read something, to compare, to answer a question — used to
 * take the mode down in silence: the handler set the mode off, replaced the state
 * with an empty one, and the status row went from the run in flight to nothing at
 * all. `hasSession()` reads the state it had just emptied, so the row was removed
 * rather than repainted, and `ctrl+x` opened a screen that said no runs existed
 * while the database held every one of them. Nothing on screen named the branch,
 * so the way back was a guess.
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
}

function buildHarness(): Harness {
	const handlers: Handlers = {};
	const activeTools: string[] = ["read"];
	const api = {
		appendEntry(): void {},
		exec: async () => ({ code: 0, stderr: "", stdout: "" }),
		on(event: string, handler: ExtensionHandler<unknown, unknown>): void {
			(handlers as Record<string, ExtensionHandler<unknown, unknown>>)[event] = handler;
		},
		registerCommand(): void {},
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
		const harness = buildHarness();
		const ctx = makeCtx(harness, cwdDir.path());
		if (!harness.handlers.session_start || !harness.handlers.session_branch) throw new Error("handlers missing");

		await harness.handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);
		vi.spyOn(git.branch, "current").mockResolvedValue("main");
		await harness.handlers.session_branch({ type: "session_branch" } as SessionBranchEvent, ctx);
		expect(stripAnsi(harness.row() ?? "")).toContain("paused");

		vi.spyOn(git.branch, "current").mockResolvedValue(SESSION_BRANCH);
		await harness.handlers.session_branch({ type: "session_branch" } as SessionBranchEvent, ctx);

		const text = stripAnsi(harness.row() ?? "");
		expect(text).not.toContain("paused");
		expect(text).toContain("1 runs");
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
