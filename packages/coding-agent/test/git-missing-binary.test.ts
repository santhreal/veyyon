import { afterEach, describe, expect, test, spyOn } from "bun:test";
import * as git from "../src/utils/git";

function throwSpawnEnoent(): never {
	const err = new Error('Executable not found in $PATH: "git"');
	(err as NodeJS.ErrnoException).code = "ENOENT";
	throw err;
}

let spawnSpy: any;

afterEach(() => {
	if (spawnSpy) {
		spawnSpy.mockRestore();
		spawnSpy = undefined;
	}
});

describe("git helpers with git binary absent (#6169)", () => {
	test("status.summary degrades to null instead of throwing ENOENT", async () => {
		spawnSpy = spyOn(Bun, "spawn").mockImplementation(throwSpawnEnoent as any);
		expect(await git.status.summary("/")).toBeNull();
	});

	test("diff.has surfaces a clean ToolError instead of a raw ENOENT rejection", async () => {
		spawnSpy = spyOn(Bun, "spawn").mockImplementation(throwSpawnEnoent as any);
		await expect(git.diff.has("/")).rejects.toThrow("git is not installed.");
	});

	test("repo.root degrades to null instead of throwing ENOENT", async () => {
		spawnSpy = spyOn(Bun, "spawn").mockImplementation(throwSpawnEnoent as any);
		expect(await git.repo.root("/")).toBeNull();
	});

	test("re-raises non-ENOENT spawn failures", async () => {
		spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
			const err = new Error("EACCES: permission denied");
			(err as NodeJS.ErrnoException).code = "EACCES";
			throw err;
		});
		await expect(git.status.summary("/")).rejects.toThrow("EACCES");
	});
});
