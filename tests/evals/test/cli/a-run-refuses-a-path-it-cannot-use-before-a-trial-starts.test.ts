/**
 * WHY THIS SUITE EXISTS. Three directories decide whether a run can happen at all: the
 * runs directory it writes its journal into, the work directory trials execute in, and the
 * dataset directory a suite discovers tasks out of. None of the three was checked. A dry
 * run reported `ok` for a runs directory that was a regular file and for a work directory
 * that did not exist, and the real run then failed — one as an ENOTDIR out of `fs.mkdir`
 * after preflight had passed, the other as a backend spawning into nothing. A mistyped
 * `--dataset-dir` arrived as a raw `ENOENT: ... scandir ...` printed on the `harness`
 * verdict line, naming an axis that had nothing to do with it. `--tasks` had the same
 * shape of defect from the other direction: a task-list file that was not there was read
 * as a single task id, so the refusal named the suite's task count instead of the missing
 * file.
 *
 * THE CLASS: an input the run cannot use, accepted by the cheap path that was supposed to
 * prove the expensive one. Every role in `RUN_DIRECTORY_ROLES` is swept here, so a fourth
 * directory cannot be added without a covering case, and both paths to the verdict are
 * asserted: the dry run's `paths` line and the real run's refusal, which must also leave
 * the filesystem untouched. The ordering invariant is asserted at `executeRun`, whose
 * check has to land before any preflight and before the journal is opened.
 *
 * WHAT IT DOES NOT CATCH: whether a directory that exists holds a corpus a suite can read
 * — that is the suite's own preflight — and the wording of a suite-level refusal.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import type {
	EvalSuite,
	ExecutionBackend,
	PreflightVerdict,
	TaskDescriptor,
	TrialArtifacts,
	TrialScore,
} from "../../engine/contracts";
import { executeRun } from "../../engine/execute-run";
import { harnesses } from "../../engine/loaded-members";
import {
	checkRunDirectories,
	RUN_DIRECTORY_ROLES,
	type RunDirectoryRole,
	UnusableRunDirectoryError,
} from "../../engine/run-directories";
import { buildRunPlan } from "../../engine/run-plan";
import { main, TASK_LIST_EXTENSIONS } from "../../evals";

/** Captures what the CLI wrote to a stream, without letting it reach the terminal. */
function capture(stream: "stdout" | "stderr"): { text: () => string } {
	const chunks: string[] = [];
	const spy = spyOn(process[stream], "write").mockImplementation(chunk => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	});
	return { text: () => (spy.mock.calls.length === 0 ? "" : chunks.join("")) };
}

afterEach(() => {
	spyOn(process.stdout, "write").mockRestore();
	spyOn(process.stderr, "write").mockRestore();
});

const SUITE = "typescript-edit";
const MODEL = "anthropic/claude-sonnet-4-6";
const ONE_TASK = "access-remove-optional-chain-001";

/** The flag that carries each role, so a refusal can be provoked through the CLI. */
const FLAG_BY_ROLE: Record<RunDirectoryRole, string> = {
	"runs-dir": "--runs-dir",
	"work-dir": "--work-dir",
	"dataset-dir": "--dataset-dir",
};

/**
 * A case that made a directory unreadable or unwritable has to hand the bits back before
 * the temp directory is deleted, or the teardown fails instead of the assertion.
 */
async function releasePermissions(temp: TempDir, target: string): Promise<void> {
	for (const entry of [target, path.dirname(target)]) {
		if (!entry.startsWith(temp.path())) continue;
		try {
			const info = await fs.stat(entry);
			if (info.isDirectory()) await fs.chmod(entry, 0o700);
		} catch {
			// A case whose path never existed, or sits inside a regular file, has nothing to hand back.
		}
	}
	await temp.remove();
}

interface PathRefusal {
	readonly role: RunDirectoryRole;
	/** Names the mistake in the test title. */
	readonly what: string;
	/** Prepares the temp directory and returns the value the flag receives. */
	readonly setup: (temp: TempDir) => Promise<string>;
	/** The reason the message must state, verbatim. */
	readonly reason: string;
}

const REFUSALS: PathRefusal[] = [
	{
		role: "runs-dir",
		what: "a runs directory that is a regular file",
		setup: async temp => {
			const target = temp.join("runs-as-a-file");
			await fs.writeFile(target, "not a directory\n");
			return target;
		},
		reason: "is not a directory",
	},
	{
		role: "runs-dir",
		what: "a runs directory inside a regular file",
		setup: async temp => {
			const file = temp.join("blocking-file");
			await fs.writeFile(file, "not a directory\n");
			return path.join(file, "runs", "deeper");
		},
		reason: "cannot be created:",
	},
	{
		role: "runs-dir",
		what: "a runs directory that cannot be written to",
		setup: async temp => {
			const target = temp.join("read-only-runs");
			await fs.mkdir(target);
			await fs.chmod(target, 0o500);
			return target;
		},
		reason: "is not writable",
	},
	{
		role: "runs-dir",
		what: "a runs directory whose parent cannot be written to",
		setup: async temp => {
			const parent = temp.join("read-only-parent");
			await fs.mkdir(parent);
			await fs.chmod(parent, 0o500);
			return path.join(parent, "runs");
		},
		reason: "is not writable",
	},
	{
		role: "work-dir",
		what: "a work directory that does not exist",
		setup: async temp => path.join(temp.path(), "absent-work-dir"),
		reason: "does not exist",
	},
	{
		role: "work-dir",
		what: "a work directory that is a regular file",
		setup: async temp => {
			const target = temp.join("work-as-a-file");
			await fs.writeFile(target, "not a directory\n");
			return target;
		},
		reason: "is not a directory",
	},
	{
		role: "work-dir",
		what: "a work directory that cannot be read",
		setup: async temp => {
			const target = temp.join("unreadable-work");
			await fs.mkdir(target);
			await fs.chmod(target, 0o000);
			return target;
		},
		reason: "is not readable",
	},
	{
		role: "dataset-dir",
		what: "a dataset directory that does not exist",
		setup: async temp => path.join(temp.path(), "absent-dataset"),
		reason: "does not exist",
	},
	{
		role: "dataset-dir",
		what: "a dataset directory that cannot be read",
		setup: async temp => {
			const target = temp.join("unreadable-dataset");
			await fs.mkdir(target);
			await fs.chmod(target, 0o000);
			return target;
		},
		reason: "is not readable",
	},
];

describe("the directories a run reaches", () => {
	it("has a covering refusal for every role a run can be handed", () => {
		const covered = new Set(REFUSALS.map(refusal => refusal.role));
		expect([...covered].sort()).toEqual([...RUN_DIRECTORY_ROLES].sort());
	});

	it.each(REFUSALS)("names $what by role and reason", async ({ role, setup, reason }) => {
		const temp = await TempDir.create("@evals-test-run-dirs-");
		let target = temp.path();
		try {
			target = await setup(temp);
			const problems = await checkRunDirectories({
				runsDir: role === "runs-dir" ? target : temp.join("runs"),
				workDir: role === "work-dir" ? target : temp.path(),
				datasetDir: role === "dataset-dir" ? target : undefined,
			});

			expect(problems.length).toBe(1);
			const problem = problems[0] as UnusableRunDirectoryError;
			expect(problem).toBeInstanceOf(UnusableRunDirectoryError);
			expect(problem.role).toBe(role);
			expect(problem.directory).toBe(target);
			expect(problem.message).toContain(reason);
			expect(problem.message.startsWith(`${role} `)).toBe(true);
		} finally {
			await releasePermissions(temp, target);
		}
	});

	it("accepts a runs directory that has to be created, and a dataset archive that is a file", async () => {
		const temp = await TempDir.create("@evals-test-run-dirs-ok-");
		try {
			const archive = temp.join("fixtures.tar.gz");
			await fs.writeFile(archive, "");
			const problems = await checkRunDirectories({
				runsDir: path.join(temp.path(), "runs", "nested", "deeper"),
				workDir: temp.path(),
				datasetDir: archive,
			});

			expect(problems).toEqual([]);
		} finally {
			await temp.remove();
		}
	});

	it("states every unusable directory at once instead of one per attempt", async () => {
		const temp = await TempDir.create("@evals-test-run-dirs-all-");
		try {
			const runsFile = temp.join("runs-as-a-file");
			await fs.writeFile(runsFile, "");
			const problems = await checkRunDirectories({
				runsDir: runsFile,
				workDir: path.join(temp.path(), "absent-work"),
				datasetDir: path.join(temp.path(), "absent-dataset"),
			});

			expect(problems.map(problem => problem.role)).toEqual(["runs-dir", "work-dir", "dataset-dir"]);
		} finally {
			await temp.remove();
		}
	});
});

describe("a dry run", () => {
	it.each(REFUSALS)("refuses $what and earns exit 1", async ({ role, setup, reason }) => {
		const temp = await TempDir.create("@evals-test-dryrun-dirs-");
		let target = temp.path();
		try {
			target = await setup(temp);
			const stdout = capture("stdout");

			const code = await main(["--suite", SUITE, "--model", MODEL, FLAG_BY_ROLE[role], target, "--dry-run"]);

			expect(code).toBe(1);
			expect(stdout.text()).toContain("paths      REFUSED");
			expect(stdout.text()).toContain(reason);
			expect(stdout.text()).not.toContain("DRY RUN — nothing was executed.");
		} finally {
			await releasePermissions(temp, target);
		}
	});

	it("states paths ok beside the other verdicts when every directory is usable", async () => {
		const temp = await TempDir.create("@evals-test-dryrun-dirs-ok-");
		try {
			const stdout = capture("stdout");

			const code = await main([
				"--suite",
				SUITE,
				"--model",
				MODEL,
				"--runs-dir",
				path.join(temp.path(), "runs"),
				"--work-dir",
				temp.path(),
				"--dry-run",
			]);

			expect(code).toBe(0);
			expect(stdout.text()).toContain("paths      ok");
			expect(stdout.text()).toContain("DRY RUN — nothing was executed.");
		} finally {
			await temp.remove();
		}
	});
});

describe("a real run", () => {
	it.each(REFUSALS)("refuses $what without creating anything", async ({ role, setup, reason }) => {
		const temp = await TempDir.create("@evals-test-run-dirs-real-");
		let target = temp.path();
		try {
			target = await setup(temp);
			const runsDir = role === "runs-dir" ? target : path.join(temp.path(), "runs");
			const stderr = capture("stderr");
			const stdout = capture("stdout");

			const code = await main([
				"--suite",
				SUITE,
				"--model",
				MODEL,
				"--tasks",
				ONE_TASK,
				"--runs-dir",
				runsDir,
				FLAG_BY_ROLE[role],
				target,
			]);

			expect(code).toBe(1);
			expect(stderr.text()).toContain(reason);
			expect(stderr.text().startsWith(`${role} `)).toBe(true);
			expect(stdout.text()).not.toContain("trial(s),");
			if (role !== "runs-dir") {
				await expect(fs.stat(runsDir)).rejects.toThrow();
			}
		} finally {
			await releasePermissions(temp, target);
		}
	});
});

/** A backend that records whether it was ever asked anything. */
function recordingBackend(seen: string[]): ExecutionBackend {
	return {
		id: "in-process",
		appliesVariantAxes: [],
		async preflight(): Promise<PreflightVerdict> {
			seen.push("backend.preflight");
			return { ok: true };
		},
		async prepare(): Promise<void> {
			seen.push("backend.prepare");
		},
		async runTrial(): Promise<TrialArtifacts> {
			seen.push("backend.runTrial");
			throw new Error("no trial should ever start");
		},
		async cleanup(): Promise<void> {
			seen.push("backend.cleanup");
		},
	};
}

describe("executeRun", () => {
	it("refuses an unusable directory before it preflights or opens a journal", async () => {
		const temp = await TempDir.create("@evals-test-execute-dirs-");
		try {
			const runsFile = temp.join("runs-as-a-file");
			await fs.writeFile(runsFile, "");
			const seen: string[] = [];
			const suite: EvalSuite = {
				id: "recording",
				version: "1.0.0",
				displayName: "Recording",
				description: "a suite that records whether its preflight ran",
				backend: "in-process",
				async discoverTasks(): Promise<readonly string[]> {
					return ["only-task"];
				},
				async describeTask(taskId: string): Promise<TaskDescriptor> {
					return { id: taskId, path: null, timeBudgetSec: 1, instructionPath: null, metadata: {} };
				},
				async scoreTrial(): Promise<TrialScore> {
					seen.push("suite.scoreTrial");
					return { reward: null, partial: null, error: null, usage: null, extra: {} };
				},
				async preflight(): Promise<PreflightVerdict> {
					seen.push("suite.preflight");
					return { ok: true };
				},
				async provenance() {
					return { suite: "recording", version: "1.0.0" };
				},
			};
			const plan = await buildRunPlan({
				suite,
				harnesses,
				selection: { harnesses: ["veyyon"], models: [MODEL] },
				context: { workDir: temp.path() },
			});

			await expect(
				executeRun({ plan, harnesses, backend: recordingBackend(seen), workDir: temp.path(), runsDir: runsFile }),
			).rejects.toThrow(UnusableRunDirectoryError);
			expect(seen).toEqual([]);
			expect((await fs.stat(runsFile)).isFile()).toBe(true);
		} finally {
			await temp.remove();
		}
	});
});

describe("--tasks", () => {
	it("refuses a task-list file that is not there, by path, with a usage exit code", async () => {
		const temp = await TempDir.create("@evals-test-task-list-");
		try {
			const absent = temp.join("smoke.txt");
			const stderr = capture("stderr");

			const code = await main(["--suite", SUITE, "--model", MODEL, "--tasks", absent, "--dry-run"]);

			expect(code).toBe(2);
			expect(stderr.text()).toContain("--tasks names a task-list file that cannot be read");
			expect(stderr.text()).toContain(absent);
		} finally {
			await temp.remove();
		}
	});

	it("refuses a value shaped like a path even without a task-list extension", async () => {
		const stderr = capture("stderr");

		const code = await main(["--suite", SUITE, "--model", MODEL, "--tasks", "lists/smoke", "--dry-run"]);

		expect(code).toBe(2);
		expect(stderr.text()).toContain("--tasks names a task-list file that cannot be read");
		expect(stderr.text()).toContain("lists/smoke");
	});

	it.each([...TASK_LIST_EXTENSIONS])("refuses a bare %s filename that is not there", async extension => {
		const stderr = capture("stderr");

		const code = await main(["--suite", SUITE, "--model", MODEL, "--tasks", `absent-list${extension}`, "--dry-run"]);

		expect(code).toBe(2);
		expect(stderr.text()).toContain("--tasks names a task-list file that cannot be read");
		expect(stderr.text()).toContain(`absent-list${extension}`);
	});

	it("still reads a value that is not shaped like a path as a task id", async () => {
		const stdout = capture("stdout");

		const code = await main(["--suite", SUITE, "--model", MODEL, "--tasks", "no-such-task", "--dry-run"]);

		expect(code).toBe(1);
		expect(stdout.text()).toContain("does not hold 1 requested task(s): no-such-task");
	});

	it("refuses a task-list file mixed with inline ids", async () => {
		const temp = await TempDir.create("@evals-test-task-list-mixed-");
		try {
			const list = temp.join("ids.txt");
			await fs.writeFile(list, `${ONE_TASK}\n`);
			const stderr = capture("stderr");

			const code = await main(["--suite", SUITE, "--model", MODEL, "--tasks", `${list},${ONE_TASK}`, "--dry-run"]);

			expect(code).toBe(2);
			expect(stderr.text()).toContain("--tasks takes either one task-list file or a list of ids");
		} finally {
			await temp.remove();
		}
	});

	it("reads the ids out of a task-list file that is there", async () => {
		const temp = await TempDir.create("@evals-test-task-list-ok-");
		try {
			const list = temp.join("ids.txt");
			await fs.writeFile(list, `# two ids\n${ONE_TASK}\naccess-remove-optional-chain-002\n`);
			const stdout = capture("stdout");

			const code = await main(["--suite", SUITE, "--model", MODEL, "--tasks", list, "--dry-run"]);

			expect(code).toBe(0);
			expect(stdout.text()).toContain("tasks      2");
			expect(stdout.text()).toContain("DRY RUN — nothing was executed.");
		} finally {
			await temp.remove();
		}
	});
});
