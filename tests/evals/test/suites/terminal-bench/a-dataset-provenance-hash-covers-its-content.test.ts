import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	TERMINAL_BENCH_COMMIT_SHA,
	TERMINAL_BENCH_GIT_REMOTE,
	TERMINAL_BENCH_TAG,
} from "../../../suites/terminal-bench/dataset";
import { computeTaskSetContentHash, computeTerminalBenchProvenance } from "../../../suites/terminal-bench/provenance";

const FIXTURES_ROOT = resolve(import.meta.dirname, "fixtures");

describe("dataset provenance and content hashing", () => {
	test("computes complete provenance for fixture dataset", async () => {
		const provenance = await computeTerminalBenchProvenance({
			datasetRoot: FIXTURES_ROOT,
			commitSha: TERMINAL_BENCH_COMMIT_SHA,
			timestamp: "2026-08-25T12:00:00.000Z",
		});

		expect(provenance.suiteName).toBe("terminal-bench");
		expect(provenance.version).toBe(TERMINAL_BENCH_TAG);
		expect(provenance.gitRemote).toBe(TERMINAL_BENCH_GIT_REMOTE);
		expect(provenance.resolvedCommitSha).toBe(TERMINAL_BENCH_COMMIT_SHA);
		expect(provenance.taskCount).toBe(4);
		expect(provenance.selectedTasks).toEqual(["complex-task", "gpu-task", "no-network-task", "shared-verifier-task"]);
		expect(provenance.timestamp).toBe("2026-08-25T12:00:00.000Z");
		expect(typeof provenance.contentHash).toBe("string");
		expect(provenance.contentHash.length).toBe(64); // SHA-256 hex string
	});

	test("content hash is stable across multiple computations on identical dataset", async () => {
		const hash1 = await computeTaskSetContentHash(FIXTURES_ROOT, ["gpu-task", "no-network-task"]);
		const hash2 = await computeTaskSetContentHash(FIXTURES_ROOT, [
			"no-network-task",
			"gpu-task", // Order in input array should not matter due to sorting
		]);

		expect(hash1).toBe(hash2);
	});

	test("content hash differs when task selection changes", async () => {
		const provAll = await computeTerminalBenchProvenance({
			datasetRoot: FIXTURES_ROOT,
			commitSha: TERMINAL_BENCH_COMMIT_SHA,
		});

		const provSubset = await computeTerminalBenchProvenance({
			datasetRoot: FIXTURES_ROOT,
			selectedTasks: ["gpu-task", "no-network-task"],
			commitSha: TERMINAL_BENCH_COMMIT_SHA,
		});

		expect(provAll.taskCount).toBe(4);
		expect(provSubset.taskCount).toBe(2);
		expect(provAll.contentHash).not.toBe(provSubset.contentHash);
	});

	test("content hash changes when a task file changes", async () => {
		const tempDatasetRoot = resolve(FIXTURES_ROOT, "..", ".tmp-provenance-test");
		const tempTaskDir = join(tempDatasetRoot, "tasks", "test-task");

		try {
			await mkdir(tempTaskDir, { recursive: true });
			await writeFile(join(tempTaskDir, "task.toml"), 'schema_version = "1.4"\n[task]\nname = "test"');
			await writeFile(join(tempTaskDir, "instruction.md"), "Instruction version 1");

			const initialHash = await computeTaskSetContentHash(tempDatasetRoot, ["test-task"]);

			// Modify instruction.md
			await writeFile(join(tempTaskDir, "instruction.md"), "Instruction version 2 modified");
			const modifiedHash = await computeTaskSetContentHash(tempDatasetRoot, ["test-task"]);

			expect(initialHash).not.toBe(modifiedHash);
		} finally {
			await rm(tempDatasetRoot, { recursive: true, force: true });
		}
	});
});
