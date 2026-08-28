import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
	acquireTerminalBenchDataset,
	discoverTerminalBenchTasks,
	getTerminalBenchTaskConfigPath,
	getTerminalBenchTaskDir,
	getTerminalBenchTaskInstructionPath,
	TERMINAL_BENCH_COMMIT_SHA,
	TERMINAL_BENCH_GIT_REMOTE,
	TERMINAL_BENCH_TAG,
} from "../../../suites/terminal-bench/dataset";

const FIXTURES_ROOT = resolve(import.meta.dirname, "fixtures");

describe("dataset discovery and pinning", () => {
	test("discovers all tasks under fixtures in sorted order", async () => {
		const tasks = await discoverTerminalBenchTasks(FIXTURES_ROOT);

		expect(tasks).toEqual(["complex-task", "gpu-task", "no-network-task", "shared-verifier-task"]);
	});

	test("resolves correct task and config paths", () => {
		const taskDir = getTerminalBenchTaskDir(FIXTURES_ROOT, "gpu-task");
		expect(taskDir).toBe(join(FIXTURES_ROOT, "tasks", "gpu-task"));

		const configPath = getTerminalBenchTaskConfigPath(FIXTURES_ROOT, "gpu-task");
		expect(configPath).toBe(join(FIXTURES_ROOT, "tasks", "gpu-task", "task.toml"));

		const instructionPath = getTerminalBenchTaskInstructionPath(FIXTURES_ROOT, "gpu-task");
		expect(instructionPath).toBe(join(FIXTURES_ROOT, "tasks", "gpu-task", "instruction.md"));
	});

	test("verifies existing cache when commit SHA matches", async () => {
		const calls: string[][] = [];
		const mockGit = async (args: readonly string[], _cwd?: string): Promise<string> => {
			calls.push([...args]);
			if (args[0] === "rev-parse" && args[1] === "HEAD") {
				return TERMINAL_BENCH_COMMIT_SHA;
			}
			return "";
		};

		const acquired = await acquireTerminalBenchDataset({
			cacheDir: FIXTURES_ROOT,
			git: mockGit,
		});

		expect(acquired).toBe(FIXTURES_ROOT);
		expect(calls).toEqual([["rev-parse", "HEAD"]]);
	});

	test("refuses loudly when existing cache commit SHA does not match pin", async () => {
		const wrongSha = "1111111111111111111111111111111111111111";
		const mockGit = async (args: readonly string[]): Promise<string> => {
			if (args[0] === "rev-parse") {
				return wrongSha;
			}
			return "";
		};

		await expect(
			acquireTerminalBenchDataset({
				cacheDir: FIXTURES_ROOT,
				git: mockGit,
			}),
		).rejects.toThrow(/resolved to commit "1111111111111111111111111111111111111111", expected pinned commit/);
	});

	test("clones and verifies pin when destination does not exist", async () => {
		const targetDir = "/nonexistent/test/path/datasets/tb-test";
		const executedCommands: { args: readonly string[]; cwd?: string }[] = [];

		const mockGit = async (args: readonly string[], cwd?: string): Promise<string> => {
			executedCommands.push({ args, cwd });
			if (args[0] === "rev-parse") {
				return TERMINAL_BENCH_COMMIT_SHA;
			}
			return "";
		};

		const acquired = await acquireTerminalBenchDataset({
			cacheDir: targetDir,
			git: mockGit,
		});

		expect(acquired).toBe(targetDir);
		expect(executedCommands.length).toBe(2);
		expect(executedCommands[0]?.args).toEqual([
			"clone",
			"--depth",
			"1",
			"--branch",
			TERMINAL_BENCH_TAG,
			TERMINAL_BENCH_GIT_REMOTE,
			targetDir,
		]);
		expect(executedCommands[1]?.args).toEqual(["rev-parse", "HEAD"]);
		expect(executedCommands[1]?.cwd).toBe(targetDir);
	});

	test("refuses acquisition when freshly cloned repository has wrong commit SHA", async () => {
		const targetDir = "/nonexistent/test/path/datasets/tb-bad-clone";
		const mockGit = async (args: readonly string[]): Promise<string> => {
			if (args[0] === "rev-parse") {
				return "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
			}
			return "";
		};

		await expect(
			acquireTerminalBenchDataset({
				cacheDir: targetDir,
				git: mockGit,
			}),
		).rejects.toThrow(/resolved to commit "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", expected pinned commit/);
	});
});
