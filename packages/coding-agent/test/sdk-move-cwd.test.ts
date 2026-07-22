import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@veyyon/catalog/models";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter(
				(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
			)
			.map(block => block.text)
			.join("\n") ?? ""
	);
}

describe("createAgentSession cwd after /move", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("runs tools from the moved session directory", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-move-cwd-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, path.join(tempDir, "sessions"));
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["bash"],
		});

		try {
			await sessionManager.moveTo(cwdB);

			const bashTool = session.getToolByName("bash");
			if (!bashTool) throw new Error("Expected bash tool");
			const result = await bashTool.execute("pwd-after-move", { command: "pwd" });

			expect(textContent(result)).toContain(cwdB);
		} finally {
			await session.dispose();
		}
	});
});

// WHY THIS SUITE EXISTS (BACKLOG DOG-R2-8: the "false failure" report)
// -------------------------------------------------------------------
// The session cwd is the SINGLE authority every tool resolves against
// (`resolveToCwd(path, session.cwd)`). `SessionManager.setCwd`/`moveTo` used to
// resolve a relative target with bare `path.resolve(target)`, whose hidden base is
// `process.cwd()` (the OS process dir), NOT the session cwd. When those two bases
// differed, a relative `set_cwd` could validate one directory while the tools
// pointed at another — the dogfood report where `set_cwd home/x` returned
// "Directory does not exist" yet bash/eval still moved. These tests pin the base
// to the session cwd and prove validation never mutates on failure.
describe("SessionManager.setCwd single cwd authority", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	function freshRoot(): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-setcwd-auth-${Snowflake.next()}-`));
		tempDirs.push(root);
		return root;
	}

	it("resolves a relative target against the session cwd, not process.cwd()", async () => {
		const root = freshRoot();
		const child = path.join(root, "child");
		fs.mkdirSync(child, { recursive: true });
		// Guard the premise: the process cwd is NOT the session root, and the process
		// cwd has no "child", so a `process.cwd()`-based resolve would 404 or misfire.
		expect(path.resolve(process.cwd())).not.toBe(path.resolve(root));
		expect(fs.existsSync(path.join(process.cwd(), "child"))).toBe(false);

		const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
		const resolved = await sessionManager.setCwd("child");

		expect(resolved).toBe(child);
		expect(sessionManager.getCwd()).toBe(child);
	});

	it("resolves `..` against the session cwd", async () => {
		const root = freshRoot();
		const child = path.join(root, "child");
		fs.mkdirSync(child, { recursive: true });

		const sessionManager = SessionManager.create(child, path.join(root, "sessions"));
		const resolved = await sessionManager.setCwd("..");

		expect(resolved).toBe(path.resolve(root));
		expect(sessionManager.getCwd()).toBe(path.resolve(root));
	});

	it("an absolute target ignores the session cwd base", async () => {
		const root = freshRoot();
		const other = path.join(root, "other");
		fs.mkdirSync(other, { recursive: true });

		const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
		const resolved = await sessionManager.setCwd(other);

		expect(resolved).toBe(other);
		expect(sessionManager.getCwd()).toBe(other);
	});

	it("a failed validation leaves the session cwd UNCHANGED (no false-failure-with-mutation)", async () => {
		const root = freshRoot();
		const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
		const before = sessionManager.getCwd();

		// Relative miss: names the absolute path under the SESSION cwd, and does not move.
		await expect(sessionManager.setCwd("no-such-dir")).rejects.toThrow(
			new RegExp(
				`Directory does not exist: ${path.join(root, "no-such-dir").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
			),
		);
		expect(sessionManager.getCwd()).toBe(before);
	});
});
