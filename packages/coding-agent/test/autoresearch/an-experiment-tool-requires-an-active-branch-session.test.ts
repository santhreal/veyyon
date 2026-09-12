/**
 * WHY: every autoresearch tool that mutates or reports on an experiment session
 * (`certify_arms`, `log_experiment`, `run_experiment`, `start_arm`, `update_notes`)
 * requires an active autoresearch session for the branch the working tree is
 * currently on. The initial check was previously duplicated across all five tools.
 *
 * This suite defends:
 * 1. The resolution contract across missing storage, wrong branch, inactive/closed
 *    sessions, detached HEAD with named session, valid active branch sessions, and
 *    valid null-branch/detached sessions.
 * 2. Parameterized coverage of every tool entry point reached through the factory
 *    registry with typed thunks and concrete per-tool success assertions.
 * 3. `init_experiment` is pinned by exact equality as the sole intentional opt-out
 *    among `EXPERIMENT_TOOL_NAMES`.
 * 4. Error returns produce fresh payload objects so caller mutations cannot corrupt
 *    subsequent executions.
 * 5. Git resolution exceptions propagate cleanly to callers.
 *
 * What it does not catch: downstream tool-specific execution once session resolution succeeds.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import {
	type AutoresearchStorage,
	closeAllAutoresearchStorages,
	openAutoresearchStorage,
	type SessionRow,
} from "@veyyon/coding-agent/autoresearch/storage";
import { createCertifyArmsTool } from "@veyyon/coding-agent/autoresearch/tools/certify-arms";
import { EXPERIMENT_TOOL_NAMES } from "@veyyon/coding-agent/autoresearch/tools/index";
import { createLogExperimentTool } from "@veyyon/coding-agent/autoresearch/tools/log-experiment";
import { createRunExperimentTool } from "@veyyon/coding-agent/autoresearch/tools/run-experiment";
import { createStartArmTool } from "@veyyon/coding-agent/autoresearch/tools/start-arm";
import { createUpdateNotesTool } from "@veyyon/coding-agent/autoresearch/tools/update-notes";
import type {
	AutoresearchToolFactoryOptions,
	DashboardController,
	LogDetails,
	RunDetails,
} from "@veyyon/coding-agent/autoresearch/types";
import type { ExtensionAPI, ExtensionContext } from "@veyyon/coding-agent/extensibility/extensions";
import * as git from "@veyyon/coding-agent/utils/git";
import type { ToolResult } from "@veyyon/tool";
import { TempDir } from "@veyyon/utils";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

useIsolatedAgentDir();

const execFileAsync = promisify(execFile);

afterEach(() => {
	vi.restoreAllMocks();
});

const MISSING_SESSION_ERROR_TEXT =
	"Error: no active autoresearch session for the current branch. Call init_experiment first.";

const OPTED_OUT_TOOLS = ["init_experiment"];
const SESSION_REQUIRING_TOOLS = EXPERIMENT_TOOL_NAMES.filter(name => !OPTED_OUT_TOOLS.includes(name));

function dummyDashboard(): DashboardController {
	return {
		clear(): void {},
		requestRender(): void {},
		showScreen: async (): Promise<void> => {},
		showLauncher: async (): Promise<void> => {},
		update(): void {},
	};
}

function createTestCtx(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		sessionManager: { getSessionId: () => "test-session-id" },
		models: { list: () => [], current: () => undefined, resolve: () => undefined },
	} as unknown as ExtensionContext;
}

function createFactoryOptions(): AutoresearchToolFactoryOptions {
	const runtime = createSessionRuntime();
	return {
		dashboard: dummyDashboard(),
		getRuntime: () => runtime,
		pi: {
			appendEntry: () => {},
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
			getActiveTools: () => [],
			setActiveTools: async () => {},
		} as unknown as ExtensionAPI,
	};
}

function openTestSession(
	storage: AutoresearchStorage,
	branch: string | null = "autoresearch/test-arm",
	breadth = 2,
): SessionRow {
	return storage.openSession({
		name: "test-session",
		goal: "measure performance",
		primaryMetric: "ms",
		metricUnit: "ms",
		direction: "lower",
		preferredCommand: "bash autoresearch.sh",
		branch,
		baselineCommit: "abc1234",
		maxIterations: 10,
		scopePaths: [],
		offLimits: [],
		constraints: [],
		secondaryMetrics: [],
		breadth,
		attempts: 1,
		certify: false,
		armModels: [],
	});
}

interface ToolCase {
	name: string;
	execute: (options: AutoresearchToolFactoryOptions, ctx: ExtensionContext) => Promise<ToolResult<unknown>>;
	prepareValidSession?: (storage: AutoresearchStorage, session: SessionRow, dir: string) => Promise<void> | void;
	assertSuccess: (result: ToolResult<unknown>, storage: AutoresearchStorage, session: SessionRow) => void;
}

const TOOL_CASES: readonly ToolCase[] = [
	{
		name: "certify_arms",
		execute: (opts, ctx) =>
			createCertifyArmsTool(opts).execute(
				"call-certify",
				{
					arms: [
						{
							arm: "a0",
							hypothesis: "speedup",
							diff: "--- a/file.txt\n+++ b/file.txt\n+hello\n",
							modified_paths: ["file.txt"],
							metric: 42,
						},
					],
				},
				undefined,
				undefined,
				ctx,
			),
		assertSuccess: result => {
			const text = result.content.find(c => c.type === "text")?.text ?? "";
			expect(text).toContain("Triaged 1 arm: 1 surviving, 0 rejected.");
			expect(result.details).toMatchObject({ survivors: 1, rejected: 0, certifier: "director", winner: null });
		},
	},
	{
		name: "log_experiment",
		execute: (opts, ctx) =>
			createLogExperimentTool(opts).execute(
				"call-log",
				{ metric: 42, status: "keep", description: "baseline run" },
				undefined,
				undefined,
				ctx,
			),
		prepareValidSession: (storage, session, dir) => {
			const run = storage.insertRun({
				sessionId: session.id,
				segment: session.currentSegment,
				command: "bash autoresearch.sh",
				logPath: path.join(dir, ".veyyon", "autoresearch", "run.log"),
				preRunDirtyPaths: [],
				startedAt: Date.now(),
			});
			storage.markRunCompleted({
				runId: run.id,
				completedAt: Date.now(),
				durationMs: 100,
				exitCode: 0,
				timedOut: false,
				parsedPrimary: 42,
				parsedMetrics: { ms: 42 },
				parsedAsi: null,
			});
		},
		assertSuccess: (result, storage, session) => {
			const details = result.details as LogDetails;
			expect(details.experiment.metric).toBe(42);
			expect(details.experiment.status).toBe("keep");
			const logged = storage.listLoggedRuns(session.id);
			expect(logged).toHaveLength(1);
			expect(logged[0].parsedPrimary).toBe(42);
		},
	},
	{
		name: "run_experiment",
		execute: (opts, ctx) =>
			createRunExperimentTool(opts).execute("call-run", { timeout_seconds: 5 }, undefined, undefined, ctx),
		assertSuccess: (result, storage, session) => {
			const details = result.details as RunDetails;
			expect(details.parsedPrimary).toBe(42);
			expect(details.passed).toBe(true);
			const runs = storage.getRunsForSession(session.id);
			expect(runs).toHaveLength(1);
		},
	},
	{
		name: "start_arm",
		execute: (opts, ctx) =>
			createStartArmTool(opts).execute(
				"call-start-arm",
				{ arm: "a0", hypothesis: "initial arm" },
				undefined,
				undefined,
				ctx,
			),
		assertSuccess: result => {
			const text = result.content.find(c => c.type === "text")?.text ?? "";
			expect(text).toContain("a0 is in flight.");
			expect(result.details).toMatchObject({ arm: "a0", model: "the session model", switched: false });
		},
	},
	{
		name: "update_notes",
		execute: (opts, ctx) =>
			createUpdateNotesTool(opts).execute(
				"call-notes",
				{ append_idea: "caching strategy" },
				undefined,
				undefined,
				ctx,
			),
		assertSuccess: (result, storage, session) => {
			const text = result.content.find(c => c.type === "text")?.text ?? "";
			expect(text).toContain("Appended idea");
			const refreshed = storage.getSessionById(session.id);
			expect(refreshed?.notes).toContain("caching strategy");
		},
	},
];

let templateRepo: TempDir;
const scratchDirs: TempDir[] = [];

beforeAll(async () => {
	templateRepo = TempDir.createSync("@pi-test-branch-session-template-");
	const templateDir = templateRepo.path();
	await fs.promises.writeFile(path.join(templateDir, "README.md"), "# baseline\n");
	await fs.promises.writeFile(path.join(templateDir, "autoresearch.sh"), "#!/usr/bin/env bash\necho METRIC ms=42\n");
	const runGit = async (...args: string[]): Promise<void> => {
		await execFileAsync("git", args, { cwd: templateDir });
	};
	await runGit("init", "--initial-branch=main");
	await runGit("config", "core.autocrlf", "false");
	await runGit("config", "core.fsmonitor", "false");
	await runGit("config", "user.email", "64453045+santhreal@users.noreply.github.com");
	await runGit("config", "user.name", "santhreal");
	await runGit("add", "-A");
	await runGit("commit", "-m", "baseline");
	await runGit("checkout", "-b", "autoresearch/test-arm");
});

afterAll(async () => {
	closeAllAutoresearchStorages();
	for (const dir of scratchDirs) {
		await dir.remove();
	}
	await templateRepo.remove();
});

function freshRepo(): TempDir {
	const dir = TempDir.createSync("@pi-test-branch-session-");
	fs.cpSync(templateRepo.path(), dir.path(), { recursive: true });
	scratchDirs.push(dir);
	return dir;
}

describe("EXPERIMENT_TOOL_NAMES active-session requirement sweep", () => {
	it("pins init_experiment as the sole intentional opt-out from active branch session requirement", () => {
		expect(OPTED_OUT_TOOLS).toEqual(["init_experiment"]);
		const toolCaseNames = TOOL_CASES.map(tc => tc.name);
		expect([...SESSION_REQUIRING_TOOLS].sort()).toEqual([...toolCaseNames].sort());
		expect([...SESSION_REQUIRING_TOOLS, ...OPTED_OUT_TOOLS].sort()).toEqual([...EXPERIMENT_TOOL_NAMES].sort());
	});
});

describe("All 5 session-requiring tools across session resolution variants", () => {
	for (const toolCase of TOOL_CASES) {
		describe(`tool: ${toolCase.name}`, () => {
			it("returns missing-session error when storage DB does not exist", async () => {
				const emptyDir = TempDir.createSync("@pi-test-empty-");
				scratchDirs.push(emptyDir);
				const opts = createFactoryOptions();
				const ctx = createTestCtx(emptyDir.path());

				const result = await toolCase.execute(opts, ctx);
				expect(result.content).toEqual([{ type: "text", text: MISSING_SESSION_ERROR_TEXT }]);
			});

			it("returns missing-session error when on wrong branch", async () => {
				const repo = freshRepo();
				const storage = await openAutoresearchStorage(repo.path());
				openTestSession(storage, "autoresearch/unmatched-branch");

				const opts = createFactoryOptions();
				const ctx = createTestCtx(repo.path());

				const result = await toolCase.execute(opts, ctx);
				expect(result.content).toEqual([{ type: "text", text: MISSING_SESSION_ERROR_TEXT }]);
			});

			it("returns missing-session error when session on current branch is closed", async () => {
				const repo = freshRepo();
				const storage = await openAutoresearchStorage(repo.path());
				const session = openTestSession(storage, "autoresearch/test-arm");
				storage.closeSession(session.id);

				const opts = createFactoryOptions();
				const ctx = createTestCtx(repo.path());

				const result = await toolCase.execute(opts, ctx);
				expect(result.content).toEqual([{ type: "text", text: MISSING_SESSION_ERROR_TEXT }]);
			});

			it("returns missing-session error when HEAD is detached for a named session", async () => {
				const repo = freshRepo();
				const storage = await openAutoresearchStorage(repo.path());
				openTestSession(storage, "autoresearch/test-arm");
				await execFileAsync("git", ["checkout", "--detach", "HEAD"], { cwd: repo.path() });

				const opts = createFactoryOptions();
				const ctx = createTestCtx(repo.path());

				const result = await toolCase.execute(opts, ctx);
				expect(result.content).toEqual([{ type: "text", text: MISSING_SESSION_ERROR_TEXT }]);
			});

			it("proceeds with concrete success when active session matches current branch", async () => {
				const repo = freshRepo();
				const storage = await openAutoresearchStorage(repo.path());
				const session = openTestSession(storage, "autoresearch/test-arm", 2);
				if (toolCase.prepareValidSession) {
					await toolCase.prepareValidSession(storage, session, repo.path());
				}

				const opts = createFactoryOptions();
				const ctx = createTestCtx(repo.path());

				const result = await toolCase.execute(opts, ctx);
				toolCase.assertSuccess(result, storage, session);
			});

			it("proceeds with concrete success when active session and repo are both on null branch (detached)", async () => {
				const repo = freshRepo();
				await execFileAsync("git", ["checkout", "--detach", "HEAD"], { cwd: repo.path() });
				const storage = await openAutoresearchStorage(repo.path());
				const session = openTestSession(storage, null, 2);
				if (toolCase.prepareValidSession) {
					await toolCase.prepareValidSession(storage, session, repo.path());
				}

				const opts = createFactoryOptions();
				const ctx = createTestCtx(repo.path());

				const result = await toolCase.execute(opts, ctx);
				toolCase.assertSuccess(result, storage, session);
			});

			it("returns fresh payload objects so caller mutations do not corrupt subsequent error results", async () => {
				const repo = freshRepo();
				const opts = createFactoryOptions();
				const ctx = createTestCtx(repo.path());

				const res1 = await toolCase.execute(opts, ctx);
				expect(res1.content[0]).toEqual({ type: "text", text: MISSING_SESSION_ERROR_TEXT });
				res1.content[0] = { type: "text", text: "MUTATED_PAYLOAD" };

				const res2 = await toolCase.execute(opts, ctx);
				expect(res2.content[0]).toEqual({ type: "text", text: MISSING_SESSION_ERROR_TEXT });
			});

			it("propagates unexpected git resolution failures", async () => {
				const repo = freshRepo();
				vi.spyOn(git.branch, "current").mockRejectedValue(new Error("git resolution failed"));

				const opts = createFactoryOptions();
				const ctx = createTestCtx(repo.path());

				await expect(toolCase.execute(opts, ctx)).rejects.toThrow("git resolution failed");
			});
		});
	}
});
