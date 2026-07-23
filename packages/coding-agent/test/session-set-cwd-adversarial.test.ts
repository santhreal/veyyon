import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { resolveToCwd } from "@veyyon/coding-agent/tools/path-utils";
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

function toolSessionFromManager(manager: SessionManager): ToolSession {
	return {
		get cwd() {
			return manager.getCwd();
		},
		setCwd: (resolvedPath, options) => manager.setCwd(resolvedPath, options),
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};
}

describe("setCwd adversarial cases", () => {
	it("rejects setCwd to a file path", async () => {
		const start = makeTempDir("@pi-adv-file-start-");
		const filePath = path.join(start, "file.txt");
		fs.writeFileSync(filePath, "x");
		const manager = SessionManager.inMemory(start);
		await expect(manager.setCwd(filePath, { validate: true })).rejects.toThrow(/Not a directory/);
		expect(manager.getCwd()).toBe(path.resolve(start));
	});

	it("rejects setCwd to a nonexistent path", async () => {
		const start = makeTempDir("@pi-adv-missing-start-");
		const missing = path.join(start, "gone");
		const manager = SessionManager.inMemory(start);
		await expect(manager.setCwd(missing, { validate: true })).rejects.toThrow(/Directory does not exist/);
		expect(manager.getCwd()).toBe(path.resolve(start));
	});

	it("allows setCwd outside the profile/agent directory when the target exists", async () => {
		const profileRoot = makeTempDir("@pi-adv-profile-");
		const agentDir = path.join(profileRoot, "agent");
		const projectDir = path.join(profileRoot, "project");
		const outside = makeTempDir("@pi-adv-outside-");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });

		const manager = SessionManager.inMemory(projectDir);
		const resolved = await manager.setCwd(outside, { validate: true });
		expect(resolved).toBe(path.resolve(outside));
		expect(manager.getCwd()).toBe(path.resolve(outside));
		// Outside the profile tree is intentional — setCwd is session-scoped, not sandboxed to agentDir.
		expect(manager.getCwd().startsWith(path.resolve(profileRoot) + path.sep)).toBe(false);
	});

	it("pins concurrent setCwd during in-flight bash: spawn cwd stays captured; later resolves re-root", async () => {
		const start = makeTempDir("@pi-adv-bash-start-");
		const next = makeTempDir("@pi-adv-bash-next-");
		fs.writeFileSync(path.join(start, "a.txt"), "a");
		fs.writeFileSync(path.join(next, "b.txt"), "b");

		const manager = SessionManager.inMemory(start);
		const session = toolSessionFromManager(manager);

		// Mirror bash.ts: commandCwd is captured once at execute start from the live session.cwd.
		const commandCwd = session.cwd;
		expect(commandCwd).toBe(path.resolve(start));

		// Concurrent setCwd while that bash is still "in flight".
		await session.setCwd?.(next, { validate: true });
		expect(session.cwd).toBe(path.resolve(next));

		// In-flight bash keeps the captured spawn cwd.
		expect(commandCwd).toBe(path.resolve(start));
		expect(resolveToCwd("a.txt", commandCwd)).toBe(path.join(path.resolve(start), "a.txt"));

		// Subsequent tool resolves use the new live session.cwd (getter re-roots).
		expect(resolveToCwd("b.txt", session.cwd)).toBe(path.join(path.resolve(next), "b.txt"));
		expect(resolveToCwd("a.txt", session.cwd)).toBe(path.join(path.resolve(next), "a.txt"));
	});

	it("setCwd to the same directory is a no-op success returning that path", async () => {
		const start = makeTempDir("@pi-adv-same-");
		const manager = SessionManager.inMemory(start);
		const resolved = await manager.setCwd(start, { validate: true });
		expect(resolved).toBe(path.resolve(start));
		expect(manager.getCwd()).toBe(path.resolve(start));
	});

	it("setCwd into a nested child directory succeeds and updates getCwd", async () => {
		const start = makeTempDir("@pi-adv-nested-");
		const child = path.join(start, "child");
		fs.mkdirSync(child, { recursive: true });
		const manager = SessionManager.inMemory(start);
		const resolved = await manager.setCwd(child, { validate: true });
		expect(resolved).toBe(path.resolve(child));
		expect(manager.getCwd()).toBe(path.resolve(child));
	});

	it("setCwd back to the previous directory after a nested change", async () => {
		const start = makeTempDir("@pi-adv-back-");
		const child = path.join(start, "sub");
		fs.mkdirSync(child, { recursive: true });
		const manager = SessionManager.inMemory(start);
		await manager.setCwd(child, { validate: true });
		expect(manager.getCwd()).toBe(path.resolve(child));
		await manager.setCwd(start, { validate: true });
		expect(manager.getCwd()).toBe(path.resolve(start));
	});

	it("failed setCwd leaves getCwd unchanged after a prior successful change", async () => {
		const start = makeTempDir("@pi-adv-fail-leave-");
		const good = path.join(start, "good");
		fs.mkdirSync(good, { recursive: true });
		const manager = SessionManager.inMemory(start);
		await manager.setCwd(good, { validate: true });
		const before = manager.getCwd();
		await expect(manager.setCwd(path.join(start, "missing-dir"), { validate: true })).rejects.toThrow(
			/Directory does not exist/,
		);
		expect(manager.getCwd()).toBe(before);
	});
});
