/**
 * The argot_load / argot_unload agent tools: load a folder's shorthand into the
 * live session, and stop teaching it again. These build a real temporary git repo
 * with recurring content (so the generator earns handles) and redirect the config
 * root into a temp directory, so nothing touches the real cache.
 *
 * Isolation note: this suite used to "redirect" by assigning `process.env.HOME`,
 * which does nothing. Bun resolves `os.homedir()` once at process start, so the
 * config root stayed under the developer's real home and every run wrote argot
 * cache entries into their ACTIVE profile. The working lever is
 * `VEYYON_CONFIG_DIR`, which the resolver joins onto the home directory: a
 * relative path back out of it lands the whole config root in the temp
 * directory. The redirect is then VERIFIED against the resolver's own output, so
 * a future change that breaks it fails here instead of silently polluting real
 * user data again. See docs/internal/testing.md.
 *
 * The tools exist to make the boundary model usable in a monorepo: an agent loads
 * the narrow crate it is working on, not the enclosing tree. The contract the tests
 * lock in: loading teaches a project's handles, a second load unions, unloading
 * stops teaching but never stops decoding (Law 10: dropping a folder must never
 * strip meaning from text already written), and a folder with no project marker is
 * a plain "nothing to load", not an error.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ArgotLoadTool, ArgotUnloadTool } from "@veyyon/coding-agent/tools/argot";
import { getArgotCacheDir, refreshDirsFromEnv, removeSyncWithRetries } from "@veyyon/utils";
import { ArgotSession, DEFAULT_TOKEN_BUDGET } from "argot";
import { makeToolSession } from "./helpers/tool-session";

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

/**
 * A minimal ToolSession exposing only what the two argot tools read: the cwd, the
 * session codec, and the settings the load tool consults for the dictionary
 * budget. `settings.get` answers the one key the tool reads and nothing else.
 */
function fakeSession(cwd: string, argot: ArgotSession | undefined): ToolSession {
	const settings = {
		get: (key: string) => (key === "argot.tokenBudget" ? DEFAULT_TOKEN_BUDGET : undefined),
	};
	return makeToolSession({ cwd, getArgotSession: () => argot, settings });
}

/** Pull the text of the tool's single content block. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const block = result.content.find(b => b.type === "text");
	return block?.text ?? "";
}

describe("argot_load / argot_unload tools", () => {
	let repoDir = "";
	let plainDir = "";
	let tempHomeDir = "";
	let originalConfigDir: string | undefined;

	beforeEach(() => {
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-tools-home-"));
		repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-tools-repo-"));
		plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-tools-plain-"));
		originalConfigDir = process.env.VEYYON_CONFIG_DIR;
		process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), tempHomeDir);
		refreshDirsFromEnv();

		// Proof, not intention: assert the resolver actually points into the temp
		// directory before a single cache entry is written. The previous version of this
		// setup looked correct and silently resolved to the real profile.
		const cacheDir = path.resolve(getArgotCacheDir());
		if (path.relative(tempHomeDir, cacheDir).startsWith("..")) {
			throw new Error(`argot cache not isolated: ${cacheDir} is outside ${tempHomeDir}`);
		}

		writeFile(repoDir, CONNECTION, "export const url = 'x';\n");
		writeFile(repoDir, ROUTES, `import '../database/connection.ts';\n// see ${CONNECTION}\n`);
		git(repoDir, "init", "-q");
		git(repoDir, "config", "user.email", "t@example.com");
		git(repoDir, "config", "user.name", "Test");
		git(repoDir, "add", "-A");
		git(repoDir, "commit", "-q", "-m", "init");
	});

	afterEach(() => {
		if (originalConfigDir === undefined) delete process.env.VEYYON_CONFIG_DIR;
		else process.env.VEYYON_CONFIG_DIR = originalConfigDir;
		refreshDirsFromEnv();
		for (const dir of [repoDir, plainDir, tempHomeDir]) if (dir) removeSyncWithRetries(dir);
	});

	it("teaches a loaded project's handles and expands them losslessly", async () => {
		const argot = new ArgotSession();
		const load = new ArgotLoadTool(fakeSession(repoDir, argot));
		const result = await load.execute("id", { folder_path: repoDir });

		// The result names the resolved root and a real handle count, not a shape check.
		expect(result.details?.root).toBe(repoDir);
		expect(result.details?.handles).toBeGreaterThan(0);
		expect(textOf(result)).toContain("Loaded Argot shorthand");

		// The recurring connection path earned a handle, taught in the fragment...
		const fragment = argot.promptFragment();
		expect(fragment).toContain(CONNECTION);
		// ...and the codec expands that exact handle back to the exact path.
		const match = fragment.match(/`§([a-z0-9_]+)`\s*→\s*`([^`]+)`/);
		expect(match).not.toBeNull();
		if (match) {
			const [, name, expansion] = match;
			expect(argot.expand(`§${name}`)).toBe(expansion);
		}
	});

	it("unloading stops teaching the handles but still decodes them (Law 10)", async () => {
		const argot = new ArgotSession();
		const session = fakeSession(repoDir, argot);
		await new ArgotLoadTool(session).execute("id", { folder_path: repoDir });

		// Grab a concrete handle the load taught, before unloading.
		const match = argot.promptFragment().match(/`§([a-z0-9_]+)`\s*→\s*`([^`]+)`/);
		expect(match).not.toBeNull();
		const [, name, expansion] = match ?? [];

		const unload = new ArgotUnloadTool(session);
		const result = await unload.execute("id", { folder_path: repoDir });
		expect(result.details?.root).toBe(repoDir);
		expect(result.details?.changed).toBe(true);
		expect(textOf(result)).toContain("Stopped teaching");

		// Teaching stopped: the fragment no longer carries the handle table.
		expect(argot.promptFragment()).toBe("");
		// Decoding stayed on: a handle the model already wrote still expands.
		if (name && expansion) {
			expect(argot.expand(`§${name}`)).toBe(expansion);
		}
	});

	it("unloading a folder that was never loaded changes nothing", async () => {
		const argot = new ArgotSession();
		const unload = new ArgotUnloadTool(fakeSession(repoDir, argot));
		const result = await unload.execute("id", { folder_path: repoDir });
		expect(result.details?.changed).toBe(false);
		expect(textOf(result)).toContain("was not loaded");
	});

	it("loading a folder with no project marker is a plain nothing-to-load, not an error", async () => {
		const argot = new ArgotSession();
		const load = new ArgotLoadTool(fakeSession(plainDir, argot));
		const result = await load.execute("id", { folder_path: plainDir });
		expect(result.details?.handles).toBe(0);
		expect(textOf(result)).toContain("No project marker");
		// Nothing was taught, because there was no project to teach.
		expect(argot.promptFragment()).toBe("");
	});

	it("fails loud when Argot is not enabled for the session", async () => {
		const load = new ArgotLoadTool(fakeSession(repoDir, undefined));
		await expect(load.execute("id", { folder_path: repoDir })).rejects.toThrow(/not enabled/);
	});

	it("requires a folder_path", async () => {
		const argot = new ArgotSession();
		const load = new ArgotLoadTool(fakeSession(repoDir, argot));
		await expect(load.execute("id", { folder_path: "  " })).rejects.toThrow(/folder_path is required/);
	});
});
