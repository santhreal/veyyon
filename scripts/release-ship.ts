#!/usr/bin/env bun
/**
 * The half of a release that leaves your machine.
 *
 * `scripts/release-cut.ts` prepares the bump commit and hands over here. Everything after
 * that was three manual commands and a human watching Actions: push main, wait
 * for green, tag the green commit. Three commands is not the problem; the wait
 * is. It is minutes of staring at a run list, and the two failure modes it
 * invites are both expensive. Tag too early and you publish a SHA whose gates
 * never finished, which is exactly how v1.0.36 shipped without lint or
 * typecheck. Walk away instead and the release sits prepared for an hour.
 *
 * So the waiting is automated and the decision is not. This module pushes,
 * polls the checks for the pushed SHA, and cuts the tag only on a green verdict
 * it can name. The operator's approval is the invocation itself: nothing here
 * runs unless someone typed `--ship`, and it prints exactly what it is about to
 * publish and asks once before the first push.
 *
 * The verdict is a pure function over `gh run list` records so it can be tested
 * against real conclusions rather than by cutting releases.
 */
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * How to finish a cut by hand.
 *
 * Printed whenever the cut stopped before it published: a dry run, a declined
 * prompt, a red gate, a wait that ran out. Every one of those leaves the same
 * two moves outstanding, so there is one list rather than a branch per exit.
 *
 * It exists because a release must never depend on this script being willing to
 * run. `docs/internal/releasing.md` quotes it, so it lives in one place.
 */
export function nextSteps(version: string): string[] {
	return [
		"  To finish by hand:",
		"",
		"    1. Push the bump and let main's CI test it:",
		"           git push origin main && gh run watch --exit-status",
		"",
		"    2. Tag the green commit. This is the release:",
		`           git tag v${version} && git push origin v${version}`,
		"",
		"  Tagged CI builds the binaries, verifies their checksums, and publishes",
		"  the GitHub release the installer reads.",
	];
}

/**
 * The workflows that run on EVERY push to main, and therefore the ones whose
 * absence from a SHA's run list means the checks have not started yet rather
 * than that they passed.
 *
 * Deliberately not the full workflow set. `Docs` and `Site` are path-filtered,
 * and while a release bump touches changelogs and so trips both today, a bump
 * that happened not to would wait forever on a run that was never going to
 * exist. Runs that DO appear are still required to pass, whether or not they
 * are listed here, so the filter only decides what to wait for, never what to
 * forgive. `scripts/release-ship.test.ts` fails when a workflow gains or loses
 * an unconditional main-push trigger without this list following.
 */
export const REQUIRED_WORKFLOWS = ["CI", "Checks"] as const;

/** One `gh run list` record, narrowed to the fields a verdict needs. */
export type RunSummary = {
	workflowName: string;
	/** `queued` | `in_progress` | `completed`, plus whatever GitHub adds next. */
	status: string;
	/** Empty until `status` is `completed`. */
	conclusion: string;
	url: string;
};

export type Verdict =
	| { state: "green" }
	| { state: "pending"; waitingOn: string[] }
	| { state: "failed"; failures: RunSummary[] };

/**
 * A conclusion that does not block a release.
 *
 * `skipped` is a pass because path filters produce it legitimately: a bump that
 * touches no website file skips Site, and refusing to release over that would
 * make the filter a liability. Everything else that is not `success` blocks,
 * including `cancelled` and `neutral`: a cancelled gate proves nothing about
 * the SHA, and treating "not a failure" as "a pass" is the reasoning that let a
 * release publish on unfinished checks.
 */
const PASSING_CONCLUSIONS: Record<string, true> = { success: true, skipped: true };

/**
 * Decide whether a SHA is ready to tag.
 *
 * Pending beats failed on purpose: while anything is still running the answer
 * is "not yet", even if another workflow has already failed. The caller keeps
 * polling, the failing run stays visible in the wait line, and the operator
 * gets one final verdict instead of a race between two.
 */
export function checkVerdict(runs: readonly RunSummary[], required: readonly string[] = REQUIRED_WORKFLOWS): Verdict {
	const present = new Set(runs.map(run => run.workflowName));
	const missing = required.filter(name => !present.has(name));
	const unfinished = runs.filter(run => run.status !== "completed");
	if (missing.length > 0 || unfinished.length > 0) {
		return {
			state: "pending",
			waitingOn: [...missing.map(name => `${name} (not started)`), ...unfinished.map(run => run.workflowName)],
		};
	}
	const failures = runs.filter(run => !PASSING_CONCLUSIONS[run.conclusion]);
	if (failures.length > 0) return { state: "failed", failures };
	return { state: "green" };
}

/**
 * How long to keep polling before giving up.
 *
 * The full matrix is the slow one, and a queued runner can sit for a while
 * before it even starts, so the ceiling is generous. Reaching it is not a
 * failed release: the bump is already on main and the operator can tag it
 * later, which is what the timeout message says.
 */
const WAIT_CEILING_MS = 90 * 60 * 1000;
const POLL_INTERVAL_MS = 15 * 1000;

async function git(...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { maxBuffer: 64 * 1024 * 1024 });
	return stdout;
}

/**
 * The runs for one commit, asked for one required workflow at a time.
 *
 * A single `gh run list --commit <sha>` is the obvious call and it is wrong.
 * The list is every workflow run GitHub associates with that SHA, newest
 * first, and that includes the SCHEDULED ones: `Upstream radar` alone runs
 * hourly against main's tip. Measured against `d406c561`, a 50-run window came
 * back as 50 `Upstream radar` runs with `CI` and `Checks` nowhere in it, and
 * the verdict read "not started" for workflows that had in fact run and
 * failed. A waiter that cannot see a red gate is worse than no waiter.
 *
 * Raising the limit only moves the cliff. Asking per workflow removes it: each
 * query is scoped, so an unrelated schedule can never displace a required run
 * no matter how often it fires.
 */
export async function runsForSha(sha: string, required: readonly string[] = REQUIRED_WORKFLOWS): Promise<RunSummary[]> {
	const perWorkflow = await Promise.all(
		required.map(async workflow => {
			const { stdout } = await execFileAsync(
				"gh",
				[
					"run",
					"list",
					"--commit",
					sha,
					"--workflow",
					workflow,
					"--limit",
					"20",
					"--json",
					"workflowName,status,conclusion,url",
				],
				{ maxBuffer: 32 * 1024 * 1024 },
			);
			const parsed: unknown = JSON.parse(stdout);
			if (!Array.isArray(parsed)) {
				throw new Error(`Unexpected 'gh run list' output for ${sha} / ${workflow}: ${stdout.slice(0, 200)}`);
			}
			return parsed as RunSummary[];
		}),
	);
	return perWorkflow.flat();
}

/**
 * Ask once, on a tty, before anything becomes public.
 *
 * There is no way to skip it. A release that publishes without a human
 * answering is the CI controller this design replaced, and the dry run already
 * covers every non-interactive question worth asking.
 */
async function confirm(question: string): Promise<boolean> {
	if (!process.stdin.isTTY) {
		throw new Error("A release has to be confirmed at a terminal. Use `bun run release:dry` to preview one instead.");
	}
	process.stdout.write(`${question} [y/N] `);
	for await (const chunk of process.stdin) {
		return String(chunk).trim().toLowerCase() === "y";
	}
	return false;
}

/**
 * Push the prepared bump, wait for its checks, and tag it.
 *
 * Assumes `prepareRelease` already ran in this process: HEAD is the bump
 * commit, the tree is clean, and the version authorities agree. Every refusal
 * that belongs before the first write lives there, not here.
 */
export async function shipRelease(version: string): Promise<void> {
	const tag = `v${version}`;
	const sha = (await git("rev-parse", "HEAD")).trim();
	const subject = (await git("log", "-1", "--format=%s")).trim();

	console.log(`\nReady to publish ${tag}.`);
	console.log(`  commit  ${sha.slice(0, 12)}  ${subject}`);
	console.log("  push    origin main");
	console.log(`  wait    ${REQUIRED_WORKFLOWS.join(", ")} on that commit`);
	console.log(`  tag     ${tag} -> origin\n`);
	console.log("  The tag is the release: it builds the binaries and publishes the");
	console.log("  GitHub release the installer reads. Nothing before it is public.\n");

	if (!(await confirm(`Publish ${tag}?`))) {
		console.log("\nStopped. The bump is committed locally and nothing was pushed.\n");
		for (const line of nextSteps(version)) console.log(line);
		return;
	}

	console.log("\nPushing main...");
	await git("push", "origin", "main");
	console.log(`Pushed ${sha.slice(0, 12)}. Waiting for checks.\n`);

	const deadline = Date.now() + WAIT_CEILING_MS;
	let lastLine = "";
	for (;;) {
		const verdict = checkVerdict(await runsForSha(sha));
		if (verdict.state === "green") {
			console.log("\nAll checks green.");
			break;
		}
		if (verdict.state === "failed") {
			const named = verdict.failures.map(run => `  ${run.workflowName}: ${run.conclusion}\n    ${run.url}`);
			throw new Error(
				[
					`${tag} was not tagged: the checks on ${sha.slice(0, 12)} did not pass.`,
					...named,
					"",
					"The bump commit is on main. Fix main, then tag the green commit:",
					`    git tag ${tag} && git push origin ${tag}`,
				].join("\n"),
			);
		}
		if (Date.now() > deadline) {
			throw new Error(
				[
					`Gave up waiting for checks on ${sha.slice(0, 12)} after ${WAIT_CEILING_MS / 60000} minutes.`,
					`Still waiting on: ${verdict.waitingOn.join(", ")}`,
					"",
					"Nothing is wrong with the release; it just is not green yet. Once it is:",
					`    git tag ${tag} && git push origin ${tag}`,
				].join("\n"),
			);
		}
		// Rewrite one line rather than scrolling a poll log: the interesting
		// content is which gate is still out, and that changes rarely.
		const line = `  waiting on: ${verdict.waitingOn.join(", ")}`;
		if (line !== lastLine) {
			process.stdout.write(`${line}\n`);
			lastLine = line;
		}
		await sleep(POLL_INTERVAL_MS);
	}

	console.log(`Tagging ${tag}...`);
	await git("tag", tag);
	await git("push", "origin", tag);
	console.log(`\nPublished ${tag}. The tagged CI run builds and releases it:`);
	console.log(`    gh run watch --exit-status`);
}
