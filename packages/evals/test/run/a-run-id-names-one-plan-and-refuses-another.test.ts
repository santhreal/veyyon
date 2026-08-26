/**
 * WHY THIS SUITE EXISTS. A settled trial is matched by `cellKey`: suite, task, variant name
 * and repeat. The variant name carries the model only when a run varies more than one, and
 * it carries an overlay by basename rather than by path. So `--model a --run-id r` followed
 * by `--resume --model b --run-id r` produced identical keys: every trial run against model
 * a was skipped as settled, and the record reported model b's arm with model a's numbers. A
 * rerun that passed no `--resume` at all appended to the journal already on disk, so one run
 * id held trials from two plans and `readRunJournal` returned both as one run.
 *
 * THE CLASS: two different plans sharing a journal because the key that identifies a trial
 * cannot see what differs between them. The digest covers every field a cell key drops —
 * suite version, dataset sha, backend, and each variant's harness, overlay paths, model and
 * attachments — and each is swept here rather than the one reported. The fields deliberately
 * left out (task selection and repeat count) are asserted to be out, since narrowing a task
 * list or asking for more repeats is the same plan reaching fewer or more cells. Both seams
 * are covered: `executeRun`, whose refusal has to land before a preflight, and
 * `openRunJournal`, which is the call that would write the mismatched line.
 *
 * WHAT IT DOES NOT CATCH: a plan whose difference is invisible to the digest because two
 * distinct overlay files hold the same path (they cannot), and a journal a concurrent
 * process appends to between the check and the open.
 */

import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { main } from "../../src/cli";
import type {
	EvalSuite,
	ExecutionBackend,
	PreflightVerdict,
	TaskDescriptor,
	TrialArtifacts,
	TrialCell,
	TrialScore,
	Variant,
	VariantAxis,
} from "../../src/core";
import { registerBuiltinHarnesses } from "../../src/harnesses";
import { executeRun } from "../../src/run/execute";
import {
	journalPathFor,
	openRunJournal,
	RUN_JOURNAL_VERSION,
	readRunJournal,
	StaleRunJournalError,
} from "../../src/run/journal";
import { buildRunPlan, type RunPlan } from "../../src/run/plan";
import { PlanChangedError, planIdentity } from "../../src/run/plan-identity";

registerBuiltinHarnesses();

const MODEL_A = "anthropic/claude-sonnet-4-5";
const MODEL_B = "anthropic/claude-opus-4-1";

/** A suite whose identity fields a case can vary one at a time. */
interface SuiteShape {
	readonly name?: string;
	readonly version?: string;
	readonly sha?: string | null;
	readonly backend?: string;
	readonly tasks?: readonly string[];
}

function suiteOf(shape: SuiteShape = {}): EvalSuite {
	const tasks = shape.tasks ?? ["t1", "t2"];
	return {
		name: shape.name ?? "plan-identity",
		version: shape.version ?? "1.0.0",
		displayName: "Plan Identity",
		description: "a suite whose identity fields one case varies at a time",
		backend: shape.backend ?? "in-process",
		async discoverTasks(): Promise<readonly string[]> {
			return tasks;
		},
		async describeTask(taskId: string): Promise<TaskDescriptor> {
			return { id: taskId, path: null, timeBudgetSec: 1, instructionPath: null, metadata: {} };
		},
		async scoreTrial(): Promise<TrialScore> {
			return { reward: 1, partial: null, error: null, usage: null, extra: {} };
		},
		async preflight(): Promise<PreflightVerdict> {
			return { ok: true };
		},
		async provenance() {
			return { suite: shape.name ?? "plan-identity", version: shape.version ?? "1.0.0", sha: shape.sha ?? null };
		},
	};
}

interface PlanShape extends SuiteShape {
	readonly models?: readonly string[];
	readonly configs?: readonly string[];
	readonly promptVariants?: readonly string[];
	readonly attachments?: readonly string[];
	readonly repeats?: number;
	readonly taskIds?: readonly string[];
}

async function planOf(workDir: string, shape: PlanShape = {}): Promise<RunPlan> {
	return await buildRunPlan({
		suite: suiteOf(shape),
		selection: {
			harnesses: ["veyyon"],
			models: shape.models ?? [MODEL_A],
			configs: shape.configs,
			promptVariants: shape.promptVariants,
			attachments: shape.attachments,
		},
		tasks: shape.taskIds,
		repeats: shape.repeats,
		context: { workDir },
		runId: "one-run-id",
	});
}

/** A backend that applies every axis, so an axis check never precedes the plan check. */
const EVERY_AXIS: VariantAxis[] = ["config", "promptVariant", "attachments"];

function passingBackend(started: TrialCell[]): ExecutionBackend {
	return {
		id: "in-process",
		appliesVariantAxes: EVERY_AXIS,
		async preflight(): Promise<PreflightVerdict> {
			return { ok: true };
		},
		async prepare(): Promise<void> {},
		async runTrial(cell: TrialCell): Promise<TrialArtifacts> {
			started.push(cell);
			return { trialDir: "/dev/null", logPaths: [] };
		},
		async cleanup(): Promise<void> {},
	};
}

/** A backend that records whether it was ever asked anything. */
function recordingBackend(seen: string[]): ExecutionBackend {
	return {
		id: "in-process",
		appliesVariantAxes: EVERY_AXIS,
		async preflight(): Promise<PreflightVerdict> {
			seen.push("backend.preflight");
			return { ok: true };
		},
		async prepare(): Promise<void> {
			seen.push("backend.prepare");
		},
		async runTrial(): Promise<TrialArtifacts> {
			seen.push("backend.runTrial");
			throw new Error("no trial should start under a changed plan");
		},
		async cleanup(): Promise<void> {
			seen.push("backend.cleanup");
		},
	};
}

/** Every field the digest must answer to, each varied one at a time. */
const CHANGES: { what: string; shape: PlanShape }[] = [
	{ what: "the model of a single-model run", shape: { models: [MODEL_B] } },
	{ what: "one model of a multi-model run", shape: { models: [MODEL_A, MODEL_B] } },
	{ what: "the suite version", shape: { version: "2.0.0" } },
	{ what: "the dataset sha", shape: { sha: "deadbeef" } },
	{ what: "the suite name", shape: { name: "another-suite" } },
	{ what: "a config overlay", shape: { configs: ["/overlays/a.yml"] } },
	{ what: "which directory an overlay of the same name came from", shape: { configs: ["/elsewhere/a.yml"] } },
	{ what: "a prompt overlay", shape: { promptVariants: ["/overlays/p.json"] } },
	{ what: "an arm attachment", shape: { attachments: ["prompt/extra.prompt.md"] } },
];

/** What a run id is allowed to change and still resume: which cells the plan reaches. */
const SAME_PLAN: { what: string; shape: PlanShape }[] = [
	{ what: "a narrowed task list", shape: { taskIds: ["t1"] } },
	{ what: "more repeats", shape: { repeats: 2 } },
];

describe("planIdentity", () => {
	it("is stable for the same plan and independent of matrix order", async () => {
		const temp = await TempDir.create("@evals-test-plan-identity-");
		try {
			const first = planIdentity(await planOf(temp.path(), { models: [MODEL_A, MODEL_B] }));
			const second = planIdentity(await planOf(temp.path(), { models: [MODEL_B, MODEL_A] }));
			expect(first).toBe(second);
			expect(first).toMatch(/^[0-9a-f]{16}$/);
		} finally {
			await temp.remove();
		}
	});

	it.each(CHANGES)("changes when $what changes", async ({ shape }) => {
		const temp = await TempDir.create("@evals-test-plan-identity-change-");
		try {
			const base = planIdentity(await planOf(temp.path()));
			expect(planIdentity(await planOf(temp.path(), shape))).not.toBe(base);
		} finally {
			await temp.remove();
		}
	});

	it.each(SAME_PLAN)("stays the same for $what, which is the same plan", async ({ shape }) => {
		const temp = await TempDir.create("@evals-test-plan-identity-same-");
		try {
			const base = planIdentity(await planOf(temp.path()));
			expect(planIdentity(await planOf(temp.path(), shape))).toBe(base);
		} finally {
			await temp.remove();
		}
	});

	it("distinguishes two variants whose overlays differ only by directory", async () => {
		const temp = await TempDir.create("@evals-test-plan-identity-dirs-");
		try {
			const left = await planOf(temp.path(), { configs: ["/one/a.yml"] });
			const right = await planOf(temp.path(), { configs: ["/two/a.yml"] });
			// The defect this rules out: both variants are named `a`, so every cell key matches.
			expect(left.variants.map((v: Variant) => v.name)).toEqual(right.variants.map((v: Variant) => v.name));
			expect(planIdentity(left)).not.toBe(planIdentity(right));
		} finally {
			await temp.remove();
		}
	});
});

describe("openRunJournal", () => {
	it("records the plan in the header it writes", async () => {
		const temp = await TempDir.create("@evals-test-plan-header-");
		try {
			const plan = await planOf(temp.path());
			const digest = planIdentity(plan);
			const journal = await openRunJournal(temp.path(), plan.runId, digest);
			await journal.close();
			const header = JSON.parse((await fs.readFile(journal.path, "utf-8")).split("\n")[0] as string) as {
				plan: string;
				version: number;
			};
			expect(header.plan).toBe(digest);
			expect(header.version).toBe(RUN_JOURNAL_VERSION);
		} finally {
			await temp.remove();
		}
	});

	it.each(CHANGES)("refuses to append to a journal written for a plan differing in $what", async ({ shape }) => {
		const temp = await TempDir.create("@evals-test-plan-append-");
		try {
			const first = await planOf(temp.path());
			const opened = await openRunJournal(temp.path(), first.runId, planIdentity(first));
			await opened.close();

			const second = await planOf(temp.path(), shape);
			await expect(openRunJournal(temp.path(), second.runId, planIdentity(second))).rejects.toThrow(
				PlanChangedError,
			);
		} finally {
			await temp.remove();
		}
	});

	it("refuses a journal whose header states no plan at all", async () => {
		const temp = await TempDir.create("@evals-test-plan-unstated-");
		try {
			const plan = await planOf(temp.path());
			const journalPath = journalPathFor(temp.path(), plan.runId);
			await fs.mkdir(path.dirname(journalPath), { recursive: true });
			await fs.writeFile(
				journalPath,
				`${JSON.stringify({ journal: "veyyon-evals-trials", version: RUN_JOURNAL_VERSION, runId: plan.runId })}\n`,
			);
			const failure = openRunJournal(temp.path(), plan.runId, planIdentity(plan));
			await expect(failure).rejects.toThrow(PlanChangedError);
			await expect(failure).rejects.toThrow("an unstated plan");
		} finally {
			await temp.remove();
		}
	});

	it("refuses a journal written before a plan digest existed, by the version it states", async () => {
		const temp = await TempDir.create("@evals-test-plan-v1-");
		try {
			// The shape that carried no plan digest is version 1 literally, not
			// `RUN_JOURNAL_VERSION - 1`: reverting the bump would make a plan-less journal current
			// and turn this refusal into a comparison against a header that states nothing.
			expect(RUN_JOURNAL_VERSION).toBeGreaterThan(1);
			const plan = await planOf(temp.path());
			const journalPath = journalPathFor(temp.path(), plan.runId);
			await fs.mkdir(path.dirname(journalPath), { recursive: true });
			await fs.writeFile(
				journalPath,
				`${JSON.stringify({ journal: "veyyon-evals-trials", version: 1, runId: plan.runId })}\n`,
			);
			await expect(openRunJournal(temp.path(), plan.runId, planIdentity(plan))).rejects.toThrow(
				StaleRunJournalError,
			);
		} finally {
			await temp.remove();
		}
	});

	it("appends to its own journal, so a resume of the same plan is not refused", async () => {
		const temp = await TempDir.create("@evals-test-plan-same-");
		try {
			const plan = await planOf(temp.path());
			const digest = planIdentity(plan);
			const first = await openRunJournal(temp.path(), plan.runId, digest);
			await first.close();
			const second = await openRunJournal(temp.path(), plan.runId, digest);
			await second.close();
			expect(await readRunJournal(temp.path(), plan.runId)).toEqual([]);
		} finally {
			await temp.remove();
		}
	});
});

describe("executeRun", () => {
	it.each(CHANGES)("refuses a journal of another plan differing in $what, before preflight", async ({ shape }) => {
		const temp = await TempDir.create("@evals-test-plan-execute-");
		try {
			const first = await planOf(temp.path());
			await executeRun({
				plan: first,
				backend: passingBackend([]),
				workDir: temp.path(),
				runsDir: temp.path(),
			});

			const seen: string[] = [];
			const second = await planOf(temp.path(), shape);
			await expect(
				executeRun({ plan: second, backend: recordingBackend(seen), workDir: temp.path(), runsDir: temp.path() }),
			).rejects.toThrow(PlanChangedError);
			expect(seen).toEqual([]);
		} finally {
			await temp.remove();
		}
	});

	it("keeps a resumed run of the same plan skipping only what settled", async () => {
		const temp = await TempDir.create("@evals-test-plan-resume-");
		try {
			const plan = await planOf(temp.path());
			const first: TrialCell[] = [];
			await executeRun({ plan, backend: passingBackend(first), workDir: temp.path(), runsDir: temp.path() });
			expect(first.length).toBe(plan.cells.length);

			const second: TrialCell[] = [];
			await executeRun({
				plan,
				backend: passingBackend(second),
				workDir: temp.path(),
				runsDir: temp.path(),
				resume: true,
			});
			expect(second).toEqual([]);
		} finally {
			await temp.remove();
		}
	});

	it("does not silently merge a second plan's trials into one record", async () => {
		const temp = await TempDir.create("@evals-test-plan-merge-");
		try {
			const first = await planOf(temp.path());
			await executeRun({ plan: first, backend: passingBackend([]), workDir: temp.path(), runsDir: temp.path() });
			const settled = await readRunJournal(temp.path(), first.runId);

			const second = await planOf(temp.path(), { models: [MODEL_B] });
			await executeRun({
				plan: second,
				backend: passingBackend([]),
				workDir: temp.path(),
				runsDir: temp.path(),
			}).catch(() => {});

			// The journal holds what the first plan settled and nothing the second wrote.
			expect(await readRunJournal(temp.path(), first.runId)).toEqual(settled);
		} finally {
			await temp.remove();
		}
	});
});

/** Captures what the CLI wrote to a stream, without letting it reach the terminal. */
function capture(stream: "stdout" | "stderr"): { text: () => string } {
	const chunks: string[] = [];
	spyOn(process[stream], "write").mockImplementation(chunk => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	});
	return { text: () => chunks.join("") };
}

describe("the CLI", () => {
	it("states a run refusal on one line and returns 1, rather than an unhandled rejection", async () => {
		const temp = await TempDir.create("@evals-test-plan-cli-");
		const stdout = capture("stdout");
		const stderr = capture("stderr");
		try {
			const journalPath = journalPathFor(temp.path(), "smoke-id");
			await fs.mkdir(path.dirname(journalPath), { recursive: true });
			await fs.writeFile(
				journalPath,
				`${JSON.stringify({
					journal: "veyyon-evals-trials",
					version: RUN_JOURNAL_VERSION,
					runId: "smoke-id",
					plan: "0000000000000000",
				})}\n`,
			);

			const code = await main([
				"--suite",
				"typescript-edit",
				"--tasks",
				"access-remove-optional-chain-001",
				"--model",
				MODEL_A,
				"--run-id",
				"smoke-id",
				"--runs-dir",
				temp.path(),
			]);

			expect(code).toBe(1);
			const written = stderr.text();
			expect(written).toContain("belongs to plan 0000000000000000");
			expect(written).toContain("A run id names one plan");
			// One line, not a stack: the frames are for the log file, not the terminal.
			expect(written.trim().split("\n")).toHaveLength(1);
			expect(written).not.toContain("at async");
			expect(stdout.text()).not.toContain("trial(s), ");
		} finally {
			spyOn(process.stdout, "write").mockRestore();
			spyOn(process.stderr, "write").mockRestore();
			await temp.remove();
		}
	});
});
