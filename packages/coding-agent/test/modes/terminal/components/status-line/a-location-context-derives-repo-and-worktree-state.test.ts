/**
 * WHY:
 * Status line rendering needs filesystem-only location facts (active repository context,
 * effective git working directory, and linked worktree structure) across launch and mounted states.
 * This test defends the contract that resolveLocationContext derives these facts accurately across
 * all observable workspace topologies:
 * 1. An ordinary unversioned directory with no repository.
 * 2. A parent workspace containing a single direct child repository.
 * 3. A linked git worktree with primary checkout references.
 * 4. A standard git repository root.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type LocationContext,
	resolveLocationContext,
} from "@veyyon/coding-agent/modes/terminal/components/status-line/location-context";

function createGitDirectory(repoRoot: string): void {
	const gitDir = path.join(repoRoot, ".git");
	fs.mkdirSync(gitDir, { recursive: true });
	fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
}

function createLinkedWorktree(worktreeRoot: string, primaryRoot: string, branchName: string): void {
	const gitDir = path.join(primaryRoot, ".git", "worktrees", path.basename(worktreeRoot));
	const commonDir = path.join(primaryRoot, ".git");
	fs.mkdirSync(worktreeRoot, { recursive: true });
	fs.mkdirSync(gitDir, { recursive: true });
	fs.mkdirSync(commonDir, { recursive: true });
	fs.writeFileSync(path.join(commonDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
	fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/${branchName}\n`, "utf8");
	fs.writeFileSync(path.join(gitDir, "commondir"), `${path.relative(gitDir, commonDir)}\n`, "utf8");
	fs.writeFileSync(path.join(worktreeRoot, ".git"), `gitdir: ${path.relative(worktreeRoot, gitDir)}\n`, "utf8");
}

describe("a location context derives repo and worktree state", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-location-context-"));
	});

	afterEach(() => {
		fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	it("derives empty repo and worktree context for an ordinary unversioned directory", () => {
		const projectDir = path.join(tempRoot, "plain-dir");
		fs.mkdirSync(projectDir, { recursive: true });

		const context: LocationContext = resolveLocationContext(projectDir);
		expect(context).toEqual({
			projectDir,
			activeRepo: null,
			effectiveGitCwd: projectDir,
			worktree: null,
		});
	});

	it("derives activeRepo and shifts effectiveGitCwd for a parent with a single child repo", () => {
		const projectDir = path.join(tempRoot, "workspace");
		const childRepo = path.join(projectDir, "app-backend");
		fs.mkdirSync(childRepo, { recursive: true });
		createGitDirectory(childRepo);

		const context: LocationContext = resolveLocationContext(projectDir);
		expect(context).toEqual({
			projectDir,
			activeRepo: {
				cwd: projectDir,
				repoRoot: childRepo,
				relativeRepoRoot: "app-backend",
				source: "single-direct-child-repo",
			},
			effectiveGitCwd: childRepo,
			worktree: null,
		});
	});

	it("derives linked worktree metadata and keeps effectiveGitCwd for a worktree directory", () => {
		const primaryRoot = path.join(tempRoot, "monorepo");
		const worktreeRoot = path.join(tempRoot, "monorepo-feature-ui");
		createLinkedWorktree(worktreeRoot, primaryRoot, "feature-ui");

		const context: LocationContext = resolveLocationContext(worktreeRoot);
		expect(context).toEqual({
			projectDir: worktreeRoot,
			activeRepo: null,
			effectiveGitCwd: worktreeRoot,
			worktree: {
				projectName: "monorepo",
				worktreeName: "monorepo-feature-ui",
			},
		});
	});

	it("derives clean context with effectiveGitCwd matching projectDir for a direct git repo", () => {
		const repoRoot = path.join(tempRoot, "standalone-repo");
		fs.mkdirSync(repoRoot, { recursive: true });
		createGitDirectory(repoRoot);

		const context: LocationContext = resolveLocationContext(repoRoot);
		expect(context).toEqual({
			projectDir: repoRoot,
			activeRepo: null,
			effectiveGitCwd: repoRoot,
			worktree: null,
		});
	});
});
