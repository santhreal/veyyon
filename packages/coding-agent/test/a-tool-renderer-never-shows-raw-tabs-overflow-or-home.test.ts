import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { AssistantMessageComponent } from "@veyyon/coding-agent/modes/components/assistant-message";
import { UserMessageComponent } from "@veyyon/coding-agent/modes/components/user-message";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { BUILTIN_TOOLS, HIDDEN_TOOLS } from "@veyyon/coding-agent/tools";
import { toolRenderers } from "@veyyon/coding-agent/tools/renderers";
import type { TUI } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";
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
});
