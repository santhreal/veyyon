/**
 * Observable contract and mutation coverage for canonical tool views and registry parity.
 *
 * WHY THIS SUITE EXISTS:
 * Validates that every tool view definition in toolViewDefinitions resolves to a specialized
 * ToolViewRenderer, produces a valid ToolExecutionBlock projection via buildToolExecutionBlock,
 * processes array, string and multi-block content identically, and keeps its specialized visual
 * semantics without generic degradation. The registry is the terminal's card set: the one alias it
 * carries is `apply_patch` for `edit`. Wire and descriptor aliases (`read_file`, `puppeteer`,
 * `runtime`, ...) belong to the HTML export's `@veyyon/tool-render` descriptors and are pinned there.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type { FramedBlockView, StatusRowView, ToolView } from "@veyyon/view";
import { drawToolView } from "../../../hosts/gui/src/draw-tool-view";
import { Settings } from "../src/config/settings";
import { createMCPToolView } from "../src/mcp/view";
import { toReadEntryView, updateReadEntryResult } from "../src/presentation/read-group";
import { buildToolExecutionBlock, type ToolExecutionBuildParams } from "../src/presentation/tool-execution";
import { projectToolDisplay } from "../src/presentation/web-tool-display";
import { taskToolView } from "../src/task/task-view";
import type { AgentProgress } from "../src/task/types";
import { toolViewDefinitions } from "../src/tools/view-registry";

interface ToolFixture {
	callArgs: Record<string, unknown>;
	successResult: NonNullable<ToolExecutionBuildParams["result"]>;
	errorResult?: ToolExecutionBuildParams["result"];
}

const TOOL_FIXTURES: Record<string, ToolFixture> = {
	read: {
		callArgs: { path: "src/index.ts" },
		successResult: {
			details: { path: "src/index.ts", totalLines: 20 },
			content: [{ type: "text", text: "console.log('hello');" }],
		},
		errorResult: { content: [{ type: "text", text: "File not found" }], isError: true },
	},
	write: {
		callArgs: { path: "src/output.txt", content: "new content\n" },
		successResult: {
			details: { path: "src/output.txt", bytesWritten: 12 },
			content: [{ type: "text", text: "Wrote 12 bytes" }],
		},
		errorResult: { content: [{ type: "text", text: "Write permission denied" }], isError: true },
	},
	inspect_image: {
		callArgs: { path: "assets/logo.png" },
		successResult: {
			details: { path: "assets/logo.png", width: 800, height: 600 },
			content: [{ type: "text", text: "Image dimensions: 800x600" }],
		},
		errorResult: { content: [{ type: "text", text: "Invalid image format" }], isError: true },
	},
	set_cwd: {
		callArgs: { path: "/workspace/project" },
		successResult: {
			details: { previous: "/workspace/old", cwd: "/workspace/project", rulesApplied: ["AGENTS.md"] },
			content: [{ type: "text", text: "Working directory changed" }],
		},
		errorResult: { content: [{ type: "text", text: "Directory does not exist" }], isError: true },
	},
	edit: {
		callArgs: { path: "src/app.ts", input: "[src/app.ts#1234]\n+const x = 1;\n" },
		successResult: {
			details: { path: "src/app.ts", diff: "+const x = 1;" },
			content: [{ type: "text", text: "Applied patch" }],
		},
		errorResult: { content: [{ type: "text", text: "Patch mismatch at line 10" }], isError: true },
	},
	apply_patch: {
		callArgs: { path: "src/patch.ts", input: "[src/patch.ts#5678]\n-old\n+new\n" },
		successResult: {
			details: { path: "src/patch.ts", diff: "+new" },
			content: [{ type: "text", text: "Patch ok" }],
		},
		errorResult: { content: [{ type: "text", text: "Failed to apply patch" }], isError: true },
	},
	search: {
		callArgs: { type: "text", input: "interface ToolView" },
		successResult: {
			details: { count: 3 },
			content: [{ type: "text", text: "3 matches found" }],
		},
		errorResult: { content: [{ type: "text", text: "Search index error" }], isError: true },
	},
	ast_edit: {
		callArgs: { paths: ["src/app.ts"], ops: [{ pat: "$A", out: "$B" }] },
		successResult: {
			details: { matchedFiles: 1, appliedEdits: 1 },
			content: [{ type: "text", text: "ast_edit applied" }],
		},
		errorResult: { content: [{ type: "text", text: "Syntax pattern parse failure" }], isError: true },
	},
	search_tool_bm25: {
		callArgs: { query: "find file tools" },
		successResult: {
			details: {
				query: "find file tools",
				limit: 10,
				total_tools: 5,
				active_selected_tools: ["read"],
				tools: [{ label: "read", score: 0.9, description: "read file" }],
			},
			content: [{ type: "text", text: "read\nwrite" }],
		},
		errorResult: { content: [{ type: "text", text: "BM25 index not loaded" }], isError: true },
	},
	bash: {
		callArgs: { command: "git status" },
		successResult: {
			details: { exitCode: 0 },
			content: [{ type: "text", text: "On branch main\nnothing to commit" }],
		},
		errorResult: {
			details: { exitCode: 1 },
			content: [{ type: "text", text: "fatal: not a git repo" }],
			isError: true,
		},
	},
	launch: {
		callArgs: { op: "start", application: "bun", args: ["test"] },
		successResult: {
			details: { status: "running", pid: 1234 },
			content: [{ type: "text", text: "Process started" }],
		},
		errorResult: { content: [{ type: "text", text: "Command not found: bun" }], isError: true },
	},
	debug: {
		callArgs: { action: "launch", program: "src/main.ts" },
		successResult: {
			details: { state: "running" },
			content: [{ type: "text", text: "Debugger attached" }],
		},
		errorResult: { content: [{ type: "text", text: "DAP adapter failed to launch" }], isError: true },
	},
	eval: {
		callArgs: { language: "js", code: "const a = 10; a * 2;" },
		successResult: {
			details: { result: 20 },
			content: [{ type: "text", text: "20" }],
		},
		errorResult: { content: [{ type: "text", text: "ReferenceError: a is not defined" }], isError: true },
	},
	ssh: {
		callArgs: { host: "server1", command: "uptime" },
		successResult: {
			details: { exitCode: 0 },
			content: [{ type: "text", text: "12:00:00 up 10 days" }],
		},
		errorResult: { content: [{ type: "text", text: "SSH connection timed out" }], isError: true },
	},
	job: {
		callArgs: { list: true },
		successResult: {
			details: {
				jobs: [{ id: "job-1", label: "test", type: "bash", status: "completed", durationMs: 100 }],
				agents: [],
			},
			content: [{ type: "text", text: "1 active job" }],
		},
		errorResult: { content: [{ type: "text", text: "Job manager not available" }], isError: true },
	},
	browser: {
		callArgs: { action: "open", url: "https://example.com" },
		successResult: {
			details: { url: "https://example.com", status: 200 },
			content: [{ type: "text", text: "Page loaded" }],
		},
		errorResult: { content: [{ type: "text", text: "Net::ERR_CONNECTION_REFUSED" }], isError: true },
	},
	web_search: {
		callArgs: { query: "TypeScript 5.8 features" },
		successResult: {
			details: { query: "TypeScript 5.8 features", totalResults: 5 },
			content: [{ type: "text", text: "1. TS 5.8 beta announced" }],
		},
		errorResult: { content: [{ type: "text", text: "Web search rate limited" }], isError: true },
	},
	github: {
		callArgs: { op: "issue_view", issue: "123" },
		successResult: {
			details: { summary: "Issue #123 details" },
			content: [{ type: "text", text: "Opened issue #123" }],
		},
		errorResult: { content: [{ type: "text", text: "GitHub API authentication failed" }], isError: true },
	},
	retain: {
		callArgs: { items: [{ content: "Use bun test for test execution" }] },
		successResult: {
			details: { id: "m-1" },
			content: [{ type: "text", text: "Memory retained" }],
		},
		errorResult: { content: [{ type: "text", text: "Memory store full" }], isError: true },
	},
	recall: {
		callArgs: { query: "test execution rules" },
		successResult: {
			details: { count: 1 },
			content: [{ type: "text", text: "Found 1 memory" }],
		},
		errorResult: { content: [{ type: "text", text: "Recall search failed" }], isError: true },
	},
	reflect: {
		callArgs: { query: "architectural synthesis" },
		successResult: {
			details: { thoughts: ["Synthesized plan"] },
			content: [{ type: "text", text: "Reflection complete" }],
		},
		errorResult: { content: [{ type: "text", text: "Reflect error" }], isError: true },
	},
	resolve: {
		callArgs: { action: "apply", reason: "Plan approved by user" },
		successResult: {
			details: { status: "applied", reason: "Plan approved by user" },
			content: [{ type: "text", text: "Action resolved: apply" }],
		},
		errorResult: { content: [{ type: "text", text: "No pending action" }], isError: true },
	},
	goal: {
		callArgs: { op: "get" },
		successResult: {
			details: { status: "active", objective: "Consolidate tool views" },
			content: [{ type: "text", text: "Goal active: Consolidate tool views" }],
		},
		errorResult: { content: [{ type: "text", text: "Goal storage failure" }], isError: true },
	},
	todo: {
		callArgs: { action: "list" },
		successResult: {
			details: { todos: [{ id: "t-1", content: "Implement views", status: "completed" }] },
			content: [{ type: "text", text: "1. [x] Implement views" }],
		},
		errorResult: { content: [{ type: "text", text: "Todo list error" }], isError: true },
	},
	irc: {
		callArgs: { op: "send", to: "BrowserViewCutover", message: "Coordinating view tests" },
		successResult: {
			details: { delivered: true },
			content: [{ type: "text", text: "Delivered to BrowserViewCutover" }],
		},
		errorResult: { content: [{ type: "text", text: "Recipient offline" }], isError: true },
	},
	ask: {
		callArgs: { question: "Confirm database migration?" },
		successResult: {
			details: { results: [{ id: "q1", question: "Confirm database migration?", selectedOptions: ["yes"] }] },
			content: [{ type: "text", text: "yes" }],
		},
		errorResult: { content: [{ type: "text", text: "Dialog cancelled" }], isError: true },
	},
	lsp: {
		callArgs: { action: "diagnostics", file: "src/app.ts" },
		successResult: {
			details: { diagnostics: [] },
			content: [{ type: "text", text: "No diagnostic issues found" }],
		},
		errorResult: { content: [{ type: "text", text: "LSP server not responding" }], isError: true },
	},
	vibe_list: {
		callArgs: {},
		successResult: {
			details: { screens: [] },
			content: [{ type: "text", text: "No active vibe sessions" }],
		},
		errorResult: { content: [{ type: "text", text: "List failed" }], isError: true },
	},
	vibe_send: {
		callArgs: { id: "worker-1", message: "run checks" },
		successResult: {
			details: { delivered: true },
			content: [{ type: "text", text: "Message delivered" }],
		},
		errorResult: { content: [{ type: "text", text: "Worker unreachable" }], isError: true },
	},
	task: {
		callArgs: { prompt: "Build new subsystem in subagent" },
		successResult: {
			details: {
				status: "completed",
				id: "task-1",
				results: [{ id: "task-1", agent: "task", status: "completed", task: "Build new subsystem" }],
			},
			content: [{ type: "text", text: "Task completed" }],
		},
		errorResult: { content: [{ type: "text", text: "Subagent crashed" }], isError: true },
	},
	vibe_spawn: {
		callArgs: { prompt: "Run analysis in worker" },
		successResult: {
			details: { spawned: { id: "worker-1", cli: "claude" } },
			content: [{ type: "text", text: "Spawned worker-1" }],
		},
		errorResult: { content: [{ type: "text", text: "Failed to spawn worker" }], isError: true },
	},
	vibe_wait: {
		callArgs: { id: "worker-1" },
		successResult: {
			details: { screens: [] },
			content: [{ type: "text", text: "Worker finished" }],
		},
		errorResult: { content: [{ type: "text", text: "Wait timeout" }], isError: true },
	},
	vibe_kill: {
		callArgs: { id: "worker-1" },
		successResult: {
			details: { killed: true },
			content: [{ type: "text", text: "Worker terminated" }],
		},
		errorResult: { content: [{ type: "text", text: "Kill failed" }], isError: true },
	},
};

beforeAll(async () => {
	await Settings.init({ inMemory: true });
});

describe("canonical tool view registry dynamic enumeration and fixture coverage", () => {
	it("has an explicit classified fixture for every tool in toolViewDefinitions", () => {
		expect(Object.keys(TOOL_FIXTURES).sort()).toEqual(Object.keys(toolViewDefinitions).sort());
	});
});

describe("buildToolExecutionBlock execution across all canonical tools and aliases", () => {
	const names = Object.keys(toolViewDefinitions).sort();

	for (const toolName of names) {
		const fixture = TOOL_FIXTURES[toolName];
		if (!fixture) continue;

		describe(`tool: ${toolName}`, () => {
			it.each([false, true])(
				"preserves equivalent string and multipart content without renderer failures (isError: %s)",
				isError => {
					const text = "diagnostic-first\ndiagnostic-last";
					const project = (content: string | Array<{ type: string; text: string }>) =>
						buildToolExecutionBlock({
							toolName,
							args: fixture.callArgs,
							result: { content, isError },
							isPartial: false,
							expanded: true,
						});
					const single = project([{ type: "text", text }]);
					const string = project(text);
					const multipart = project([
						{ type: "text", text: "diagnostic-first" },
						{ type: "text", text: "diagnostic-last" },
					]);
					for (const block of [single, string, multipart]) {
						expect(block.status).toBe(isError ? "failed" : "succeeded");
						expect(block.display?.failures?.call).toBeUndefined();
						expect(block.display?.failures?.result).toBeUndefined();
						expect(block.display?.generic).toBeUndefined();
					}
					expect(string.display?.resultView).toEqual(single.display?.resultView);
					expect(multipart.display?.resultView).toEqual(single.display?.resultView);
					expect(string.display?.readEntry).toEqual(single.display?.readEntry);
					expect(multipart.display?.readEntry).toEqual(single.display?.readEntry);
				},
			);

			if (toolViewDefinitions[toolName].view === toolViewDefinitions.job.view) {
				it.each([false, true])("draws empty job results for each job alias (isError: %s)", isError => {
					const view = buildToolExecutionBlock({
						toolName,
						args: fixture.callArgs,
						result: { content: [{ type: "text", text: "no work available" }], isError },
					}).display?.resultView;
					if (!view) throw new Error("Expected an empty-job result view");
					expect(drawToolView(view)).toContain("no work available");
				});
			}

			it("renders running call state with specialized display", () => {
				const block = buildToolExecutionBlock({
					toolName,
					args: fixture.callArgs,
					isPartial: true,
					expanded: true,
				});

				expect(block.status).toBe("running");
				expect(block.display).toBeDefined();
				const callView = block.display?.callView;
				const resultView = block.display?.resultView;
				const view = callView ?? resultView;
				expect(view).toBeDefined();
				expect(block.display?.failures?.call).toBeUndefined();
			});

			it("renders succeeded result state with specialized display and content", () => {
				const block = buildToolExecutionBlock({
					toolName,
					args: fixture.callArgs,
					result: fixture.successResult,
					isPartial: false,
					expanded: true,
				});

				expect(block.status).toBe("succeeded");
				expect(block.display).toBeDefined();
				const view = (block.display?.resultView ?? block.display?.callView) as ToolView;
				expect(view).toBeDefined();
				expect(block.display?.failures?.result).toBeUndefined();
			});

			if (fixture.errorResult) {
				it("renders failed error state with error section", () => {
					const block = buildToolExecutionBlock({
						toolName,
						args: fixture.callArgs,
						result: fixture.errorResult,
						isPartial: false,
						isError: true,
						expanded: true,
					});

					expect(block.status).toBe("failed");
					expect(block.display).toBeDefined();
					const resultView = block.display?.resultView;
					expect(resultView).toBeDefined();
					expect(block.display?.failures?.result).toBeUndefined();
				});
			}
		});
	}
});

describe("content extraction resilience and multi-block formatting", () => {
	it("preserves grouped read text when absent and clears explicitly empty text", () => {
		const entry = toReadEntryView(
			"read-example",
			{ path: "src/example.ts" },
			{
				content: [
					{ type: "text", text: "first" },
					{ type: "text", text: "last" },
				],
			},
		);
		if (!entry) throw new Error("Expected a grouped read entry for a file path");
		expect(entry.contentText).toBe("first\nlast");
		updateReadEntryResult(entry, { content: [] });
		expect(entry.contentText).toBe("first\nlast");
		updateReadEntryResult(entry, { content: [{ type: "text", text: "" }] });
		expect(entry.contentText).toBe("");
	});

	it("preserves every MCP text block through the production display builder", () => {
		const display = projectToolDisplay({
			toolName: "mcp_example",
			args: {},
			toolViewDefinition: { view: createMCPToolView("Example") },
			result: {
				content: [
					{ type: "text", text: "first" },
					{ type: "text", text: "last" },
				],
			},
		});
		expect(display.resultView).toMatchObject({
			kind: "headedBlock",
			lines: [[{ text: "first", tone: "output" }], [{ text: "last", tone: "output" }]],
		});
		expect(display.failures).toBeUndefined();
	});
});

describe("legacy wire aliases behavior and specialized semantics", () => {
	it("projects apply_patch alias with specialized edit view", () => {
		const block = buildToolExecutionBlock({
			toolName: "apply_patch",
			args: { path: "src/main.ts", input: "[src/main.ts#1234]\n+console.log('patched');\n" },
			result: { content: [{ type: "text", text: "Patch applied successfully" }] },
			expanded: true,
		});
		expect(block.status).toBe("succeeded");
		const view = (block.display?.resultView ?? block.display?.callView) as FramedBlockView | StatusRowView;
		const title = (view as StatusRowView).title ?? (view as FramedBlockView).header?.title;
		expect(title).toBe("Edit");
	});
});

describe("mutation failure capture and fallback distinctions", () => {
	it("falls back to generic display for unknown tool name while preserving parameters", () => {
		const block = buildToolExecutionBlock({
			toolName: "unregistered_custom_tool",
			args: { customArg: "test_value" },
			result: { content: [{ type: "text", text: "custom result" }] },
			expanded: true,
		});

		expect(block.status).toBe("succeeded");
		// Unregistered tool has no specialized ToolViewDefinition
		expect(toolViewDefinitions["unregistered_custom_tool"]).toBeUndefined();
		expect(block.display?.generic).toBeDefined();
	});

	it("projectToolDisplay strips heavy raw output and images from display projection", () => {
		const display = projectToolDisplay({
			toolName: "bash",
			args: { command: "echo test" },
			result: {
				content: [
					{ type: "text", text: "test" },
					{ type: "image", data: "base64encodedrawbytes", mimeType: "image/png" },
				],
			},
			expanded: true,
		});

		expect(display.images).toEqual([{ mimeType: "image/png" }]);
	});
});

describe("subagent semantic agentId drill-down targets in task view", () => {
	it("task view spans include agentId for live and settled agent rows", () => {
		const progress = ["agent-live-1", "agent-live-2"].map(
			(id, index): AgentProgress => ({
				index,
				id,
				agent: "task",
				agentSource: "bundled",
				status: "running",
				task: `Live worker ${index + 1}`,
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
			}),
		);
		const liveView = taskToolView.renderResult(
			{
				details: {
					projectAgentsDir: null,
					totalDurationMs: 0,
					progress,
					results: [],
				},
				content: [{ type: "text", text: "Live progress" }],
			},
			{ expanded: true, hasResult: false },
		);

		const blockView = liveView as FramedBlockView;
		expect(blockView.kind).toBe("framedBlock");
		const liveRows = blockView.sections?.flatMap(s => s.lines) ?? [];
		const liveAgentSpans = liveRows.flatMap(l => l.filter(span => span.agentId));
		expect(liveAgentSpans.length).toBeGreaterThanOrEqual(2);
		expect(liveAgentSpans.map(s => s.agentId)).toContain("agent-live-1");
		expect(liveAgentSpans.map(s => s.agentId)).toContain("agent-live-2");

		const settledView = taskToolView.renderResult(
			{
				details: {
					projectAgentsDir: null,
					totalDurationMs: 0,
					results: [
						{
							index: 0,
							id: "agent-settled-1",
							agent: "task",
							agentSource: "bundled",
							task: "Worker task",
							exitCode: 0,
							output: "Finished subagent",
							stderr: "",
							truncated: false,
							durationMs: 0,
							tokens: 0,
							requests: 0,
						},
					],
				},
				content: [{ type: "text", text: "Finished subagents" }],
			},
			{ expanded: true, hasResult: true },
		);

		const settledBlockView = settledView as FramedBlockView;
		expect(settledBlockView.kind).toBe("framedBlock");
		const settledRows = settledBlockView.sections?.flatMap(s => s.lines) ?? [];
		const settledAgentSpans = settledRows.flatMap(l => l.filter(span => span.agentId));
		expect(settledAgentSpans.length).toBeGreaterThanOrEqual(1);
		expect(settledAgentSpans.map(s => s.agentId)).toContain("agent-settled-1");
	});
});
