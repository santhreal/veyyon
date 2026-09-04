/**
 * WHY: Search execution accepts JSON-encoded path lists (e.g. `'["/etc","src"]'`),
 * documented semicolon lists, and legacy comma/whitespace delimiters across
 * files, text, and structure modes. However, approval preflight previously only
 * performed a simple semicolon split without parsing JSON arrays or handling
 * delimiters before globSearchBase. Because globSearchBase treats leading `[`
 * as a glob metacharacter with no literal prefix, JSON arrays resolved to cwd
 * and bypassed the cwd boundary in non-yolo modes while still executing against
 * outside filesystem targets.
 *
 * This suite defends:
 * 1. Conservative preflight extraction of every path encoding execution accepts,
 *    including JSON-encoded arrays, direct arrays, semicolon lists, and
 *    comma/whitespace recovery, without breaking brace expansions or URL schemes.
 * 2. Complete gating across all three SearchTool discriminators (files, text, structure)
 *    so any outside target in a multi-target search triggers the cwd boundary.
 * 3. Exact execution parity in yolo mode where outside searches are permitted.
 *
 * What this suite does NOT catch: Non-filesystem targets (ssh://, http(s)://, local://)
 * are not gated by local cwd boundary; they are governed by their respective tiers.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { cwdEscapingTargets, searchPathFilesystemTargets } from "@veyyon/coding-agent/tools/core/cwd-boundary";
import { parseApprovalPathList } from "@veyyon/coding-agent/tools/core/path-utils";
import { SearchTool, searchSchema } from "@veyyon/coding-agent/tools/search/search";
import { Snowflake } from "@veyyon/utils";

describe("JSON-encoded and delimited search paths enforce cwd boundary", () => {
	let tempDir: string;
	let cwd: string;
	let outsideDir: string;
	let insideFile: string;
	let outsideFile: string;
	let session: ToolSession;
	let searchTool: SearchTool;

	beforeAll(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-search-boundary-${Snowflake.next()}-`));
		cwd = path.join(tempDir, "cwd");
		outsideDir = path.join(tempDir, "outside");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(outsideDir, { recursive: true });

		insideFile = path.join(cwd, "inside.ts");
		fs.writeFileSync(insideFile, 'export const inside = "INSIDE_TARGET";\n');

		outsideFile = path.join(outsideDir, "outside.ts");
		fs.writeFileSync(outsideFile, 'export const outside = "OUTSIDE_TARGET";\n');

		session = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(cwd, "artifacts"),
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
		};
		searchTool = new SearchTool(session);
	});

	afterAll(() => {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
	});

	describe("pure synchronous approval path list parser", () => {
		it("normalizes JSON-encoded string arrays", () => {
			const jsonArray = JSON.stringify([outsideFile, insideFile]);
			expect(parseApprovalPathList(jsonArray)).toEqual([outsideFile, insideFile]);
		});

		it("normalizes direct string arrays", () => {
			expect(parseApprovalPathList([outsideFile, insideFile])).toEqual([outsideFile, insideFile]);
		});

		it("splits documented semicolon lists", () => {
			expect(parseApprovalPathList(`${outsideFile}; ${insideFile}`)).toEqual([outsideFile, insideFile]);
		});

		it("splits comma-delimited recovery lists", () => {
			expect(parseApprovalPathList(`${outsideFile}, ${insideFile}`)).toEqual([outsideFile, insideFile]);
		});

		it("splits whitespace-delimited lists", () => {
			expect(parseApprovalPathList(`${outsideFile} ${insideFile}`)).toEqual([outsideFile, insideFile]);
		});

		it("preserves glob braces without splitting inner commas", () => {
			expect(parseApprovalPathList("src/{foo,bar}/**/*.ts")).toEqual(["src/{foo,bar}/**/*.ts"]);
			expect(parseApprovalPathList("/outside/{alpha,beta}/**/*.ts")).toEqual(["/outside/{alpha,beta}/**/*.ts"]);
		});

		it("preserves readable URLs and SSH URLs with query/path commas", () => {
			expect(parseApprovalPathList("https://example.com/search?q=a,b")).toEqual([
				"https://example.com/search?q=a,b",
			]);
			expect(parseApprovalPathList("ssh://host/path?a=1,2")).toEqual(["ssh://host/path?a=1,2"]);
			expect(parseApprovalPathList("local://session/notes.md")).toEqual(["local://session/notes.md"]);
		});

		it("conservatively splits ambiguous URL semicolons to protect physical peers", () => {
			expect(parseApprovalPathList("https://example.com/search?q=a;b=2")).toEqual([
				"https://example.com/search?q=a",
				"b=2",
			]);
			expect(parseApprovalPathList("ssh://host/path?a=1;b=2")).toEqual(["ssh://host/path?a=1", "b=2"]);
		});

		it("correctly separates URLs from adjacent filesystem targets in semicolon lists", () => {
			expect(parseApprovalPathList(`src; https://example.com/api?a=1,2; ${outsideFile}`)).toEqual([
				"src",
				"https://example.com/api?a=1,2",
				outsideFile,
			]);
			expect(parseApprovalPathList(`https://example.com/x;${outsideFile}`)).toEqual([
				"https://example.com/x",
				outsideFile,
			]);
			expect(parseApprovalPathList(`local://session/notes.md;${outsideFile}`)).toEqual([
				"local://session/notes.md",
				outsideFile,
			]);
			expect(parseApprovalPathList(`ssh://host/repo;${outsideFile}`)).toEqual(["ssh://host/repo", outsideFile]);
		});

		it("handles malformed unknown/object/number inputs without throwing", () => {
			expect(parseApprovalPathList(123)).toEqual([]);
			expect(parseApprovalPathList(true)).toEqual([]);
			expect(parseApprovalPathList({})).toEqual([]);
			expect(parseApprovalPathList(null)).toEqual([]);
			expect(parseApprovalPathList(undefined)).toEqual([]);
			expect(parseApprovalPathList([123, null, {}, true])).toEqual([]);
			expect(parseApprovalPathList({ path: 123 })).toEqual([]);
			expect(searchPathFilesystemTargets(123)).toEqual([]);
			expect(searchPathFilesystemTargets({})).toEqual([]);
			expect(searchPathFilesystemTargets({ path: 123 })).toEqual([]);
			expect(searchPathFilesystemTargets({ input: {} })).toEqual([]);
		});
	});

	describe("searchPathFilesystemTargets and cwdEscapingTargets", () => {
		it("reports outside targets from JSON-encoded arrays containing inside and outside paths", () => {
			const jsonMixed = JSON.stringify([outsideFile, insideFile]);
			const targets = searchPathFilesystemTargets({ path: jsonMixed });
			expect(targets).toEqual([outsideFile, insideFile]);

			const escaping = cwdEscapingTargets(searchTool, { type: "text", input: "needle", path: jsonMixed }, cwd);
			expect(escaping).toEqual([outsideFile]);
		});

		it("reports outside targets from direct arrays, comma lists, and whitespace lists", () => {
			// Direct array
			expect(searchPathFilesystemTargets({ path: [outsideFile, insideFile] })).toEqual([outsideFile, insideFile]);
			expect(
				cwdEscapingTargets(searchTool, { type: "text", input: "needle", path: [outsideFile, insideFile] }, cwd),
			).toEqual([outsideFile]);

			// Comma-delimited recovery
			expect(searchPathFilesystemTargets({ path: `src/inside.ts, ${outsideFile}` })).toEqual([
				"src/inside.ts",
				outsideFile,
			]);
			expect(
				cwdEscapingTargets(
					searchTool,
					{ type: "text", input: "needle", path: `src/inside.ts, ${outsideFile}` },
					cwd,
				),
			).toEqual([outsideFile]);

			// Whitespace-delimited
			expect(searchPathFilesystemTargets({ path: `src/inside.ts ${outsideFile}` })).toEqual([
				"src/inside.ts",
				outsideFile,
			]);
			expect(
				cwdEscapingTargets(
					searchTool,
					{ type: "text", input: "needle", path: `src/inside.ts ${outsideFile}` },
					cwd,
				),
			).toEqual([outsideFile]);

			// Semicolon list mixing URLs and outside paths keeps outside paths flagged
			expect(searchPathFilesystemTargets({ path: `src; https://example.com/test; ${outsideFile}` })).toEqual([
				"src",
				"https://example.com/test",
				outsideFile,
			]);
			expect(
				cwdEscapingTargets(
					searchTool,
					{ type: "text", input: "needle", path: `src; https://example.com/test; ${outsideFile}` },
					cwd,
				),
			).toEqual([outsideFile]);
		});

		it("escalates every text path-list encoding containing ssh to exec tier", () => {
			const sshPath = "ssh://example/repo/file.ts";
			const encodings: unknown[] = [
				sshPath,
				`${insideFile};${sshPath}`,
				JSON.stringify([insideFile, sshPath]),
				[insideFile, sshPath],
			];

			for (const encodedPath of encodings) {
				expect(searchTool.approval({ type: "text", input: "needle", path: encodedPath })).toBe("exec");
			}
			expect(searchTool.approval({ type: "text", input: "needle", path: { malformed: true } })).toBe("read");
			expect(searchTool.approval({ type: "files", input: sshPath })).toBe("read");
			expect(searchTool.approval({ type: "structure", input: "call($$$)", path: sshPath })).toBe("read");
		});

		it("sweeps all searchSchema discriminators for JSON array support", () => {
			const discriminators = searchSchema.shape.type.options;
			expect(discriminators).toEqual(["files", "text", "structure"]);

			for (const type of discriminators) {
				const jsonMixed = JSON.stringify([outsideFile, insideFile]);
				const args = type === "files" ? { type, input: jsonMixed } : { type, input: "INSIDE", path: jsonMixed };

				const targets = searchTool.filesystemTargets(args);
				expect(targets).toContain(outsideFile);
				expect(targets).toContain(insideFile);

				const escaping = cwdEscapingTargets(searchTool, args, cwd);
				expect(escaping).toEqual([outsideFile]);
			}
		});

		it("preserves glob bases for patterns with braces", () => {
			const inPattern = "src/{a,b}/**/*.ts";
			const outPattern = `${outsideDir}/{a,b}/**/*.ts`;

			expect(searchPathFilesystemTargets({ path: inPattern })).toEqual(["src"]);
			expect(searchPathFilesystemTargets({ path: outPattern })).toEqual([outsideDir]);

			expect(cwdEscapingTargets(searchTool, { type: "text", input: "needle", path: inPattern }, cwd)).toEqual([]);
			expect(cwdEscapingTargets(searchTool, { type: "text", input: "needle", path: outPattern }, cwd)).toEqual([
				outsideDir,
			]);
		});
	});

	describe("end-to-end approval gate integration", () => {
		it("proves the outside file is executable by the real engine yet is blocked in ask-command mode", async () => {
			const sessionManager = SessionManager.create(cwd, path.join(tempDir, "sessions"));
			const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
			const model = getBundledModel("openai", "gpt-4o-mini");
			const modelRegistry = new ModelRegistry(authStorage);
			const created = await createAgentSession({
				cwd,
				agentDir: tempDir,
				sessionManager,
				authStorage,
				settings: Settings.isolated({
					"async.enabled": false,
					"bash.autoBackground.enabled": false,
					"bashInterceptor.enabled": false,
				}),
				model,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				workspaceTree: { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				toolNames: ["search"],
			});

			const runner = created.session;
			try {
				const jsonMixed = JSON.stringify([outsideFile, insideFile]);
				const mockCtx = (approvalMode: "ask-command" | "yolo"): AgentToolContext => ({
					settings: Settings.isolated({
						"async.enabled": false,
						"bash.autoBackground.enabled": false,
						"bashInterceptor.enabled": false,
						"tools.approvalMode": approvalMode,
					}),
					sessionManager,
					modelRegistry,
					model,
					isIdle: () => true,
					hasQueuedMessages: () => false,
					abort: () => {},
				});

				const toolInstance = runner.getToolByName("search");
				expect(toolInstance).toBeDefined();

				// In ask-command mode, mixed JSON array search is gated because outsideFile escapes cwd
				await expect(
					toolInstance!.execute(
						"search-files-gated",
						{ type: "files", input: jsonMixed },
						undefined,
						undefined,
						mockCtx("ask-command"),
					),
				).rejects.toThrow(/outside the session working directory/);

				await expect(
					toolInstance!.execute(
						"search-text-gated",
						{ type: "text", input: "TARGET", path: jsonMixed },
						undefined,
						undefined,
						mockCtx("ask-command"),
					),
				).rejects.toThrow(/outside the session working directory/);

				await expect(
					toolInstance!.execute(
						"search-structure-gated",
						{ type: "structure", input: "export const $NAME = $VAL;", path: jsonMixed },
						undefined,
						undefined,
						mockCtx("ask-command"),
					),
				).rejects.toThrow(/outside the session working directory/);

				// In yolo mode, the search succeeds and executes on both inside and outside targets across all 3 modes
				const yoloFilesResult = await toolInstance!.execute(
					"search-files-yolo",
					{ type: "files", input: jsonMixed },
					undefined,
					undefined,
					mockCtx("yolo"),
				);
				const filesText = yoloFilesResult.content.find(b => b.type === "text")?.text ?? "";
				expect(filesText).toContain("inside.ts");
				expect(filesText).toContain("outside.ts");

				const yoloTextResult = await toolInstance!.execute(
					"search-text-yolo",
					{ type: "text", input: "TARGET", path: jsonMixed },
					undefined,
					undefined,
					mockCtx("yolo"),
				);
				const textText = yoloTextResult.content.find(b => b.type === "text")?.text ?? "";
				expect(textText).toContain("inside.ts");
				expect(textText).toContain("outside.ts");

				const yoloStructureResult = await toolInstance!.execute(
					"search-structure-yolo",
					{ type: "structure", input: "export const $NAME = $VAL;", path: jsonMixed },
					undefined,
					undefined,
					mockCtx("yolo"),
				);
				const structureText = yoloStructureResult.content.find(b => b.type === "text")?.text ?? "";
				expect(structureText).toContain("inside.ts");
				expect(structureText).toContain("outside.ts");
			} finally {
				await runner.dispose();
			}
		});
	});
});
