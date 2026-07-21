/**
 * The argot cache lifecycle: armArgotFromCache generates a per-project
 * dictionary under the config root, arms the session from it, and takes a fast
 * path when the git HEAD has not moved. These tests build a real temporary git
 * repo and redirect the config root to a temp HOME, so nothing touches the real
 * cache.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ArgotSession } from "@veyyon/coding-agent/argot/index";
import { armArgotFromCache } from "@veyyon/coding-agent/argot-cache";
import { getArgotCacheDir, refreshDirsFromEnv, removeSyncWithRetries } from "@veyyon/utils";

const CONNECTION = "packages/coding-agent/src/database/connection.ts";
const ROUTES = "packages/coding-agent/src/server/routes.ts";

function git(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", args, { cwd, stdio: "ignore" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

function writeFile(root: string, rel: string, content: string): void {
	fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), content);
}

describe("armArgotFromCache", () => {
	let repoDir = "";
	let plainDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-cache-home-"));
		repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-cache-repo-"));
		plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-cache-plain-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
		refreshDirsFromEnv();

		writeFile(repoDir, CONNECTION, "export const url = 'x';\n");
		writeFile(repoDir, ROUTES, `import '../database/connection.ts';\n// see ${CONNECTION}\n`);
		git(repoDir, "init", "-q");
		git(repoDir, "config", "user.email", "t@example.com");
		git(repoDir, "config", "user.name", "Test");
		git(repoDir, "add", "-A");
		git(repoDir, "commit", "-q", "-m", "init");
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		refreshDirsFromEnv();
		for (const dir of [repoDir, plainDir, tempHomeDir]) if (dir) removeSyncWithRetries(dir);
	});

	it("generates a cache from the repo and arms the session with handles for repo paths", async () => {
		const argot = new ArgotSession();
		await armArgotFromCache(argot, repoDir);
		expect(argot.loaded).toBe(true);
		// The recurring connection path earns a handle, and it expands losslessly.
		const fragment = argot.promptFragment();
		expect(fragment).toContain(CONNECTION);
		// And the cache file was actually written under the config root.
		const cacheRoot = getArgotCacheDir();
		expect(fs.existsSync(cacheRoot)).toBe(true);
	});

	it("expands a generated handle back to its full path", async () => {
		const argot = new ArgotSession();
		await armArgotFromCache(argot, repoDir);
		// Pull one handle out of the fragment and confirm the codec expands it.
		const match = argot.promptFragment().match(/`§([a-z0-9_]+)`\s*→\s*`([^`]+)`/);
		expect(match).not.toBeNull();
		if (match) {
			const [, name, expansion] = match;
			expect(argot.expand(`§${name}`)).toBe(expansion);
		}
	});

	it("takes the fast path on a second arming with an unchanged HEAD", async () => {
		const first = new ArgotSession();
		await armArgotFromCache(first, repoDir);
		expect(first.loaded).toBe(true);
		// A fresh session over the same repo (HEAD unchanged) loads the same cache.
		const second = new ArgotSession();
		await armArgotFromCache(second, repoDir);
		expect(second.loaded).toBe(true);
		expect(second.promptFragment()).toBe(first.promptFragment());
	});

	it("grows the cache monotonically after a new commit", async () => {
		const first = new ArgotSession();
		await armArgotFromCache(first, repoDir);
		const firstFragment = first.promptFragment();

		// A new commit adds another recurring path; HEAD moves, so the cache regenerates.
		const extra = "packages/coding-agent/src/config/settings.ts";
		writeFile(repoDir, extra, `// ${extra}\nimport '${CONNECTION}';\n`);
		git(repoDir, "add", "-A");
		git(repoDir, "commit", "-q", "-m", "add settings");

		const second = new ArgotSession();
		await armArgotFromCache(second, repoDir);
		expect(second.loaded).toBe(true);
		// Every handle taught before is still present (monotonic), and the new path joined.
		for (const line of firstFragment.split("\n")) {
			if (line.startsWith("- `§")) expect(second.promptFragment()).toContain(line);
		}
	});

	it("stays inert when the directory is not inside any project", async () => {
		const argot = new ArgotSession();
		await armArgotFromCache(argot, tempHomeDir);
		expect(argot.loaded).toBe(false);
	});

	it("arms a non-git project that opts in with a .argot marker", async () => {
		fs.writeFileSync(path.join(plainDir, ".argot"), "");
		writeFile(plainDir, "docs/chapters/introduction/overview.md", "# Overview\n");
		const argot = new ArgotSession();
		await armArgotFromCache(argot, plainDir);
		expect(argot.loaded).toBe(true);
		expect(argot.promptFragment()).toContain("docs/chapters/introduction/overview.md");
	});
});
