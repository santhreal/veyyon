/**
 * `CommitDriftTracker`: the count behind the `commit-drift` nudge.
 *
 * The nudge tells the model to commit, so every one of these tests defends a case where
 * saying that would be WRONG, not just noisy. A count that includes another lane's dirty
 * files sends the model to commit work it did not do; a count that survives the commit
 * that cleared it nags immediately after the model complied; a count produced mid-rebase
 * asks for a commit inside someone else's sequence. Each of those shipped as a plausible
 * one-line implementation at some point in the design, which is why each has a test.
 *
 * Real repositories rather than a faked HEAD: the whole commit-boundary mechanism is
 * "read `.git/HEAD` and its ref file", so a fake would test the mock.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { CommitDriftTracker } from "../../src/session/commit-drift";

/** A `write` tool result, whose mutated path lives in `resolvedPath`. */
function wrote(file: string): { tool: string; details: Record<string, unknown> } {
	return { tool: "write", details: { resolvedPath: file } };
}

/** An `edit` tool result covering several files, the multi-file shape. */
function edited(...files: string[]): { tool: string; details: Record<string, unknown> } {
	return { tool: "edit", details: { perFileResults: files.map(file => ({ path: file })) } };
}

let repo: string;
let outside: string;

beforeAll(async () => {
	repo = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-drift-repo-"));
	outside = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-drift-plain-"));
	await fs.writeFile(path.join(repo, "seed.txt"), "seed\n");
	await $`git init --initial-branch=main && git config user.email t@example.com && git config user.name T && git add seed.txt && git commit -m seed`
		.cwd(repo)
		.quiet();
});

afterAll(async () => {
	await fs.rm(repo, { recursive: true, force: true });
	await fs.rm(outside, { recursive: true, force: true });
});

describe("what the tracker counts", () => {
	/**
	 * The count is built from tool RESULTS, so one call that changed four files counts
	 * four. Counting calls instead would under-report exactly the sessions that drift
	 * fastest: a single `edit` payload can rewrite a whole module.
	 */
	test("counts every file a multi-file edit result reported, not the one call", () => {
		const tracker = new CommitDriftTracker();
		const call = edited("a.ts", "b.ts", "c.ts", "d.ts");
		tracker.record(call.tool, call.details, repo);
		expect(tracker.summary(repo, 4)?.count).toBe(4);
	});

	/**
	 * THE reason this class exists instead of a `git status` call. A tree carrying
	 * another lane's dirty files must not inflate the count, because the nudge names the
	 * files and tells the model to stage them: an inflated count is an instruction to
	 * commit someone else's work.
	 */
	test("ignores files dirty in the tree that this session never touched", async () => {
		await fs.writeFile(path.join(repo, "someone-elses-lane.ts"), "not mine\n");
		const tracker = new CommitDriftTracker();
		const call = wrote(path.join(repo, "mine.ts"));
		tracker.record(call.tool, call.details, repo);

		const summary = tracker.summary(repo, 1);
		expect(summary?.count).toBe(1);
		expect(summary?.files).toBe("mine.ts");
		expect(summary?.files).not.toContain("someone-elses-lane");
	});

	/**
	 * A tool that changed nothing contributes nothing. `ast_edit` reports
	 * `totalReplacements: 0` when its pattern matched no code, and treating that as an
	 * edit would let a search-shaped session drift its way to a commit nudge.
	 */
	test("a tool result that reported no change does not move the count", () => {
		const tracker = new CommitDriftTracker();
		tracker.record("ast_edit", { applied: true, totalReplacements: 0, files: ["untouched.ts"] }, repo);
		tracker.record("grep", { matches: 12 }, repo);
		expect(tracker.summary(repo, 1)).toBeNull();
	});

	/** The same file edited repeatedly is one uncommitted file, not a rising count. */
	test("re-editing one file does not inflate the count", () => {
		const tracker = new CommitDriftTracker();
		for (let i = 0; i < 5; i++) {
			const call = wrote(path.join(repo, "hot.ts"));
			tracker.record(call.tool, call.details, repo);
		}
		expect(tracker.summary(repo, 1)?.count).toBe(1);
	});
});

describe("when the tracker refuses to report", () => {
	/**
	 * The threshold is the operator's knob (`commit.nudgeAfterFiles`) and 0 means off.
	 * A tracker that still reported at 0 would make the "Off" option a lie.
	 */
	test("a threshold of 0 reports nothing no matter how far the session has drifted", () => {
		const tracker = new CommitDriftTracker();
		const call = edited("a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts");
		tracker.record(call.tool, call.details, repo);
		expect(tracker.summary(repo, 0)).toBeNull();
		expect(tracker.summary(repo, 6)?.count).toBe(6);
	});

	/** Below the threshold is silence, not a smaller nudge. */
	test("stays silent one file below the threshold and speaks exactly at it", () => {
		const tracker = new CommitDriftTracker();
		const two = edited("a.ts", "b.ts");
		tracker.record(two.tool, two.details, repo);
		expect(tracker.summary(repo, 3)).toBeNull();

		const third = wrote(path.join(repo, "c.ts"));
		tracker.record(third.tool, third.details, repo);
		expect(tracker.summary(repo, 3)?.count).toBe(3);
	});

	/**
	 * Outside a repository there is no commit to make. Without this the nudge would fire
	 * in any scratch directory and instruct the model to run `git commit` where it fails.
	 */
	test("reports nothing when the session is not in a git repository", () => {
		const tracker = new CommitDriftTracker();
		const call = edited("a.ts", "b.ts", "c.ts");
		tracker.record(call.tool, call.details, outside);
		expect(tracker.summary(outside, 1)).toBeNull();
	});
});

describe("the commit boundary", () => {
	/**
	 * The nudge exists to be obeyed, so obeying it must silence it. HEAD moving is the
	 * evidence a commit landed; leaving the set intact would re-fire the reminder on the
	 * model's next edit, immediately after it did what was asked.
	 */
	test("a commit clears the drift it was nudged about", async () => {
		const work = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-drift-commit-"));
		try {
			await fs.writeFile(path.join(work, "seed.txt"), "seed\n");
			await $`git init --initial-branch=main && git config user.email t@example.com && git config user.name T && git add seed.txt && git commit -m seed`
				.cwd(work)
				.quiet();

			const tracker = new CommitDriftTracker();
			await fs.writeFile(path.join(work, "a.ts"), "a\n");
			await fs.writeFile(path.join(work, "b.ts"), "b\n");
			const call = edited(path.join(work, "a.ts"), path.join(work, "b.ts"));
			tracker.record(call.tool, call.details, work);
			expect(tracker.summary(work, 2)?.count).toBe(2);

			await $`git add a.ts b.ts && git commit -m "land the chunk"`.cwd(work).quiet();

			expect(tracker.summary(work, 2)).toBeNull();
			expect(tracker.summary(work, 1)).toBeNull();
		} finally {
			await fs.rm(work, { recursive: true, force: true });
		}
	});

	/**
	 * A rebase, merge, or cherry-pick moves HEAD for reasons that are not the model's
	 * commits, and a commit made part-way through one lands inside another operation's
	 * sequence. Silence is the only correct output until the operation finishes.
	 */
	test("says nothing while a multi-step git operation is in progress", async () => {
		const work = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-drift-rebase-"));
		try {
			await fs.writeFile(path.join(work, "seed.txt"), "seed\n");
			await $`git init --initial-branch=main && git config user.email t@example.com && git config user.name T && git add seed.txt && git commit -m seed`
				.cwd(work)
				.quiet();

			const tracker = new CommitDriftTracker();
			const call = edited(path.join(work, "a.ts"), path.join(work, "b.ts"));
			tracker.record(call.tool, call.details, work);
			expect(tracker.summary(work, 2)?.count).toBe(2);

			// The marker git itself writes; `head.operation` reads exactly this.
			await fs.mkdir(path.join(work, ".git", "rebase-merge"), { recursive: true });
			await fs.writeFile(path.join(work, ".git", "rebase-merge", "head-name"), "refs/heads/main\n");

			expect(tracker.summary(work, 2)).toBeNull();

			await fs.rm(path.join(work, ".git", "rebase-merge"), { recursive: true, force: true });
			expect(tracker.summary(work, 2)?.count).toBe(2);
		} finally {
			await fs.rm(work, { recursive: true, force: true });
		}
	});
});

describe("the file list the nudge shows", () => {
	/**
	 * The nudge tells the model to stage these paths by name, so they must be the
	 * repo-relative paths a `git add` accepts, sorted for a stable read.
	 */
	test("names files relative to the repository root, sorted", () => {
		const tracker = new CommitDriftTracker();
		const call = edited(path.join(repo, "src/z.ts"), path.join(repo, "src/a.ts"), path.join(repo, "b.ts"));
		tracker.record(call.tool, call.details, repo);
		expect(tracker.summary(repo, 3)?.files).toBe("b.ts, src/a.ts, src/z.ts");
	});

	/**
	 * A hundred-file list would be the largest thing in the reminder and would bury the
	 * instruction under it. The count stays exact while the listing is capped.
	 */
	test("caps the listing and says how many it left out, without capping the count", () => {
		const tracker = new CommitDriftTracker();
		const files = Array.from({ length: 11 }, (_, i) => path.join(repo, `f${i.toString().padStart(2, "0")}.ts`));
		const call = edited(...files);
		tracker.record(call.tool, call.details, repo);

		const summary = tracker.summary(repo, 1);
		expect(summary?.count).toBe(11);
		expect(summary?.files).toEndWith(", and 3 more");
		expect(summary?.files).toStartWith("f00.ts, f01.ts");
	});
});
