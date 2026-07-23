import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveSpawnCwd } from "@veyyon/coding-agent/task";
import { TempDir } from "@veyyon/utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("task cwd input via resolveSpawnCwd", () => {
	it("defaults / inherit to the parent session cwd", async () => {
		const parent = makeTempDir("@pi-task-cwd-parent-");
		expect(await resolveSpawnCwd(undefined, parent)).toBe(parent);
		expect(await resolveSpawnCwd("", parent)).toBe(parent);
		expect(await resolveSpawnCwd("inherit", parent)).toBe(parent);
		expect(await resolveSpawnCwd("  inherit  ", parent)).toBe(parent);
	});

	it("accepts an explicit absolute directory", async () => {
		const parent = makeTempDir("@pi-task-cwd-parent-");
		const explicit = makeTempDir("@pi-task-cwd-explicit-");
		expect(await resolveSpawnCwd(explicit, parent)).toBe(path.resolve(explicit));
	});

	it("resolves a relative path against the parent cwd (cd-from-parent semantics)", async () => {
		// A parent agent spawning a subagent in `libs/scanner/rulec` should land in
		// <parentCwd>/libs/scanner/rulec, not be rejected. This is the exact case
		// that used to fail with "task cwd must be absolute" and blocked per-crate
		// subagents from being addressed by their relative repo path.
		const parent = makeTempDir("@pi-task-cwd-parent-");
		const nested = path.join(parent, "libs", "scanner", "rulec");
		fs.mkdirSync(nested, { recursive: true });
		expect(await resolveSpawnCwd("libs/scanner/rulec", parent)).toBe(nested);
		// A leading ./ and a trailing slash resolve identically.
		expect(await resolveSpawnCwd("./libs/scanner/rulec/", parent)).toBe(nested);
	});

	it("resolves a relative parent-escaping path against the parent, not the process cwd", async () => {
		// `..` is resolved relative to the parent agent's cwd, matching a shell cd.
		const root = makeTempDir("@pi-task-cwd-root-");
		const sibling = path.join(root, "sibling");
		fs.mkdirSync(sibling, { recursive: true });
		const parent = path.join(root, "parent");
		fs.mkdirSync(parent, { recursive: true });
		expect(await resolveSpawnCwd("../sibling", parent)).toBe(sibling);
	});

	it("still accepts an explicit absolute directory unchanged", async () => {
		const parent = makeTempDir("@pi-task-cwd-parent-");
		const explicit = makeTempDir("@pi-task-cwd-explicit-");
		expect(await resolveSpawnCwd(explicit, parent)).toBe(path.resolve(explicit));
	});

	it("rejects nonexistent and non-directory paths loudly, for both absolute and relative", async () => {
		const parent = makeTempDir("@pi-task-cwd-parent-");
		const missing = path.join(parent, "missing-dir");
		await expect(resolveSpawnCwd(missing, parent)).rejects.toThrow(/task cwd does not exist/);

		// A relative path that does not resolve to a real dir fails closed too, and
		// the error names both the relative input and the parent it resolved against.
		await expect(resolveSpawnCwd("no/such/dir", parent)).rejects.toThrow(
			/task cwd does not exist:.*resolved from relative "no\/such\/dir" against/,
		);

		const filePath = path.join(parent, "file.txt");
		fs.writeFileSync(filePath, "x");
		await expect(resolveSpawnCwd(filePath, parent)).rejects.toThrow(/task cwd is not a directory/);
		// A relative path pointing at a file fails as a non-directory as well.
		await expect(resolveSpawnCwd("file.txt", parent)).rejects.toThrow(/task cwd is not a directory/);
	});
});
