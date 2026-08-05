/**
 * What a cancelled multi-PR checkout tells the operator about what is now on their disk.
 *
 * WHY THIS SUITE EXISTS. `pr_checkout` accepts a list of pull requests and checks each one
 * out concurrently, and a checked-out PR is not an in-memory result: it is a worktree
 * DIRECTORY, a local branch, and sometimes a new fork remote. When one of the concurrent
 * checkouts failed, `executePrCheckout` called `throwIfAborted(signal)` first and only then
 * built its partial-success report -- so pressing Escape midway threw the bare sentence
 * "Operation aborted" and dropped the list of worktrees that had already been created. The
 * comment directly below that line says the partial report exists "so the agent does not
 * lose track of them", which is exactly what the abort path did.
 *
 * Losing them is not cosmetic. The next thing anyone does after a cancelled checkout is
 * check the same PR out again, and that run finds a local branch and a worktree it has no
 * record of creating; with `force` unset it refuses, quoting a branch the operator was never
 * told about.
 *
 * Two properties are pinned here, and they pull in opposite directions:
 *
 *  1. The rejection stays an ABORT (`ToolAbortError`), not a tool error and not a resolved
 *     `isError` result. The agent loop's correct response to a failed checkout is to read
 *     the failure and retry; its correct response to a cancellation is to stop. Folding one
 *     into the other is the same defect this row already fixed in the edit and eval tools.
 *  2. The abort MESSAGE carries the branch and worktree path of everything that finished,
 *     and names the PRs that were not reached.
 *
 * HOW THE FIXTURE WORKS, and why it is not a real git repository. The mutating end-to-end
 * checkout fixture (a real bare repo, a real worktree, a real `$HOME`) already exists in
 * `gh.test.ts` and is ~200 lines; copying it here to test a reporting decision would be a
 * second copy of a fixture rather than a second test. Instead the seam is `git.withRepoLock`,
 * which is where `checkoutPullRequest` does every git mutation: stubbing it lets one PR
 * "succeed" with a real outcome object and another abort, through the real `GithubTool`,
 * the real `executePrCheckout`, and the real message builder.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { toolWireSchema } from "@veyyon/ai/utils/schema";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { GithubTool, MUTATING_GITHUB_OPS } from "@veyyon/coding-agent/tools/gh";
import { ToolAbortError } from "@veyyon/coding-agent/tools/tool-errors";
import * as git from "@veyyon/coding-agent/utils/git";
import { setAgentDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";
import { makeToolSession } from "../helpers/tool-session";

const REPO_ROOT = path.join(path.sep, "tmp", "gh-abort-fixture");

function session(): ToolSession {
	return makeToolSession({
		cwd: REPO_ROOT,
		getArtifactsDir: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "github.enabled": true }),
	});
}

/** The `gh pr view --json` payload for one pull request, with the fields the tool reads. */
function prMetadata(number: number) {
	return {
		number,
		title: `PR ${number}`,
		url: `https://github.com/base/repo/pull/${number}`,
		baseRefName: "main",
		headRefName: `feature-${number}`,
		headRefOid: "1111111111111111111111111111111111111111",
		headRepository: { nameWithOwner: "base/repo" },
		headRepositoryOwner: { login: "base" },
		isCrossRepository: false,
		maintainerCanModify: true,
	};
}

/**
 * Stub the read-only half of the git layer: PR metadata and the repo roots.
 *
 * Each test then replaces `withRepoLock` with its own per-PR plan, which is where the
 * mutations live. The stub installed here throws, so a test that forgets to supply a plan
 * fails loudly instead of quietly checking out nothing.
 */
function stubGit(): void {
	vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
		const ref = args.find(arg => /^\d+$/.test(arg));
		return prMetadata(Number(ref ?? "0")) as never;
	});
	vi.spyOn(git.repo, "root").mockResolvedValue(REPO_ROOT);
	vi.spyOn(git.repo, "primaryRoot").mockResolvedValue(REPO_ROOT);
	vi.spyOn(git, "withRepoLock").mockImplementation(async () => {
		throw new Error("a test reached withRepoLock without installing a checkout plan");
	});
}

/** Replace `withRepoLock` with a per-PR outcome, keyed by the order calls arrive. */
function checkoutOutcomes(controller: AbortController, plan: ReadonlyArray<number | "abort">): void {
	let call = 0;
	vi.spyOn(git, "withRepoLock").mockImplementation(async () => {
		const step = plan[call++];
		if (step === "abort" || step === undefined) {
			controller.abort();
			throw new ToolAbortError("Operation aborted");
		}
		return {
			data: prMetadata(step),
			localBranch: `pr-${step}`,
			worktreePath: path.join(path.sep, "tmp", "wt", `pr-${step}`),
			remoteName: "origin",
			remoteUrl: "https://github.com/base/repo.git",
			headRefName: `feature-${step}`,
			reused: false,
		} as never;
	});
}

describe("classifying which github ops may be abandoned on abort", () => {
	/**
	 * Every op the schema accepts is classified, and the classification is read off the tool's
	 * own parameter schema rather than restated here. A new op that writes something and is
	 * not added to the set inherits the raced path silently, which is how a cancellation ends
	 * up walking away from a half-finished push -- the exact bug this suite documents, one op
	 * later. Pinning the set exactly is what turns that into a failing test.
	 */
	it("classifies every op the schema accepts, mutating ones exactly", () => {
		const wire = toolWireSchema(new GithubTool(session()));
		const properties = wire.properties as Record<string, { enum?: readonly string[] }>;
		const ops = [...(properties.op?.enum ?? [])].sort();

		expect(ops).toEqual([
			"pr_checkout",
			"pr_create",
			"pr_push",
			"repo_view",
			"run_watch",
			"search_code",
			"search_commits",
			"search_issues",
			"search_prs",
			"search_repos",
		]);
		expect([...MUTATING_GITHUB_OPS].sort()).toEqual(["pr_checkout", "pr_create", "pr_push"]);
		expect(ops.filter(op => MUTATING_GITHUB_OPS.has(op))).toHaveLength(MUTATING_GITHUB_OPS.size);
	});
});

describe("cancelling a multi-PR checkout", () => {
	// `setAgentDir` moves the resolved agent dir, the pre-profile baseline and
	// `VEYYON_CODING_AGENT_DIR`, all of which are process-global. Unrestored, every
	// later file in the run resolved its agent dir to this file's `/tmp` path.
	let dirOverrides: DirOverridesSnapshot | undefined;

	beforeAll(() => {
		dirOverrides = captureDirOverrides();
		setAgentDir(path.join(path.sep, "tmp", "gh-abort-agent-dir"));
	});

	afterAll(() => {
		if (dirOverrides) restoreDirOverrides(dirOverrides);
		dirOverrides = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * THE REGRESSION. One PR finished, the second was cancelled, and the worktree that
	 * exists must be named. Asserted on the message text because the message is the only
	 * thing that reaches the operator on this path -- there is no result object to inspect.
	 */
	it("names every worktree already on disk in the abort message", async () => {
		const controller = new AbortController();
		stubGit();
		checkoutOutcomes(controller, [7, "abort"]);

		const promise = new GithubTool(session()).execute(
			"call-1",
			{ op: "pr_checkout", pr: ["7", "8"] } as never,
			controller.signal,
		);

		const error = await promise.then(
			() => undefined,
			(err: unknown) => err,
		);
		expect(error).toBeInstanceOf(ToolAbortError);
		expect((error as Error).message).toContain("PR checkout cancelled after 1 of 2 pull requests");
		expect((error as Error).message).toContain(
			`already checked out: pr-7 at ${path.join(path.sep, "tmp", "wt", "pr-7")}`,
		);
		expect((error as Error).message).toContain("NOT checked out: 8");
		expect((error as Error).message).toContain("the worktrees above are on disk and were left in place");
	});

	/**
	 * An abort is an abort, not a failure. This is the property the agent loop branches on:
	 * a `ToolError` means read the message and try again, `ToolAbortError` means the operator
	 * said stop. Before the fix a cancellation with two unfinished checkouts produced
	 * `ToolError("all 2 PR checkouts failed: …")`, which reads as two broken PRs.
	 */
	it("rejects as an abort rather than a failed-checkout error", async () => {
		const controller = new AbortController();
		stubGit();
		checkoutOutcomes(controller, ["abort", "abort"]);

		const error = await new GithubTool(session())
			.execute("call-2", { op: "pr_checkout", pr: ["11", "12"] } as never, controller.signal)
			.then(
				() => undefined,
				(err: unknown) => err,
			);

		expect(error).toBeInstanceOf(ToolAbortError);
		expect((error as Error).message).not.toContain("PR checkouts failed");
	});

	/**
	 * Nothing finished, so there is nothing to leave in place and the message must not claim
	 * otherwise. A report that lists worktrees when none exist sends the operator looking for
	 * directories that are not there, which is worse than saying less.
	 */
	it("claims no worktrees when none were created", async () => {
		const controller = new AbortController();
		stubGit();
		checkoutOutcomes(controller, ["abort", "abort"]);

		const error = await new GithubTool(session())
			.execute("call-3", { op: "pr_checkout", pr: ["11", "12"] } as never, controller.signal)
			.then(
				() => undefined,
				(err: unknown) => err,
			);

		const message = (error as Error).message;
		expect(message).toContain("PR checkout cancelled after 0 of 2 pull requests");
		expect(message).toContain("NOT checked out: 11, 12");
		expect(message).not.toContain("already checked out");
		expect(message).not.toContain("left in place");
	});

	/**
	 * Singular wording for a single PR. The multi-file edit abort shipped `1 of 3 entrys` on
	 * its first run, which is why every one of these messages spells its plurals out and why
	 * this case is asserted rather than assumed.
	 */
	it("says pull request, not pull requests, for a single cancelled checkout", async () => {
		const controller = new AbortController();
		stubGit();
		checkoutOutcomes(controller, ["abort"]);

		const error = await new GithubTool(session())
			.execute("call-4", { op: "pr_checkout", pr: ["42"] } as never, controller.signal)
			.then(
				() => undefined,
				(err: unknown) => err,
			);

		expect((error as Error).message).toContain("cancelled after 0 of 1 pull request;");
	});

	/**
	 * Non-vacuity: with no cancellation the tool still reports both checkouts normally. A
	 * suite that only ever asserts rejections would pass just as well against a tool that
	 * always rejects.
	 */
	it("still reports both worktrees when nothing is cancelled", async () => {
		const controller = new AbortController();
		stubGit();
		checkoutOutcomes(controller, [7, 8]);

		const result = await new GithubTool(session()).execute(
			"call-5",
			{ op: "pr_checkout", pr: ["7", "8"] } as never,
			controller.signal,
		);

		const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
		expect(text).toContain("# 2 Pull Request Worktrees (2 checked out)");
		expect(result.details?.checkouts?.map(entry => entry.branch)).toEqual(["pr-7", "pr-8"]);
	});

	/**
	 * THE OTHER HALF OF THE FIX, and the one that was invisible from inside
	 * `executePrCheckout`. `GithubTool.execute` used to wrap every op in `untilAborted`, which
	 * races the work against the signal: the instant the signal fired the tool rejected with
	 * the generic platform abort and the checkouts kept running unobserved, creating worktrees
	 * nobody was waiting for. So the carefully built message above could never reach a caller.
	 *
	 * Here every checkout SUCCEEDS but the signal fires while they run. A raced tool rejects;
	 * an awaited one reports both worktrees, which is what the operator needs to know exists.
	 */
	it("awaits a mutating op instead of abandoning it when the signal fires mid-flight", async () => {
		const controller = new AbortController();
		stubGit();
		let call = 0;
		vi.spyOn(git, "withRepoLock").mockImplementation(async () => {
			const number = call++ === 0 ? 7 : 8;
			// Cancel while the mutations are in flight, which is when Escape actually lands.
			controller.abort();
			await Promise.resolve();
			return {
				data: prMetadata(number),
				localBranch: `pr-${number}`,
				worktreePath: path.join(path.sep, "tmp", "wt", `pr-${number}`),
				remoteName: "origin",
				remoteUrl: "https://github.com/base/repo.git",
				headRefName: `feature-${number}`,
				reused: false,
			} as never;
		});

		const result = await new GithubTool(session()).execute(
			"call-7",
			{ op: "pr_checkout", pr: ["7", "8"] } as never,
			controller.signal,
		);

		expect(controller.signal.aborted).toBe(true);
		expect(result.details?.checkouts?.map(entry => entry.worktreePath)).toEqual([
			path.join(path.sep, "tmp", "wt", "pr-7"),
			path.join(path.sep, "tmp", "wt", "pr-8"),
		]);
	});

	/**
	 * A read op keeps the race, and that is deliberate rather than an oversight. Nothing was
	 * changed, so returning the moment the operator cancels is the correct behaviour and the
	 * reason `untilAborted` is at this boundary at all. Without this case the fix above could
	 * be "widened" to every op and nothing would notice.
	 */
	it("still returns immediately from a read op when the signal fires", async () => {
		const controller = new AbortController();
		vi.spyOn(git.repo, "root").mockResolvedValue(REPO_ROOT);
		let searchSettled = false;
		vi.spyOn(git.github, "json").mockImplementation(async () => {
			await new Promise(resolve => setTimeout(resolve, 5_000));
			searchSettled = true;
			return { items: [] } as never;
		});

		const promise = new GithubTool(session()).execute(
			"call-8",
			{ op: "search_issues", query: "bug", repo: "base/repo" } as never,
			controller.signal,
		);
		controller.abort();

		await expect(promise).rejects.toThrow();
		expect(searchSettled).toBe(false);
	});

	/**
	 * A genuine failure with a partial success keeps its old behaviour: it RESOLVES with the
	 * created worktrees and a `## Failed` section, because a failed checkout is something the
	 * agent can act on. Pinned here so the abort branch cannot be widened into this one.
	 */
	it("still resolves with a Failed section when a checkout fails without a cancellation", async () => {
		const controller = new AbortController();
		stubGit();
		let call = 0;
		vi.spyOn(git, "withRepoLock").mockImplementation(async () => {
			if (call++ === 0) {
				return {
					data: prMetadata(7),
					localBranch: "pr-7",
					worktreePath: path.join(path.sep, "tmp", "wt", "pr-7"),
					remoteName: "origin",
					remoteUrl: "https://github.com/base/repo.git",
					headRefName: "feature-7",
					reused: false,
				} as never;
			}
			throw new Error("head branch has no commits");
		});

		const result = await new GithubTool(session()).execute(
			"call-6",
			{ op: "pr_checkout", pr: ["7", "8"] } as never,
			controller.signal,
		);

		const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
		expect(text).toContain("# 1/2 Pull Request Worktrees checked out (1 failed)");
		expect(text).toContain("- 8: head branch has no commits");
		expect(controller.signal.aborted).toBe(false);
	});
});
