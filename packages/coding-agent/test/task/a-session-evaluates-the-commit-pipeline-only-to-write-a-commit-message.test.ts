/**
 * A session evaluates the commit pipeline only when an isolated agent's changes are committed with a
 * model-written message.
 *
 * WHY THIS SUITE EXISTS. `task/isolation-runner.ts` imported `generateCommitMessage` at the top of the
 * file, so every session with the task tool evaluated the commit message generator, the commit model
 * helper, the commit prompt table and its thirteen prompt bodies. That is 16 modules, 0.33 MiB of heap
 * and 5,400 live objects on an idle session, for a callback that runs only when
 * `agent.isolation.commits` is `ai` and an isolated agent's changes are merged.
 *
 * THE CLASS THIS CLOSES. Not "the isolation runner imported the generator" but "a first-party route
 * evaluates the commit pipeline before a commit message is requested". Every request the pipeline sends
 * is built from a module under `src/prompts/commit/`, so the probe reads a fresh process's module
 * registry for that directory at the choke points: once the session exists with the task tool active,
 * once every built-in and hidden tool factory has returned its tool, and once the isolation
 * commit-message callback of each style is built. A static import of the pipeline from a tool, the
 * isolation runner, or any module they reach turns the suite red whichever file holds it.
 *
 * The `ai` arm is the positive control and the contract the change keeps: the callback evaluates the
 * pipeline on its first call, sends the diff to the smol model, and returns the model's message. The
 * `generic` arm keeps returning no callback, so the caller writes its static message.
 *
 * WHAT IT DOES NOT CATCH. A route that reaches the pipeline after session creation from a tool's
 * `execute`, an event handler or a slash command, none of which the probe runs, and a pipeline module
 * that builds a request without a prompt under `src/prompts/commit/`. `commit/utils/` and
 * `commit/git-diff.ts` are shared text and diff helpers that image input, goals, eval and the git
 * utilities read, so they are not part of the pipeline this suite keeps out.
 */
import { afterAll, beforeAll, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { TempDir } from "@veyyon/utils";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const run = promisify(execFile);
const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "commit-pipeline-evaluation.ts");

interface CommitPipelineReport {
	taskActive: boolean;
	atCreate: string[];
	atEveryTool: string[];
	atCallback: string[];
	afterCommit: string[];
	generic: string;
	ai: string;
	message: string | null;
}

let scratch: TempDir;
let report: CommitPipelineReport;

beforeAll(async () => {
	scratch = TempDir.createSync("@veyyon-commit-pipeline-");
	const { env, cleanup } = hermeticSpawnEnv();
	try {
		const { stdout, stderr } = await run(process.execPath, [FIXTURE, scratch.path()], {
			env,
			timeout: 30_000,
			killSignal: "SIGKILL",
		});
		if (stderr !== "") throw new Error(`commit pipeline fixture wrote to stderr:\n${stderr}`);
		report = JSON.parse(stdout) as CommitPipelineReport;
	} finally {
		cleanup();
	}
}, 40_000);

afterAll(() => {
	scratch.removeSync();
});

it("creates a session with the task tool and evaluates no commit prompt", () => {
	expect(report.taskActive).toBe(true);
	expect(report.atCreate).toEqual([]);
});

it("builds every first-party tool and evaluates no commit prompt", () => {
	expect(report.atEveryTool).toEqual([]);
});

it("builds the isolation commit-message callback of each style and evaluates no commit prompt", () => {
	expect(report.generic).toBe("undefined");
	expect(report.ai).toBe("function");
	expect(report.atCallback).toEqual([]);
});

it("writes the commit message with the smol model on the callback's first call", () => {
	expect(report.message).toBe("fix the probe");
	expect(report.afterCommit).toContain("rows.ts");
	expect(report.afterCommit).toContain("message-system.md");
});
