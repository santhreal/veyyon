import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { stripVTControlCharacters } from "node:util";
import { AssistantMessageComponent, UserMessageComponent } from "@veyyon/coding-agent/modes/terminal/components";
import { drawSpan, drawToolView, VIEW_KINDS_DRAWN } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import { BUILTIN_TOOLS, HIDDEN_TOOLS } from "@veyyon/coding-agent/tools";
import { toolRenderers } from "@veyyon/coding-agent/tools/renderers";
import type { TUI } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";
import { visibleWidth } from "@veyyon/utils/width";
import type { FramedBlockView, HeadedBlockView, NoticeView, StatusRowView, ToolView, ViewSpan } from "@veyyon/view";
import { createToolExecution } from "./helpers/tool-execution";

function getHomeDir(): string {
	return os.homedir();
}
const longLine = "X".repeat(500);

const mockUi = {
	requestRender() {},
	requestComponentRender() {},
	resetDisplay() {},
} as unknown as TUI;

function defaultSampleArgs(toolName: string): Record<string, unknown> {
	switch (toolName) {
		case "read":
			return { path: `${getHomeDir()}/project/src/index.ts`, offset: 1, limit: 10 };
		case "bash":
			return { command: `ls -la ${getHomeDir()}/project`, cwd: `${getHomeDir()}/project` };
		case "launch":
			return { op: "start", application: "bun", args: ["run", `${getHomeDir()}/project/app.ts`] };
		case "edit":
		case "apply_patch":
			return {
				path: `${getHomeDir()}/project/src/index.ts`,
				input: `[${getHomeDir()}/project/src/index.ts#1234]\n1:old\n+new line\n`,
			};
		case "search":
			return { type: "text", input: "search_term", path: `${getHomeDir()}/project/src` };
		case "ast_edit":
			return { paths: [`${getHomeDir()}/project/src/**/*.ts`], ops: [{ pat: "foo($$$)", out: "bar($$$)" }] };
		case "ask":
			return { question: `Proceed with action in ${getHomeDir()}/project?` };
		case "debug":
			return { action: "launch", program: `${getHomeDir()}/project/bin/app` };
		case "eval":
			return { language: "js", code: `console.log("${getHomeDir()}");\n` };
		case "ssh":
			return { host: "remote-server", command: `cat ${getHomeDir()}/remote.txt` };
		case "github":
			return { action: "issue_view", issue: 123 };
		case "lsp":
			return { action: "diagnostics", file: `${getHomeDir()}/project/src/index.ts` };
		case "inspect_image":
			return { path: `${getHomeDir()}/project/assets/image.png` };
		case "browser":
			return { action: "open", url: "https://example.com" };
		case "checkpoint":
			return { action: "create", name: "checkpoint-1" };
		case "rewind":
			return { target: "checkpoint-1" };
		case "task":
			return { prompt: `Run task in ${getHomeDir()}/project` };
		case "job":
			return { list: true };
		case "irc":
			return { op: "send", to: "worker1", message: `Hello from ${getHomeDir()}` };
		case "todo":
			return { action: "list" };
		case "web_search":
			return { query: "TypeScript guidelines" };
		case "search_tool_bm25":
			return { query: "read file" };
		case "set_cwd":
			return { path: `${getHomeDir()}/project` };
		case "write":
			return { path: `${getHomeDir()}/project/output.txt`, content: "Hello world\n" };
		case "memory_edit":
			return { action: "read", key: "test" };
		case "retain":
			return { text: `Important note about ${getHomeDir()}` };
		case "recall":
			return { query: "test query" };
		case "reflect":
			return { query: "reflect query" };
		case "learn":
			return { topic: "testing" };
		case "manage_skill":
			return { action: "list" };
		case "yield":
			return { result: { data: { success: true } } };
		case "report_finding":
			return { finding: "test finding" };
		case "report_tool_issue":
			return { issue: "test issue" };
		case "resolve":
			return { action: "apply", reason: "testing" };
		case "goal":
			return { op: "get" };
		default:
			return { path: `${getHomeDir()}/file.txt` };
	}
}

function halfStreamedArgs(toolName: string): Record<string, unknown> {
	switch (toolName) {
		case "read":
			return { __partialJson: `{"path":"${getHomeDir()}/project/src/in` };
		case "bash":
			return { __partialJson: `{"command":"ls -la ${getHomeDir()}/pro` };
		case "launch":
			return { __partialJson: `{"op":"start","application":"bu` };
		case "edit":
		case "apply_patch":
			return { __partialJson: `{"path":"${getHomeDir()}/project/src/index.ts","input":"[${getHomeDir()}` };
		case "search":
			return { __partialJson: `{"type":"text","input":"sea` };
		case "ast_edit":
			return { __partialJson: `{"paths":["${getHomeDir()}/project` };
		case "write":
			return { __partialJson: `{"path":"${getHomeDir()}/project/output.txt","content":"Hell` };
		default:
			return { __partialJson: `{"query":"test in ${getHomeDir()}` };
	}
}

function sampleSuccessResult(toolName: string): { content: Array<{ type: string; text?: string }>; details?: unknown } {
	const home = getHomeDir();
	const sampleText = `Output with\ttabs\n${longLine}\nPath: ${home}/project/file.ts\n\x1b[32mANSI colored\x1b[0m\n中文测试 and 日本語 and 한국어\n`;
	switch (toolName) {
		case "edit":
		case "apply_patch":
			return {
				content: [{ type: "text", text: `Applied edit in\t${home}/project/file.ts` }],
				details: {
					diff: `@@ -1,3 +1,3 @@\n-old line with\ttabs\n+new line with\t${home}/project/file.ts\n+${longLine}\n+中文测试\n`,
					path: `${home}/project/file.ts`,
				},
			};
		case "read":
			return {
				content: [{ type: "text", text: sampleText }],
				details: {
					resolvedPath: `${home}/project/file.ts`,
					displayContent: { text: sampleText, startLine: 1, lineNumbers: true },
				},
			};
		default:
			return {
				content: [{ type: "text", text: sampleText }],
			};
	}
}

function sampleErrorResult(_toolName: string): {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError: boolean;
} {
	return {
		content: [
			{
				type: "text",
				text: `Error: Failed operation in\t${getHomeDir()}/project/src/index.ts:\n\tLine 1:\tunmatched line content\twith tabs\n\t${longLine}\n\t${getHomeDir()}/nested/path.ts`,
			},
		],
		isError: true,
	};
}

describe("systematic audit of all tool renderers across widths and paths", () => {
	beforeAll(async () => {
		await initTheme();
		vi.restoreAllMocks();
	});

	const allToolNames = Array.from(
		new Set([...Object.keys(BUILTIN_TOOLS), ...Object.keys(HIDDEN_TOOLS), ...Object.keys(toolRenderers)]),
	).sort();

	const widths = [60, 100, 160];

	for (const toolName of allToolNames) {
		describe(`tool: ${toolName}`, () => {
			for (const width of widths) {
				it(`(a) renders pending call with half-streamed args at width ${width}`, () => {
					const args = halfStreamedArgs(toolName);
					const comp = createToolExecution(toolName, args, {}, undefined, mockUi, getHomeDir(), "call-1");
					const frames = comp.render(width);
					for (const line of frames) {
						// 1. No raw tab characters
						expect(line).not.toContain("\t");
						// 2. Line width bound
						const visualWidth = Bun.stringWidth(stripAnsi(line));
						expect(visualWidth).toBeLessThanOrEqual(width);
						// 3. No raw § handle
						expect(line).not.toMatch(/§[a-zA-Z0-9_-]+/);
						// 4. No raw home directory leak
						const home = getHomeDir();
						if (home && home.length > 2) {
							const plainLine = stripAnsi(line);
							expect(plainLine).not.toContain(home);
						}
					}
				});

				it(`(b) renders success with tabs, 500-col line, home dir, ANSI, CJK at width ${width}`, () => {
					const args = defaultSampleArgs(toolName);
					const comp = createToolExecution(toolName, args, {}, undefined, mockUi, getHomeDir(), "call-2");
					comp.updateResult(sampleSuccessResult(toolName), false, "call-2");
					const frames = comp.render(width);
					for (const line of frames) {
						// 1. No raw tab characters
						expect(line).not.toContain("\t");
						// 2. Line width bound
						const visualWidth = Bun.stringWidth(stripAnsi(line));
						expect(visualWidth).toBeLessThanOrEqual(width);
						// 3. No raw § handle
						expect(line).not.toMatch(/§[a-zA-Z0-9_-]+/);
						// 4. No raw home directory leak
						const home = getHomeDir();
						if (home && home.length > 2) {
							const plainLine = stripAnsi(line);
							expect(plainLine).not.toContain(home);
						}
					}
				});

				it(`(c) renders error whose message embeds file content with tabs at width ${width}`, () => {
					const args = defaultSampleArgs(toolName);
					const comp = createToolExecution(toolName, args, {}, undefined, mockUi, getHomeDir(), "call-3");
					comp.updateResult(sampleErrorResult(toolName), false, "call-3");
					const frames = comp.render(width);
					for (const line of frames) {
						// 1. No raw tab characters
						expect(line).not.toContain("\t");
						// 2. Line width bound
						const visualWidth = Bun.stringWidth(stripAnsi(line));
						expect(visualWidth).toBeLessThanOrEqual(width);
						// 3. No raw § handle
						expect(line).not.toMatch(/§[a-zA-Z0-9_-]+/);
						// 4. No raw home directory leak
						const home = getHomeDir();
						if (home && home.length > 2) {
							const plainLine = stripAnsi(line);
							expect(plainLine).not.toContain(home);
						}
					}
				});
			}
		});
	}

	describe("assistant markdown and user message echo rendering", () => {
		for (const width of widths) {
			it(`renders assistant message markdown (tables, fences, lists, long tokens) at width ${width}`, () => {
				const mdContent = `# Header with\ttabs\n\n| Col 1 | Col 2 |\n|---|---|\n| cell 1 | ${longLine} |\n\n\`\`\`ts\nconst x = "${getHomeDir()}";\n\tconst y = 1;\n\`\`\`\n\n- Item 1 with\ttabs\n  - Nested item\n\n${longLine}\n`;
				const comp = new AssistantMessageComponent({
					role: "assistant",
					content: [{ type: "text", text: mdContent }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "m",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 0,
				});
				const frames = comp.render(width);
				for (const line of frames) {
					expect(line).not.toContain("\t");
					const visualWidth = Bun.stringWidth(stripAnsi(line));
					expect(visualWidth).toBeLessThanOrEqual(width);
				}
			});

			it(`renders user message echo at width ${width}`, () => {
				const userText = `User input with\ttabs\n${longLine}\nLine 3\n`;
				const comp = new UserMessageComponent(userText);
				const frames = comp.render(width);
				for (const line of frames) {
					expect(line).not.toContain("\t");
					const visualWidth = Bun.stringWidth(stripAnsi(line));
					expect(visualWidth).toBeLessThanOrEqual(width);
				}
			});
		}
	});

	describe("generic fallback preview rendering", () => {
		for (const width of widths) {
			it(`sanitizes generic fallback inline args preview with home paths and tabs at width ${width}`, () => {
				const home = getHomeDir();
				const fallbackArgs = {
					file: `${home}/workspace/target/debug/build.log`,
				};
				const comp = createToolExecution(
					"unregistered_custom_tool",
					fallbackArgs,
					{},
					undefined,
					mockUi,
					home,
					"call-fallback-1",
				);
				const frames = comp.render(width);
				for (const line of frames) {
					expect(line).not.toContain("\t");
					const visualWidth = Bun.stringWidth(stripAnsi(line));
					expect(visualWidth).toBeLessThanOrEqual(width);
					if (home && home.length > 2) {
						expect(stripAnsi(line)).not.toContain(home);
					}
				}
				const combined = stripAnsi(frames.join("\n"));
				expect(combined).toContain("~/workspace/target/debug/build.log");
			});

			it(`sanitizes generic fallback argument keys at width ${width}`, () => {
				const home = getHomeDir();
				const comp = createToolExecution(
					"unregistered_custom_tool",
					{ [`arg\t${home}`]: "x" },
					{},
					undefined,
					mockUi,
					home,
					"call-fallback-key",
				);
				const frames = comp.render(width);
				const plain = stripAnsi(frames.join("\n"));
				expect(plain).not.toContain("\t");
				expect(plain).not.toContain(home);
				expect(plain).toMatch(/arg +~="x"/);
				for (const line of frames) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			});

			it(`sanitizes generic fallback text output with home paths and tabs at width ${width}`, () => {
				const home = getHomeDir();
				const comp = createToolExecution(
					"unregistered_custom_tool",
					{ action: "run" },
					{},
					undefined,
					mockUi,
					home,
					"call-fallback-2",
				);
				comp.updateResult(
					{
						content: [
							{
								type: "text",
								text: `Build failed in\t${home}/workspace/app:\n\tError at\t${home}/src/main.rs:10\n`,
							},
						],
					},
					false,
					"call-fallback-2",
				);
				const frames = comp.render(width);
				for (const line of frames) {
					expect(line).not.toContain("\t");
					const visualWidth = Bun.stringWidth(stripAnsi(line));
					expect(visualWidth).toBeLessThanOrEqual(width);
					if (home && home.length > 2) {
						expect(stripAnsi(line)).not.toContain(home);
					}
				}
				const combined = stripAnsi(frames.join("\n"));
				expect(combined).toContain("~/workspace/app");
				expect(combined).toContain("~/src/main.rs");
			});
		}
	});

	/**
	 * WHY THIS EXISTS.
	 *
	 * `contracts/view` ToolViews are host-agnostic presentation models rendered by the terminal
	 * host (`draw-tool-view.ts`). Tool views must consistently sanitize plain text, header titles,
	 * descriptions, badges, notices, Markdown, and code sources (via `shortenEmbeddedPaths` before
	 * `highlightCode`) to prevent sensitive path leakage and visual tab corruptions, while
	 * preserving legitimate styling and handling safe terminal-row replay without exposing internal
	 * drawing helpers.
	 *
	 * THE CLASS THIS CLOSES. Unsanitized tool output crossing the shared ToolView boundary into
	 * terminal chrome, including code blocks leaking home directories through syntax highlighting
	 * tokens and unshortened path prefixes overflowing before truncation.
	 *
	 * WHAT IT DOES NOT CATCH. Non-terminal host rendering (e.g. GUI/web DOM renderers in
	 * `hosts/gui` / `packages/tool-render`) and OS-specific path separators on foreign operating
	 * systems.
	 */
	describe("shared ToolView drawing sanitization and safe-style replay contracts", () => {
		it("exhaustively validates sanitization across every declared ToolView kind", () => {
			const home = getHomeDir();
			const hostileViews: Record<ToolView["kind"], ToolView> = {
				statusRow: {
					kind: "statusRow",
					status: "success",
					title: `fetch\t${home}/src`,
					description: `target\t${home}/dist`,
					badge: { label: `tag\t${home}`, tone: "accent" },
					meta: [[{ text: `info\t${home}` }]],
				},
				textBlock: {
					kind: "textBlock",
					spans: [
						{ text: `plain\t${home}/a` },
						{ text: `badge\t${home}/b`, badge: true },
						{ text: `markdown\t\`${home}/c\``, markdown: true },
					],
				},
				headedBlock: {
					kind: "headedBlock",
					header: { kind: "statusRow", status: "running", title: `task\t${home}/run` },
					lines: [[{ text: `line1\t${home}/x` }, { text: `tail\t${home}/y` }]],
				},
				framedBlock: {
					kind: "framedBlock",
					header: { kind: "statusRow", status: "error", title: `build\t${home}/err` },
					state: "error",
					sections: [
						{
							label: `section\t${home}/sec`,
							lines: [[{ text: `item\t${home}/it` }]],
							list: true,
						},
						{
							code: { language: "typescript", lead: `$ exec\t${home}/bin` },
							lines: [[{ text: `import\t"${home}/mod";` }]],
						},
						{
							markdown: true,
							lines: [[{ text: `**bold**\t\`${home}/spec\`` }]],
						},
					],
				},
				notice: {
					kind: "notice",
					state: "warning",
					tag: `warn\t${home}/tag`,
					headline: [{ text: `notice\t${home}/head` }],
					body: [[{ text: `body\t${home}/body` }]],
				},
			};

			// 1. Verify runtime table keys match contract
			expect(Object.keys(hostileViews).sort()).toEqual(Object.keys(VIEW_KINDS_DRAWN).sort());

			// 2. Render each kind and assert sanitization
			for (const [kind, view] of Object.entries(hostileViews)) {
				const comp = drawToolView(view, theme);
				const rendered = comp.render(100);
				for (const line of rendered) {
					expect(line, `${kind} contained raw tab`).not.toContain("\t");
					const visual = visibleWidth(stripVTControlCharacters(line));
					expect(visual, `${kind} overflowed 100 cols`).toBeLessThanOrEqual(100);
					if (home && home.length > 2) {
						const plain = stripVTControlCharacters(line);
						expect(plain, `${kind} leaked home dir`).not.toContain(home);
					}
				}
			}
		});

		it("sanitizes plain text, styled, badge, and live spans", () => {
			const home = getHomeDir();
			const raw = `file\tat\t${home}/project/app.ts`;

			// plain span
			const plainSpan = drawSpan({ text: raw }, theme);
			expect(plainSpan).not.toContain("\t");
			if (home && home.length > 2) expect(plainSpan).not.toContain(home);
			expect(plainSpan).toContain("~/project/app.ts");

			// styled (bold, italic, strike, tone)
			const styledSpan = drawSpan({ text: raw, tone: "accent", bold: true, italic: true }, theme);
			expect(styledSpan).not.toContain("\t");
			if (home && home.length > 2) expect(styledSpan).not.toContain(home);
			expect(styledSpan).toContain("~/project/app.ts");

			// badge
			const badgeSpan = drawSpan({ text: `tag\t${home}/mod`, badge: true, tone: "warning" }, theme);
			expect(badgeSpan).not.toContain("\t");
			if (home && home.length > 2) expect(badgeSpan).not.toContain(home);
			expect(badgeSpan).toContain("~/mod");

			// live output
			const liveSpan = drawSpan({ text: `stream\t${home}/out`, live: true, tone: "output" }, theme);
			expect(liveSpan).not.toContain("\t");
			if (home && home.length > 2) expect(liveSpan).not.toContain(home);
			expect(liveSpan).toContain("~/out");

			// inline markdown span
			const mdSpan = drawSpan({ text: `run\t\`${home}/bin/cmd\``, markdown: true }, theme);
			expect(mdSpan).not.toContain("\t");
			if (home && home.length > 2) expect(mdSpan).not.toContain(home);
			expect(mdSpan).toContain("~/bin/cmd");
		});

		it("sanitizes status row header metadata and badges", () => {
			const home = getHomeDir();
			const row: StatusRowView = {
				kind: "statusRow",
				status: "success",
				title: `read\t${home}/main.ts`,
				description: `file\tat\t${home}/pkg/lib.ts`,
				badge: { label: `beta\t${home}/v1`, tone: "info" },
				meta: [[{ text: `size\t${home}/kb` }]],
			};
			const comp = drawToolView(row, theme);
			const rendered = comp.render(100);
			const drawn = stripVTControlCharacters(rendered.join("\n"));
			expect(drawn).not.toContain("\t");
			if (home && home.length > 2) expect(drawn).not.toContain(home);
			expect(drawn).toContain("~/main.ts");
			expect(drawn).toContain("~/pkg/lib.ts");
			expect(drawn).toContain("~/v1");
			expect(drawn).toContain("~/kb");
		});

		it("sanitizes framed block markdown sections", () => {
			const home = getHomeDir();
			const block: FramedBlockView = {
				kind: "framedBlock",
				header: { kind: "statusRow", status: "info", title: "Doc" },
				state: "info",
				sections: [
					{
						markdown: true,
						lines: [
							[{ text: `# Title\twith tabs in ${home}/doc.md` }],
							[{ text: `Path: \`${home}/src/index.ts\`\tlisted` }],
						],
					},
				],
			};
			const comp = drawToolView(block, theme);
			const rows = comp.render(80);
			const plain = stripVTControlCharacters(rows.join("\n"));
			expect(plain).not.toContain("\t");
			if (home && home.length > 2) expect(plain).not.toContain(home);
			expect(plain).toContain("~/doc.md");
			expect(plain).toContain("~/src/index.ts");
		});
		it("sanitizes framed block diff sections", () => {
			const home = getHomeDir();
			const block: FramedBlockView = {
				kind: "framedBlock",
				header: { kind: "statusRow", status: "success", title: "diff" },
				state: "success",
				sections: [
					{
						diff: { path: "src/app.ts", sides: ["added", "removed"] },
						lines: [[{ text: `+ import "${home}/pkg/new.ts";` }], [{ text: `- import "${home}/pkg/old.ts";` }]],
					},
				],
			};
			const comp = drawToolView(block, theme);
			const rows = comp.render(80);
			const plain = stripVTControlCharacters(rows.join("\n"));
			if (home && home.length > 2) expect(plain).not.toContain(home);
			expect(plain).toContain("~/pkg/new.ts");
			expect(plain).toContain("~/pkg/old.ts");
		});

		it("sanitizes framed block section labels", () => {
			const home = getHomeDir();
			const block: FramedBlockView = {
				kind: "framedBlock",
				header: { kind: "statusRow", status: "success", title: "inspect" },
				state: "success",
				sections: [
					{
						label: `Output\tfrom\t${home}/target/debug`,
						lines: [[{ text: "compiled successfully" }]],
					},
				],
			};
			const comp = drawToolView(block, theme);
			const rows = comp.render(80);
			const plain = stripVTControlCharacters(rows.join("\n"));
			expect(plain).not.toContain("\t");
			if (home && home.length > 2) expect(plain).not.toContain(home);
			expect(plain).toContain("~/target/debug");
		});

		it("sanitizes notice headlines, tags, and body lines", () => {
			const home = getHomeDir();
			const notice: NoticeView = {
				kind: "notice",
				state: "warning",
				tag: `strict\t${home}/rules`,
				headline: [{ text: `Validation\tfailed in ${home}/project` }],
				body: [[{ text: `Check\tfile at ${home}/config.toml` }]],
			};
			const comp = drawToolView(notice, theme);
			const rows = comp.render(80);
			const plain = stripVTControlCharacters(rows.join("\n"));
			expect(plain).not.toContain("\t");
			if (home && home.length > 2) expect(plain).not.toContain(home);
			expect(plain).toContain("~/rules");
			expect(plain).toContain("~/project");
			expect(plain).toContain("~/config.toml");
		});

		it("shortens home path before line width truncation", () => {
			const home = getHomeDir();
			const tailFilename = "deep_nested_target_file.ts";
			const subpath = "a/b/c";
			const fullPath = `${home}/${subpath}/${tailFilename}`;
			const shortened = `~/${subpath}/${tailFilename}`;
			const targetWidth = shortened.length + 4;
			const block: HeadedBlockView = {
				kind: "headedBlock",
				header: { kind: "statusRow", status: "info", title: "Target" },
				lines: [[{ text: fullPath }]],
			};
			const comp = drawToolView(block, theme);
			const rows = comp.render(targetWidth);
			const plain = stripVTControlCharacters(rows.join("\n"));
			if (home && home.length > 2) expect(plain).not.toContain(home);
			expect(plain).toContain(tailFilename);
		});

		it("sanitizes code section source before syntax highlighting", () => {
			const home = getHomeDir();
			const codeLines = [[{ text: `cd ${home}/project/src` }], [{ text: `echo "running in ${home}/dir"` }]];
			const block: FramedBlockView = {
				kind: "framedBlock",
				header: { kind: "statusRow", status: "success", title: "bash" },
				state: "success",
				sections: [
					{
						code: { language: "bash", firstLineNumber: 1 },
						lines: codeLines,
					},
				],
			};
			const comp = drawToolView(block, theme);
			const rows = comp.render(80);
			const plain = stripVTControlCharacters(rows.join("\n"));
			if (home && home.length > 2) {
				expect(plain).not.toContain(home);
			}
			expect(plain).toContain("~/project/src");
			expect(plain).toContain("~/dir");
		});

		it("sanitizes code lines and prompt lead", () => {
			const home = getHomeDir();
			const leadPrompt = `$ cd\t${home}/workspace && run`;
			const block: FramedBlockView = {
				kind: "framedBlock",
				header: { kind: "statusRow", status: "running", title: "run" },
				state: "running",
				sections: [
					{
						code: {
							lead: leadPrompt,
						},
						lines: [[{ text: "const\tx\t=\t1;" }]],
					},
				],
			};
			const comp = drawToolView(block, theme);
			const rows = comp.render(80);
			const plain = stripVTControlCharacters(rows.join("\n"));
			expect(plain).not.toContain("\t");
			if (home && home.length > 2) expect(plain).not.toContain(home);
			expect(plain).toContain("~/workspace");
			expect(plain).toMatch(/const\s+x\s+=\s+1;/);
		});

		it("fitted header shortens home paths before middle-cutting long description", () => {
			const home = getHomeDir();
			const deepPath = `${home}/very/long/nested/directory/structure/that/must/be/fitted/in/card/file.ts`;
			const view: StatusRowView = {
				kind: "statusRow",
				status: "success",
				title: "Edit",
				description: deepPath,
				descriptionFits: true,
			};
			const block: FramedBlockView = {
				kind: "framedBlock",
				header: view,
				state: "success",
				sections: [],
			};
			const comp = drawToolView(block, theme);
			const rows = comp.render(40);
			const plain = stripVTControlCharacters(rows[0] ?? "");
			if (home && home.length > 2) expect(plain).not.toContain(home);
			expect(plain).toContain("~");
			expect(plain).toContain("…");
		});

		it("safe style replay for captured spans preserves safe SGR escape codes", () => {
			const home = getHomeDir();
			const safeCaptured = `\x1b[1m[SAFE_BOLD]\x1b[0m \x1b[38;2;255;100;50mcustom-color\x1b[0m at ${home}/build.log`;
			const span: ViewSpan = {
				text: safeCaptured,
				captured: true,
			};
			const drawn = drawSpan(span, theme);
			// Must preserve safe SGR code and content while applying base foreground via styleTerminalRow
			expect(drawn).toContain("\x1b[1m");
			expect(drawn).toContain("\x1b[38;2;255;100;50m");
			expect(drawn).toContain("[SAFE_BOLD]");
			expect(drawn).toContain("custom-color");

			// In framed block with captured line
			const block: FramedBlockView = {
				kind: "framedBlock",
				header: { kind: "statusRow", status: "error", title: "pty" },
				state: "error",
				sections: [
					{
						lines: [[span]],
						clip: true,
					},
				],
			};
			const comp = drawToolView(block, theme);
			const rows = comp.render(100);
			const capturedRow = rows.find(r => r.includes("[SAFE_BOLD]"));
			expect(capturedRow).toBeDefined();
			expect(capturedRow).toContain("\x1b[1m");
		});
	});
});
