/**
 * WHY:
 *
 * Changes inspection actions (RefreshChanges, SelectChangeScope) previously ran raw porcelain status
 * without calculating unified diffs, addition/deletion line counts (numstat), rename source paths,
 * or separating staged vs working-tree scopes. SelectChangeScope also failed to immediately emit
 * refreshed snapshot updates for the panel.
 *
 * This test suite closes this defect class by driving the real GUI host protocol against a live
 * git repository with modified, staged, untracked, and renamed files, verifying:
 * - WorkingTree scope surfaces only unstaged modifications and untracked files with their line counts.
 * - Staged scope surfaces only staged additions, modifications, and renames with previous paths and line counts.
 * - Unified diffs are strictly isolated to the selected scope (WorkingTree shows unstaged diffs; Staged shows cached diffs).
 * - SelectChangeScope validates inputs and immediately pushes the refreshed Changes snapshot before acknowledging success.
 * - Workspaces without a git repository report repository: null, empty file lists, and empty diffs cleanly.
 *
 * Gap: Three-way merge conflicts during active interactive rebase are covered by dedicated VCS rebase test suites.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { ChangesView } from "../../src/gui-host/wire";
import { TestSocketClient } from "./test-client";

describe("a repository's changes switch between working tree and staged scopes", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-changes-test-"));

		// 1. Initialize git repo
		const initProc = Bun.spawn(["git", "init"], { cwd: tempDir, stdout: "ignore", stderr: "ignore" });
		await initProc.exited;

		const nameProc = Bun.spawn(["git", "config", "user.name", "Test User"], {
			cwd: tempDir,
			stdout: "ignore",
			stderr: "ignore",
		});
		await nameProc.exited;

		const emailProc = Bun.spawn(["git", "config", "user.email", "test@example.com"], {
			cwd: tempDir,
			stdout: "ignore",
			stderr: "ignore",
		});
		await emailProc.exited;

		// 2. Create initial committed files
		await fs.writeFile(path.join(tempDir, "modified.txt"), "line 1\nline 2\nline 3\n", "utf8");
		await fs.writeFile(path.join(tempDir, "staged.txt"), "staged 1\n", "utf8");
		await fs.writeFile(path.join(tempDir, "rename_me.txt"), "rename me content\n", "utf8");

		const addProc = Bun.spawn(["git", "add", "."], { cwd: tempDir, stdout: "ignore", stderr: "ignore" });
		await addProc.exited;

		const commitProc = Bun.spawn(["git", "commit", "-m", "initial commit"], {
			cwd: tempDir,
			stdout: "ignore",
			stderr: "ignore",
		});
		await commitProc.exited;

		// 3. Create working-tree modification (unstaged)
		// 1 line deleted (line 2), 2 lines added (line 2 modified, line 4)
		await fs.writeFile(path.join(tempDir, "modified.txt"), "line 1\nline 2 modified\nline 3\nline 4\n", "utf8");

		// 4. Create staged modification
		// 1 line added
		await fs.writeFile(path.join(tempDir, "staged.txt"), "staged 1\nstaged 2\n", "utf8");
		const stageProc = Bun.spawn(["git", "add", "staged.txt"], { cwd: tempDir, stdout: "ignore", stderr: "ignore" });
		await stageProc.exited;

		// 5. Create staged rename
		const renameProc = Bun.spawn(["git", "mv", "rename_me.txt", "renamed.txt"], {
			cwd: tempDir,
			stdout: "ignore",
			stderr: "ignore",
		});
		await renameProc.exited;

		// 6. Create untracked file (2 lines)
		await fs.writeFile(path.join(tempDir, "untracked.txt"), "untracked 1\nuntracked 2\n", "utf8");
	});

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
	});

	test("RefreshChanges and SelectChangeScope report exact files, additions/deletions, and isolated diffs", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		await client.nextFrame();
		await client.nextFrame();

		// 1. RefreshChanges with default WorkingTree scope
		const { frames: wtFrames, outcome: wtOutcome } = await client.request(1, "RefreshChanges");
		expect(wtOutcome).toEqual({ RequestSucceeded: { request: 1 } });

		const wtChanges = wtFrames.find(f => f.Snapshot?.Changes)?.Snapshot?.Changes as ChangesView;
		expect(wtChanges).toBeDefined();
		expect(wtChanges.repository).toBe(tempDir);
		expect(wtChanges.scope).toBe("WorkingTree");

		// Files under WorkingTree: modified.txt and untracked.txt
		expect(wtChanges.files).toEqual([
			{
				path: "modified.txt",
				previous_path: null,
				status: "Modified",
				additions: 2,
				deletions: 1,
			},
			{
				path: "untracked.txt",
				previous_path: null,
				status: "Untracked",
				additions: 2,
				deletions: 0,
			},
		]);

		// Diff under WorkingTree: contains modified.txt hunk only
		expect(wtChanges.diff).toContain("diff --git a/modified.txt b/modified.txt");
		expect(wtChanges.diff).toContain("+line 2 modified");
		expect(wtChanges.diff).toContain("-line 2");
		expect(wtChanges.diff).toContain("+line 4");
		expect(wtChanges.diff).not.toContain("staged.txt");
		expect(wtChanges.diff).not.toContain("renamed.txt");

		// 2. SelectChangeScope to "Staged"
		const { frames: stagedFrames, outcome: stagedOutcome } = await client.request(2, {
			SelectChangeScope: { scope: "Staged" },
		});
		expect(stagedOutcome).toEqual({ RequestSucceeded: { request: 2 } });

		const stagedChanges = stagedFrames.find(f => f.Snapshot?.Changes)?.Snapshot?.Changes as ChangesView;
		expect(stagedChanges).toBeDefined();
		expect(stagedChanges.repository).toBe(tempDir);
		expect(stagedChanges.scope).toBe("Staged");

		// Files under Staged: staged.txt and renamed.txt
		expect(stagedChanges.files).toEqual([
			{
				path: "renamed.txt",
				previous_path: "rename_me.txt",
				status: "Renamed",
				additions: 0,
				deletions: 0,
			},
			{
				path: "staged.txt",
				previous_path: null,
				status: "Modified",
				additions: 1,
				deletions: 0,
			},
		]);

		// Diff under Staged: contains staged.txt and renamed.txt, not modified.txt
		expect(stagedChanges.diff).toContain("diff --git a/staged.txt b/staged.txt");
		expect(stagedChanges.diff).toContain("+staged 2");
		expect(stagedChanges.diff).toContain("diff --git a/rename_me.txt b/renamed.txt");
		expect(stagedChanges.diff).not.toContain("modified.txt");
		expect(stagedChanges.diff).not.toContain("untracked.txt");

		// 3. SelectChangeScope with invalid scope fails with INVALID_ARGUMENTS in scope Change
		const { outcome: invalidOutcome } = await client.request(3, {
			SelectChangeScope: { scope: "InvalidScope" },
		});
		expect(invalidOutcome).toEqual({
			RequestFailed: {
				request: 3,
				error: expect.objectContaining({
					scope: "Change",
					code: "INVALID_ARGUMENTS",
					retryable: false,
				}),
			},
		});

		client.destroy();
	});

	test("RefreshChanges in non-git workspace reports repository: null and empty files/diff", async () => {
		const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-non-git-"));
		await fs.writeFile(path.join(nonGitDir, "hello.txt"), "hello\n", "utf8");

		const nonGitServer = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: nonGitDir,
		});
		const client = await TestSocketClient.connect(nonGitServer.endpoint);

		await client.nextFrame();
		await client.nextFrame();

		const { frames, outcome } = await client.request(1, "RefreshChanges");
		expect(outcome).toEqual({ RequestSucceeded: { request: 1 } });

		const changes = frames.find(f => f.Snapshot?.Changes)?.Snapshot?.Changes as ChangesView;
		expect(changes).toEqual({
			revision: expect.any(Number),
			repository: null,
			scope: "WorkingTree",
			files: [],
			diff: "",
		});

		client.destroy();
		await nonGitServer.close();
		await fs.rm(nonGitDir, { recursive: true, force: true });
	});
});
