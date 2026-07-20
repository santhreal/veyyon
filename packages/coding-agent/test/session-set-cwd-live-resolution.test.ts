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

describe("setCwd live path resolution", () => {
	it("resolves read/grep/bash relative paths against the new live session.cwd", async () => {
		const start = makeTempDir("@pi-live-start-");
		const next = makeTempDir("@pi-live-next-");
		fs.writeFileSync(path.join(start, "start-only.txt"), "start");
		fs.writeFileSync(path.join(next, "next-only.txt"), "next");

		const manager = SessionManager.inMemory(start);
		const session = toolSessionFromManager(manager);

		expect(resolveToCwd("start-only.txt", session.cwd)).toBe(path.join(path.resolve(start), "start-only.txt"));
		expect(resolveToCwd("next-only.txt", session.cwd)).toBe(path.join(path.resolve(start), "next-only.txt"));

		await session.setCwd?.(next, { validate: true });
		expect(session.cwd).toBe(path.resolve(next));
		expect(manager.getCwd()).toBe(path.resolve(next));

		// Same relative inputs now root under the new live cwd (ToolSession getter).
		expect(resolveToCwd("next-only.txt", session.cwd)).toBe(path.join(path.resolve(next), "next-only.txt"));
		expect(resolveToCwd("start-only.txt", session.cwd)).toBe(path.join(path.resolve(next), "start-only.txt"));
		expect(resolveToCwd(".", session.cwd)).toBe(path.resolve(next));
	});
});
