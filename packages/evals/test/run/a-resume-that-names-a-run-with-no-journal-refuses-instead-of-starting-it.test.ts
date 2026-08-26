/**
 * WHY: `--resume` read the run's `trials.jsonl` through a query that answers "no records"
 * for a file that is not there, so `--run-id` with a typo in it resumed nothing, skipped
 * nothing, and queued every task in the suite as a fresh run — under a name the operator
 * believed was already half settled. The dry run said nothing about resume at all, so the
 * plan it printed for that invocation looked correct.
 *
 * Worse, the existence of the journal could not be checked after `openRunJournal`, which
 * creates the file: a check placed there always found the journal it had just written.
 *
 * The class this closes: a resume that silently degrades into a first run. `executeRun`
 * refuses before any preflight, staging or container spend, and the dry run states the same
 * verdict from the same two seams (`journalExists` + `readRunJournal`), so the two paths
 * cannot disagree. A journal that exists and holds no settled trial stays resumable, which
 * is the boundary the refusal must not swallow: a run interrupted before its first trial.
 *
 * What it does not catch: whether a settled trial read back from a journal is matched to
 * the right cell (`cellKey`'s own suite), and a journal whose header this build rejects,
 * which StaleRunJournalError's suite covers.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { registerAllBackends } from "../../src/backends";
import { describeResume } from "../../src/cli";
import { requireBackend, requireSuite, type SuiteContext } from "../../src/core";
import { registerBuiltinHarnesses } from "../../src/harnesses";
import {
	buildRunPlan,
	executeRun,
	journalExists,
	journalPathFor,
	openRunJournal,
	ResumeWithoutJournalError,
	RUN_JOURNAL_KIND,
	RUN_JOURNAL_VERSION,
} from "../../src/run";
import { registerAllSuites } from "../../src/suites";

/** Any journal these cases open belongs to one plan; the digest itself is not the subject. */
const PLAN_DIGEST = "0123456789abcdef";

// The registries are process-wide, and a chunk of the test bucket may hold no other file
// that populates them.
registerAllSuites();
registerAllBackends();
registerBuiltinHarnesses();

const temps: TempDir[] = [];

async function runsDir(): Promise<string> {
	const temp = await TempDir.create("evals-resume-");
	temps.push(temp);
	return temp.path();
}

/** A journal with a header and no trial: the shape a run interrupted before its first trial leaves. */
async function emptyJournal(dir: string, runId: string): Promise<string> {
	const journal = await openRunJournal(dir, runId, PLAN_DIGEST);
	await journal.close();
	return journalPathFor(dir, runId);
}

afterEach(async () => {
	for (const temp of temps.splice(0)) await temp.remove();
});

describe("the journal a resume looks for", () => {
	it("reports a run that was never started as having none", async () => {
		const dir = await runsDir();
		expect(await journalExists(dir, "never-ran")).toBe(false);
	});

	it("reports a run interrupted before its first trial as having one", async () => {
		const dir = await runsDir();
		const journalPath = await emptyJournal(dir, "started-then-died");

		expect(await journalExists(dir, "started-then-died")).toBe(true);
		const header = (await fs.readFile(journalPath, "utf-8")).trim();
		expect(JSON.parse(header)).toMatchObject({ journal: RUN_JOURNAL_KIND, version: RUN_JOURNAL_VERSION });
	});
});

describe("a resume of a run with no journal", () => {
	it("refuses before any preflight, naming the path and both ways out", async () => {
		const dir = await runsDir();
		const suite = requireSuite("typescript-edit");
		const context: SuiteContext = { workDir: dir, options: {} };
		const tasks = await suite.discoverTasks(context);
		const plan = await buildRunPlan({
			suite,
			runId: "typo-in-the-run-id",
			selection: { harnesses: ["veyyon"], models: ["vendor/model"] },
			tasks: tasks.slice(0, 1),
			repeats: 1,
			context,
		});

		const failure = executeRun({
			plan,
			backend: requireBackend(suite.backend),
			workDir: dir,
			runsDir: dir,
			jobs: 1,
			resume: true,
		});

		await expect(failure).rejects.toThrow(ResumeWithoutJournalError);
		await expect(failure).rejects.toThrow(/has no trial journal at/);
		await expect(failure).rejects.toThrow(/Drop --resume to start it/);

		// Refused, not started: nothing was written under the run id it named.
		await expect(fs.readdir(path.join(dir, "typo-in-the-run-id"))).rejects.toThrow();
	});

	it("is the verdict a dry run states, so both paths agree", async () => {
		const dir = await runsDir();
		expect(await describeResume(dir, "typo-in-the-run-id", PLAN_DIGEST)).toBe(
			`REFUSED — no trial journal at ${journalPathFor(dir, "typo-in-the-run-id")}: there is nothing to resume`,
		);
	});

	it("states an existing journal as resumable, with the count it would skip", async () => {
		const dir = await runsDir();
		await emptyJournal(dir, "started-then-died");
		expect(await describeResume(dir, "started-then-died", PLAN_DIGEST)).toBe(
			`ok — 0 settled trial(s) in ${journalPathFor(dir, "started-then-died")} would be skipped`,
		);
	});

	it("refuses a journal this build cannot read rather than throwing mid-run", async () => {
		const dir = await runsDir();
		const journalPath = journalPathFor(dir, "written-by-a-later-build");
		await fs.mkdir(path.dirname(journalPath), { recursive: true });
		await fs.writeFile(
			journalPath,
			`${JSON.stringify({
				journal: RUN_JOURNAL_KIND,
				version: RUN_JOURNAL_VERSION + 1,
				runId: "written-by-a-later-build",
				plan: PLAN_DIGEST,
			})}\n`,
		);

		const verdict = await describeResume(dir, "written-by-a-later-build", PLAN_DIGEST);
		expect(verdict).toStartWith("REFUSED — ");
		expect(verdict).toContain("Start a new run id instead of resuming this one");
	});
});
