import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
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

describe("setCwd subagent cwd semantics", () => {
	it("spawn after parent setCwd inherits the new parent cwd", async () => {
		const parentStart = makeTempDir("@pi-sub-parent-start-");
		const parentNext = makeTempDir("@pi-sub-parent-next-");
		const parent = SessionManager.inMemory(parentStart);

		await parent.setCwd(parentNext, { validate: true });
		const spawnCwd = await resolveSpawnCwd(undefined, parent.getCwd());
		expect(spawnCwd).toBe(path.resolve(parentNext));

		const inheritCwd = await resolveSpawnCwd("inherit", parent.getCwd());
		expect(inheritCwd).toBe(path.resolve(parentNext));

		const child = SessionManager.inMemory(spawnCwd);
		expect(child.getCwd()).toBe(path.resolve(parentNext));
	});

	it("already-running child keeps its own cwd when parent setCwd later", async () => {
		const parentStart = makeTempDir("@pi-sub-run-parent-");
		const parentNext = makeTempDir("@pi-sub-run-parent-next-");
		const childStart = makeTempDir("@pi-sub-run-child-");

		const parent = SessionManager.inMemory(parentStart);
		const child = SessionManager.inMemory(childStart);

		// Child was spawned at the old parent cwd (or an explicit cwd) and is already running.
		expect(child.getCwd()).toBe(path.resolve(childStart));

		await parent.setCwd(parentNext, { validate: true });
		expect(parent.getCwd()).toBe(path.resolve(parentNext));
		expect(child.getCwd()).toBe(path.resolve(childStart));
	});

	it("child setCwd does not mutate the parent session cwd", async () => {
		const parentDir = makeTempDir("@pi-sub-child-parent-");
		const childDir = makeTempDir("@pi-sub-child-start-");
		const childNext = makeTempDir("@pi-sub-child-next-");

		const parent = SessionManager.inMemory(parentDir);
		const child = SessionManager.inMemory(childDir);

		await child.setCwd(childNext, { validate: true });
		expect(child.getCwd()).toBe(path.resolve(childNext));
		expect(parent.getCwd()).toBe(path.resolve(parentDir));
	});
});
