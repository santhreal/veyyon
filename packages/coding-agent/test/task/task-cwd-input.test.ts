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

	it("rejects relative paths loudly", async () => {
		const parent = makeTempDir("@pi-task-cwd-parent-");
		await expect(resolveSpawnCwd("relative/path", parent)).rejects.toThrow(
			/task cwd must be absolute or "inherit"/,
		);
	});

	it("rejects nonexistent and non-directory paths loudly", async () => {
		const parent = makeTempDir("@pi-task-cwd-parent-");
		const missing = path.join(parent, "missing-dir");
		await expect(resolveSpawnCwd(missing, parent)).rejects.toThrow(/task cwd does not exist/);

		const filePath = path.join(parent, "file.txt");
		fs.writeFileSync(filePath, "x");
		await expect(resolveSpawnCwd(filePath, parent)).rejects.toThrow(/task cwd is not a directory/);
	});
});
