import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { SetCwdTool } from "@veyyon/coding-agent/tools/set-cwd";
import { ToolError } from "@veyyon/coding-agent/tools/tool-errors";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

/**
 * SetCwdTool: successful re-root, reject file/missing, exact previous/cwd details.
 */

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

describe("SetCwdTool adversarial", () => {
	let tmpDir: string;
	let child: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "setcwd-tool-"));
		child = path.join(tmpDir, "child");
		await fs.mkdir(child);
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function sessionWithManager() {
		const manager = SessionManager.inMemory(tmpDir);
		const session = makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			settings: Settings.isolated({}),
			getSessionSpawns: () => "*",
			setCwd: (resolved, options) => manager.setCwd(resolved, options),
		});
		// Keep tool session cwd getter in sync with manager.
		Object.defineProperty(session, "cwd", {
			get: () => manager.getCwd(),
			configurable: true,
		});
		return { session, manager };
	}

	it("re-roots to a child directory and reports previous + new cwd", async () => {
		const { session, manager } = sessionWithManager();
		const tool = new SetCwdTool(session as never);
		const result = await tool.execute("s1", { path: child });
		expect(manager.getCwd()).toBe(path.resolve(child));
		const details = result.details as { previous: string; cwd: string; requested: string };
		expect(path.resolve(details.previous)).toBe(path.resolve(tmpDir));
		expect(path.resolve(details.cwd)).toBe(path.resolve(child));
		expect(details.requested).toBe(child);
		const text = textOf(result);
		expect(text.length).toBeGreaterThan(0);
	});

	it("rejects a file path with ToolError and leaves cwd unchanged", async () => {
		const filePath = path.join(tmpDir, "file.txt");
		await Bun.write(filePath, "x");
		const { session, manager } = sessionWithManager();
		const before = manager.getCwd();
		const tool = new SetCwdTool(session as never);
		await expect(tool.execute("s2", { path: filePath })).rejects.toThrow(ToolError);
		expect(manager.getCwd()).toBe(before);
	});

	it("rejects a missing directory and leaves cwd unchanged", async () => {
		const missing = path.join(tmpDir, "gone");
		const { session, manager } = sessionWithManager();
		const before = manager.getCwd();
		const tool = new SetCwdTool(session as never);
		await expect(tool.execute("s3", { path: missing })).rejects.toThrow();
		expect(manager.getCwd()).toBe(before);
	});

	it("relative path resolves against current session cwd", async () => {
		const { session, manager } = sessionWithManager();
		const tool = new SetCwdTool(session as never);
		await tool.execute("s4", { path: "child" });
		expect(manager.getCwd()).toBe(path.resolve(child));
	});

	// Regression for BUG-CWD-REROOT-ARGOT-LEAK-DEFAULT (second site: the tool's own
	// description). set_cwd is registered unconditionally, so its description is in
	// the tool schema on every session. The `argot_load` advice must be gated on
	// `argot.enabled` (off by default) or it advertises a tool absent from the
	// default toolset. The gate is a `{{#if argot}}` block rendered against the
	// session's setting in the constructor.
	describe("description gates the argot_load advice on argot.enabled", () => {
		function toolWithArgot(enabled: boolean) {
			const manager = SessionManager.inMemory(tmpDir);
			const session = makeToolSession({
				cwd: tmpDir,
				hasUI: false,
				getSessionFile: () => null,
				settings: Settings.isolated({ "argot.enabled": enabled }),
				getSessionSpawns: () => "*",
				setCwd: (resolved, options) => manager.setCwd(resolved, options),
			});
			return new SetCwdTool(session as never);
		}

		it("omits argot_load from the description when argot is off (the default)", () => {
			expect(toolWithArgot(false).description).not.toMatch(/argot/i);
		});

		it("includes the argot_load advice when argot is on", () => {
			const description = toolWithArgot(true).description;
			expect(description).toContain("argot_load");
			expect(description).toContain("Argot shorthand");
		});
	});
});
