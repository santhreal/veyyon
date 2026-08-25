/**
 * WHY THIS SUITE EXISTS (FINDING-CWD-BOUNDARY-DELIMITED-ESCAPE):
 *
 * The filesystem cwd boundary (cwd-boundary.ts) ensures that any tool call touching
 * a path outside the session working directory prompts for permission in every
 * non-yolo approval mode.
 *
 * Previously, `readFilesystemTargets` in read.ts and `searchPathFilesystemTargets`
 * in cwd-boundary.ts split the path argument ONLY on semicolons when measuring targets
 * for boundary containment. The execution path (`splitDelimitedPathEntry` and
 * `expandDelimitedPathEntries`), however, additionally splits on commas and whitespace.
 *
 * Consequently, a call such as `read({ path: "package.json, /etc/passwd" })` or
 * `grep({ path: "src, /etc" })` was measured by the boundary check as a single lexical
 * string inside cwd, auto-approving in `ask-command`, `plan`, or `auto-edit` modes.
 * At execution time, the tool then split on the comma and accessed the out-of-cwd path
 * without prompt.
 *
 * This suite defends the invariant:
 * In every non-yolo approval mode, ANY delimited argument (comma, comma with spaces,
 * whitespace, or semicolon) that includes at least one target escaping cwd MUST require
 * permission and be blocked by the cwd boundary.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getThemeByName } from "@veyyon/coding-agent/modes/theme/theme";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { readToolRenderer } from "@veyyon/coding-agent/tools/read";
import { shortenPath } from "@veyyon/coding-agent/tools/render-utils";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

describe("a delimited path escaping cwd requires approval", () => {
	let tempDir: string;
	let cwd: string;
	let insideFile1: string;
	let insideFile2: string;
	let outsideFile: string;
	let sessionManager: SessionManager;
	let session: AgentSession;

	const BASE_SETTINGS = {
		"async.enabled": false,
		"bash.autoBackground.enabled": false,
		"bashInterceptor.enabled": false,
	} as const;

	beforeAll(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-delimited-boundary-${Snowflake.next()}-`));
		cwd = path.join(tempDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });

		insideFile1 = path.join(cwd, "inside1.txt");
		fs.writeFileSync(insideFile1, "INSIDE_ONE");
		insideFile2 = path.join(cwd, "inside2.txt");
		fs.writeFileSync(insideFile2, "INSIDE_TWO");

		outsideFile = path.join(tempDir, "outside.txt");
		fs.writeFileSync(outsideFile, "OUTSIDE_CONTENT");

		sessionManager = SessionManager.create(cwd, path.join(tempDir, "sessions"));
		const created = await createAgentSession({
			cwd,
			agentDir: tempDir,
			sessionManager,
			authStorage: await AuthStorage.create(path.join(tempDir, "auth.db")),
			settings: Settings.isolated(BASE_SETTINGS),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "grep", "glob"],
		});
		session = created.session;
	});

	afterAll(async () => {
		await session.dispose();
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				removeSyncWithRetries(tempDir);
				break;
			} catch (err) {
				const errObj = err && typeof err === "object" ? err : {};
				const code = "code" in errObj && typeof errObj.code === "string" ? errObj.code : "";
				if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") throw err;
				if (attempt === 4) break;
				await Bun.sleep(50 * (attempt + 1));
			}
		}
	});

	function ctx(extraSettings: Record<string, unknown> = {}): AgentToolContext {
		return {
			settings: Settings.isolated({ ...BASE_SETTINGS, ...extraSettings }),
			sessionManager,
		} as AgentToolContext;
	}

	function tool(name: "read" | "grep" | "glob") {
		const t = session.getToolByName(name);
		if (!t) throw new Error(`expected ${name} tool`);
		return t;
	}

	function textOf(result: { content?: ReadonlyArray<{ type: string; text?: string }> }): string {
		for (const block of result.content ?? []) {
			if (block.type === "text" && typeof block.text === "string") return block.text;
		}
		return "";
	}

	it("auto-approves in-cwd delimited reads across all delimiter types", async () => {
		// Comma
		const commaResult = await tool("read").execute(
			"read-in-comma",
			{ path: "inside1.txt, inside2.txt" },
			undefined,
			undefined,
			ctx({ "tools.approvalMode": "ask-command" }),
		);
		expect(textOf(commaResult)).toContain("INSIDE_ONE");
		expect(textOf(commaResult)).toContain("INSIDE_TWO");

		// Semicolon
		const semiResult = await tool("read").execute(
			"read-in-semi",
			{ path: "inside1.txt;inside2.txt" },
			undefined,
			undefined,
			ctx({ "tools.approvalMode": "ask-command" }),
		);
		expect(textOf(semiResult)).toContain("INSIDE_ONE");
		expect(textOf(semiResult)).toContain("INSIDE_TWO");

		// Whitespace
		const wsResult = await tool("read").execute(
			"read-in-ws",
			{ path: "inside1.txt inside2.txt" },
			undefined,
			undefined,
			ctx({ "tools.approvalMode": "ask-command" }),
		);
		expect(textOf(wsResult)).toContain("INSIDE_ONE");
		expect(textOf(wsResult)).toContain("INSIDE_TWO");
	});

	it("blocks comma-delimited read mixing in-cwd and out-of-cwd targets in non-yolo modes", async () => {
		await expect(
			tool("read").execute(
				"read-out-comma",
				{ path: `inside1.txt, ${outsideFile}` },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "ask-command" }),
			),
		).rejects.toThrow(/outside the session working directory/);

		await expect(
			tool("read").execute(
				"read-out-comma-plan",
				{ path: `inside1.txt, ${outsideFile}` },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "plan" }),
			),
		).rejects.toThrow(/outside the session working directory/);

		await expect(
			tool("read").execute(
				"read-out-comma-autoedit",
				{ path: `inside1.txt, ${outsideFile}` },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "auto-edit" }),
			),
		).rejects.toThrow(/outside the session working directory/);
	});

	it("blocks comma-delimited with surrounding spaces read mixing in-cwd and out-of-cwd targets", async () => {
		await expect(
			tool("read").execute(
				"read-out-comma-spaces",
				{ path: `inside1.txt , ${outsideFile}` },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "ask-command" }),
			),
		).rejects.toThrow(/outside the session working directory/);
	});

	it("blocks whitespace-separated read mixing in-cwd and out-of-cwd targets", async () => {
		await expect(
			tool("read").execute(
				"read-out-ws",
				{ path: `inside1.txt ${outsideFile}` },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "ask-command" }),
			),
		).rejects.toThrow(/outside the session working directory/);
	});

	it("blocks semicolon-delimited read mixing in-cwd and out-of-cwd targets", async () => {
		await expect(
			tool("read").execute(
				"read-out-semi",
				{ path: `inside1.txt;${outsideFile}` },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "ask-command" }),
			),
		).rejects.toThrow(/outside the session working directory/);
	});

	it("allows delimited out-of-cwd reads in yolo mode", async () => {
		const result = await tool("read").execute(
			"read-out-yolo",
			{ path: `inside1.txt, ${outsideFile}` },
			undefined,
			undefined,
			ctx({ "tools.approvalMode": "yolo" }),
		);
		expect(textOf(result)).toContain("INSIDE_ONE");
		expect(textOf(result)).toContain("OUTSIDE_CONTENT");
	});

	it("blocks delimited search paths escaping cwd across comma, whitespace, and semicolon in grep", async () => {
		// Comma
		await expect(
			tool("grep").execute(
				"grep-out-comma",
				{ pattern: "CONTENT", path: `inside1.txt, ${outsideFile}` },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "ask-command" }),
			),
		).rejects.toThrow(/outside the session working directory/);

		// Comma with spaces
		await expect(
			tool("grep").execute(
				"grep-out-comma-spaces",
				{ pattern: "CONTENT", path: `inside1.txt , ${outsideFile}` },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "ask-command" }),
			),
		).rejects.toThrow(/outside the session working directory/);

		// Whitespace
		await expect(
			tool("grep").execute(
				"grep-out-ws",
				{ pattern: "CONTENT", path: `inside1.txt ${outsideFile}` },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "ask-command" }),
			),
		).rejects.toThrow(/outside the session working directory/);

		// Semicolon
		await expect(
			tool("grep").execute(
				"grep-out-semi",
				{ pattern: "CONTENT", path: `inside1.txt;${outsideFile}` },
				undefined,
				undefined,
				ctx({ "tools.approvalMode": "ask-command" }),
			),
		).rejects.toThrow(/outside the session working directory/);
	});

	it("sanitizes resolvedPath in readToolRenderer using shortenPath", async () => {
		const uiTheme = await getThemeByName("dark");
		expect(uiTheme).toBeDefined();
		const homeDir = os.homedir();
		const secretSubpath = path.join(homeDir, "workspace", "project");
		const rendered = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "file contents" }],
				details: {
					resolvedPath: secretSubpath,
					contentType: "text/plain",
				},
			},
			{ expanded: false, isPartial: false },
			uiTheme!,
			{ path: "." },
		);
		const renderedLines = rendered.render(120);
		const fullText = renderedLines.join("\n");
		// Must not contain un-shortened homeDir if homeDir has length > 1
		const expectedShort = shortenPath(secretSubpath);
		expect(fullText).toContain(expectedShort);
		if (homeDir !== "/" && homeDir.length > 1) {
			expect(fullText).not.toContain(secretSubpath);
		}
	});
});
