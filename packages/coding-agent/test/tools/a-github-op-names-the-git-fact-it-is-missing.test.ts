/**
 * WHY: a `github` op that writes (`pr_push`, `pr_create`, `pr_checkout`) starts from a git fact
 * about the current checkout — the repository root, the primary root, the current branch, the
 * head commit — and each fact can be missing: a cwd outside any repository, a detached HEAD.
 * The four preludes that turn a missing fact into a `ToolError` were four copies of one guard and
 * now share `requireGitValue`; this suite pins the contract each caller relies on, through the
 * real `GithubTool` with only the git facts stubbed: the op rejects with a `ToolError` that
 * states which fact is missing and, where one exists, the parameter that supplies it.
 *
 * Not caught: the `run_watch` prelude, which needs a resolved GitHub repository before it asks
 * for the branch and head, and is covered by the run-watch suites.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ToolError } from "@veyyon/coding-agent/tools/core/tool-errors";
import { GithubTool } from "@veyyon/coding-agent/tools/web/gh";
import * as git from "@veyyon/coding-agent/utils/git";
import { makeToolSession } from "../helpers/tool-session";

const REPO_ROOT = path.join(path.sep, "repo");

function session(): ToolSession {
	return makeToolSession({
		cwd: REPO_ROOT,
		getArtifactsDir: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "github.enabled": true }),
	});
}

async function rejection(op: "pr_push", params: Record<string, unknown> = {}): Promise<unknown> {
	return new GithubTool(session()).execute("call-1", { op, ...params } as never).then(
		() => undefined,
		(err: unknown) => err,
	);
}

describe("a github op names the git fact it is missing", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Each lookup past the missing fact rejects with its own message, so reaching it changes the
	// error the op reports and the message assertion below catches it.
	it("rejects a push from outside a git repository", async () => {
		vi.spyOn(git.repo, "root").mockResolvedValue(null);
		vi.spyOn(git.branch, "current").mockRejectedValue(new Error("the current branch was looked up"));

		const error = await rejection("pr_push");

		expect(error).toBeInstanceOf(ToolError);
		expect((error as Error).message).toBe("Current git repository is unavailable.");
	});

	it("rejects a push from a detached HEAD and says which parameter supplies the branch", async () => {
		vi.spyOn(git.repo, "root").mockResolvedValue(REPO_ROOT);
		vi.spyOn(git.branch, "current").mockResolvedValue(null);
		vi.spyOn(git.ref, "exists").mockRejectedValue(new Error("the ref was looked up"));

		const error = await rejection("pr_push");

		expect(error).toBeInstanceOf(ToolError);
		expect((error as Error).message).toBe("Current git branch is unavailable. Pass `branch` or `run` explicitly.");
	});

	it("takes an explicit branch instead of asking git for the current one", async () => {
		vi.spyOn(git.repo, "root").mockResolvedValue(REPO_ROOT);
		vi.spyOn(git.branch, "current").mockRejectedValue(new Error("the current branch was looked up"));
		vi.spyOn(git.ref, "exists").mockResolvedValue(false);

		const error = await rejection("pr_push", { branch: "topic" });

		expect(error).toBeInstanceOf(ToolError);
		expect((error as Error).message).toBe("local branch topic does not exist");
	});
});
