import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { SetCwdTool } from "@veyyon/coding-agent/tools/set-cwd";
import { TempDir } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(d => d.remove()));
});

describe("SetCwdTool relative and parent adversarial", () => {
	it("set_cwd .. from a child returns to parent", async () => {
		const root = makeTempDir("@scwd-root-");
		const child = path.join(root, "child");
		fs.mkdirSync(child, { recursive: true });
		const manager = SessionManager.inMemory(child);
		const session = makeToolSession({
			cwd: child,
			hasUI: false,
			getSessionFile: () => null,
			settings: Settings.isolated({}),
			setCwd: (p, o) => manager.setCwd(p, o),
		});
		Object.defineProperty(session, "cwd", {
			get: () => manager.getCwd(),
			configurable: true,
		});
		const tool = new SetCwdTool(session as never);
		await tool.execute("up", { path: ".." });
		expect(manager.getCwd()).toBe(path.resolve(root));
	});

	it("set_cwd . is a successful no-op at the same path", async () => {
		const root = makeTempDir("@scwd-dot-");
		const manager = SessionManager.inMemory(root);
		const session = makeToolSession({
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			settings: Settings.isolated({}),
			setCwd: (p, o) => manager.setCwd(p, o),
		});
		Object.defineProperty(session, "cwd", {
			get: () => manager.getCwd(),
			configurable: true,
		});
		const before = manager.getCwd();
		const tool = new SetCwdTool(session as never);
		await tool.execute("dot", { path: "." });
		expect(manager.getCwd()).toBe(before);
	});
});
