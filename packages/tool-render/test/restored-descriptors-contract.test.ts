import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveToolRenderer } from "../src/registry";
import type { ToolRenderProps, ToolResultLike } from "../src/types";

function renderSummary(name: string, args: Record<string, unknown>, result?: ToolResultLike): string {
	const renderer = resolveToolRenderer(name);
	return renderToStaticMarkup(createElement(renderer.Summary, { name, args, result } as ToolRenderProps));
}

function renderBody(name: string, args: Record<string, unknown>, result?: ToolResultLike): string {
	const renderer = resolveToolRenderer(name);
	if (!renderer.Body) return "";
	return renderToStaticMarkup(createElement(renderer.Body, { name, args, result } as ToolRenderProps));
}

describe("Restored descriptors contract", () => {
	describe("fs.tsx descriptors (read, write, edit, set_cwd)", () => {
		it("renders read summary with line range selector and body with conflict/elided/truncated badges", () => {
			const summary = renderSummary("read", {
				path: "src/foo.ts:10-50:raw",
			});
			expect(summary).toContain("src/foo.ts");
			expect(summary).toContain(":10-50:raw");

			const body = renderBody(
				"read",
				{ path: "src/foo.ts" },
				{
					content: [{ type: "text", text: "line 1\nline 2" }],
					details: {
						conflictCount: 2,
						summary: { elidedSpans: 3 },
						truncation: { totalLines: 500 },
					},
				},
			);
			expect(body).toContain("2 conflicts");
			expect(body).toContain("3 elided spans");
			expect(body).toContain("truncated");
		});

		it("renders write summary and body with multi-line count, madeExecutable, and diagnostics", () => {
			const summary = renderSummary("write", {
				path: "src/new.ts",
				content: "line1\nline2\nline3",
			});
			expect(summary).toContain("src/new.ts");
			expect(summary).toContain("3 lines");

			const body = renderBody(
				"write",
				{
					path: "src/new.ts",
					content: "console.log('hi')",
				},
				{
					content: [{ type: "text", text: "Wrote 18 bytes" }],
					details: {
						madeExecutable: true,
						diagnostics: {
							server: "typescript",
							summary: "typecheck clean",
							messages: ["no errors"],
							errored: false,
						},
					},
				},
			);
			expect(body).toContain("made executable");
			expect(body).toContain("typescript: typecheck clean");
			expect(body).toContain("no errors");
		});

		it("renders write with invalid/non-string content as expected string error and missing path as invalid arg", () => {
			// Non-string content (number or object) must report expected string error note without coercion
			const bodyNum = renderBody("write", {
				path: "src/new.ts",
				content: 12345,
			});
			expect(bodyNum).toContain("expected string");
			expect(bodyNum).toContain("content");

			const bodyObj = renderBody("write", {
				path: "src/new.ts",
				content: { some: "object" },
			});
			expect(bodyObj).toContain("expected string");

			const bodyNull = renderBody("write", {
				path: "src/new.ts",
				content: null,
			});
			expect(bodyNull).toContain("expected string");

			// Missing path in write summary renders invalid path
			const summaryNoPath = renderSummary("write", {
				content: "data",
			});
			expect(summaryNoPath).toContain("path");

			// Single line or empty content does not show line count badge
			const summarySingle = renderSummary("write", {
				path: "file.txt",
				content: "single line",
			});
			expect(summarySingle).not.toContain("lines");

			const summaryEmpty = renderSummary("write", {
				path: "file.txt",
				content: "",
			});
			expect(summaryEmpty).not.toContain("lines");

			// CRLF content counts lines accurately without allocation
			const summaryCrlf = renderSummary("write", {
				path: "crlf.txt",
				content: "a\r\nb\r\nc\r\n",
			});
			expect(summaryCrlf).toContain("4 lines");
		});

		it("renders edit summary with hashline headers, op counts, line additions and removals", () => {
			const summary = renderSummary(
				"edit",
				{
					input: "[src/index.ts#1A2B]\nreplace 10..15:\n+new code",
				},
				{
					content: [],
					details: {
						diff: "+added line 1\n+added line 2\n-removed line 1",
					},
				},
			);
			expect(summary).toContain("src/index.ts");
			expect(summary).toContain("1 op");
			expect(summary).toContain("+2");
			expect(summary).toContain("−1");

			const body = renderBody(
				"edit",
				{
					input: "[src/index.ts#1A2B]\nreplace 10..15:\n+new code",
				},
				{
					content: [],
					details: {
						path: "src/index.ts",
						diff: "+added line 1\n+added line 2\n-removed line 1",
						firstChangedLine: 10,
					},
				},
			);
			expect(body).toContain("src/index.ts");
			expect(body).toContain("added line 1");
		});

		it("renders set_cwd summary and body with rule deltas and path transitions", () => {
			const summary = renderSummary(
				"set_cwd",
				{
					path: "/workspace/agent",
				},
				{
					content: [],
					details: {
						previous: "/workspace",
						cwd: "/workspace/agent",
						rulesApplied: ["/workspace/agent/AGENTS.md"],
						rulesDropped: [],
					},
				},
			);
			expect(summary).toContain("cwd");
			expect(summary).toContain("/workspace/agent");
			expect(summary).toContain("+1 rule file");

			const body = renderBody(
				"set_cwd",
				{
					path: "/workspace/agent",
				},
				{
					content: [{ type: "text", text: "Changed directory" }],
					details: {
						previous: "/workspace",
						cwd: "/workspace/agent",
						rulesApplied: ["/workspace/agent/AGENTS.md"],
						rulesDropped: ["/workspace/CLAUDE.md"],
					},
				},
			);
			expect(body).toContain("from");
			expect(body).toContain("to");
			expect(body).toContain("now applies");
			expect(body).toContain("no longer applies");
			expect(body).toContain("/workspace/agent/AGENTS.md");
			expect(body).toContain("/workspace/CLAUDE.md");
		});
	});

	describe("memory.tsx descriptors (generate_image, inspect_image, ast_edit, memory tools)", () => {
		it("renders generate_image with subject, aspect ratio, prompt grid, and revised prompt", () => {
			const summary = renderSummary("generate_image", {
				subject: "A neon cyberpunk cityscape at sunset",
				aspect_ratio: "16:9",
				changes: ["make it rain", "add flying cars"],
			});
			expect(summary).toContain("A neon cyberpunk cityscape at sunset");
			expect(summary).toContain("16:9");
			expect(summary).toContain("edit ×2");

			const result: ToolResultLike = {
				content: [
					{
						type: "image",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
						mimeType: "image/png",
					},
				],
				details: {
					provider: "openai",
					model: "dall-e-3",
					revisedPrompt: "Enhanced neon cyberpunk cityscape with heavy rain",
					imagePaths: ["/workspace/output.png"],
				},
			};
			const body = renderBody("generate_image", { subject: "A neon cityscape", style: "photorealistic" }, result);
			expect(body).toContain("image/png");
			expect(body).toContain("photorealistic");
			expect(body).toContain("dall-e-3");
			expect(body).toContain("Enhanced neon cyberpunk cityscape with heavy rain");
			expect(body).toContain("/workspace/output.png");
		});

		it("renders inspect_image with target path, question, model and inspected image rendering", () => {
			const summary = renderSummary("inspect_image", {
				path: "assets/logo.png",
			});
			expect(summary).toContain("assets/logo.png");

			const body = renderBody(
				"inspect_image",
				{
					path: "assets/logo.png",
					question: "What is the text on this badge?",
				},
				{
					content: [
						{
							type: "image",
							data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
							mimeType: "image/png",
						},
					],
					details: { model: "claude-3-5-sonnet", mimeType: "image/png" },
				},
			);
			expect(body).toContain("assets/logo.png");
			expect(body).toContain("What is the text on this badge?");
			expect(body).toContain("claude-3-5-sonnet");
			expect(body).toContain("image/png");
		});

		it("renders ast_edit with pattern replacements, language badges, and replacement statistics", () => {
			const summary = renderSummary(
				"ast_edit",
				{
					paths: ["src/**/*.ts", "src/util.ts"],
					ops: [{ pat: "$A && $A()", out: "$A?.()" }],
				},
				{
					content: [],
					details: {
						totalReplacements: 14,
					},
				},
			);
			expect(summary).toContain("src/**/*.ts");
			expect(summary).toContain("+1 more");
			expect(summary).toContain("1 op");
			expect(summary).toContain("14 replacements");

			const body = renderBody(
				"ast_edit",
				{
					paths: ["src/index.ts"],
					ops: [{ pat: "console.log($$$A)", out: "logger.debug($$$A)" }],
				},
				{
					content: [],
					details: {
						totalReplacements: 4,
						filesTouched: 1,
						filesSearched: 12,
						scopePath: "src",
						fileReplacements: [{ path: "src/index.ts", count: 4 }],
					},
				},
			);
			expect(body).toContain("console.log($$$A)");
			expect(body).toContain("logger.debug($$$A)");
			expect(body).toContain("4 replacements");
			expect(body).toContain("1 file");
			expect(body).toContain("searched 12");
			expect(body).toContain("in src");
			expect(body).toContain("src/index.ts");
		});

		it("renders memory_edit, recall, reflect, retain with keys, relevance scores and triples", () => {
			const recallSummary = renderSummary(
				"recall",
				{
					query: "user preference theme dark",
				},
				{
					content: [
						{
							type: "text",
							text: "Found 3 relevant memories (as of 2026-04-01 UTC):\n- prefers dark mode [pref] (2026-03-15)\n- uses tmux [tool] (2026-03-20)",
						},
					],
				},
			);
			expect(recallSummary).toContain("user preference theme dark");
			expect(recallSummary).toContain("3 found");

			const recallBody = renderBody(
				"recall",
				{
					query: "user preference theme dark",
				},
				{
					content: [
						{
							type: "text",
							text: "Found 2 relevant memories (as of 2026-04-01 UTC):\n- prefers dark mode [pref] (2026-03-15)\n- uses tmux [tool] (2026-03-20)",
						},
					],
				},
			);
			expect(recallBody).toContain("prefers dark mode");
			expect(recallBody).toContain("pref");
			expect(recallBody).toContain("2026-03-15");

			const retainSummary = renderSummary("retain", {
				items: [{ content: "Operator prefers dark theme", context: "settings" }],
			});
			expect(retainSummary).toContain("1 memory");
			expect(retainSummary).toContain("Operator prefers dark theme");

			const retainBody = renderBody(
				"retain",
				{
					items: [{ content: "Operator prefers dark theme", context: "settings" }],
				},
				{
					content: [],
					details: { count: 1 },
				},
			);
			expect(retainBody).toContain("Operator prefers dark theme");
			expect(retainBody).toContain("settings");
			expect(retainBody).toContain("1 memory retained");
		});
	});

	describe("search.tsx descriptors (search, search_tool_bm25, web_search)", () => {
		it("renders search with files, text, and structure modes", () => {
			const filesSummary = renderSummary("search", {
				type: "files",
				input: "**/*.tsx",
				path: "packages/tool-render",
			});
			expect(filesSummary).toContain("**/*.tsx");

			const filesBody = renderBody(
				"search",
				{
					type: "files",
					input: "**/*.tsx",
					limit: 50,
				},
				{
					content: [],
					details: {
						fileCount: 42,
						scopePath: "src",
					},
				},
			);
			expect(filesBody).toContain("limit 50");
			expect(filesBody).toContain("42 files");
			expect(filesBody).toContain("in src");

			const textSummary = renderSummary("search", {
				type: "text",
				input: "TODO|FIXME",
				path: "src",
				case: true,
			});
			expect(textSummary).toContain("/TODO|FIXME/");
			expect(textSummary).toContain("src");
			expect(textSummary).toContain("case");

			const structSummary = renderSummary("search", {
				type: "structure",
				input: "console.log($$$ARGS)",
			});
			expect(structSummary).toContain("console.log($$$ARGS)");
		});

		it("renders web_search with query, recency badge and source rows", () => {
			const summary = renderSummary("web_search", {
				query: "TypeScript 5.5 features",
				recency: "month",
			});
			expect(summary).toContain("TypeScript 5.5 features");
			expect(summary).toContain("month");

			const body = renderBody(
				"web_search",
				{
					query: "TypeScript 5.5 features",
				},
				{
					content: [],
					details: {
						response: {
							provider: "google",
							sources: [
								{
									url: "https://devblogs.microsoft.com/typescript/5-5",
									title: "Announcing TypeScript 5.5",
								},
							],
						},
					},
				},
			);
			expect(body).toContain("Announcing TypeScript 5.5");
			expect(body).toContain("devblogs.microsoft.com");
		});
	});

	describe("system.tsx descriptors (bash, ssh, launch, job, debug, eval, lsp, browser, fetch, github)", () => {
		it("renders bash summary and body with exit code, duration, and artifact notices", () => {
			const summary = renderSummary("bash", { command: "cargo test" });
			expect(summary).toContain("cargo test");

			const body = renderBody(
				"bash",
				{ command: "cargo test --all" },
				{
					content: [{ type: "text", text: "test output line\n[raw output: artifact://art_failed_output]" }],
					details: {
						exitCode: 101,
						wallTimeMs: 3200,
					},
				},
			);
			expect(body).toContain("exit 101");
			expect(body).toContain("wall 3.2s");
			expect(body).toContain("artifact art_failed_output");
		});

		it("renders ssh summary and body with host, command and exit status", () => {
			const summary = renderSummary("ssh", { host: "santhserver", command: "uptime" });
			expect(summary).toContain("santhserver");
			expect(summary).toContain("uptime");

			const body = renderBody(
				"ssh",
				{ host: "santhserver", command: "systemctl status" },
				{
					content: [{ type: "text", text: "active (running)" }],
				},
			);
			expect(body).toContain("santhserver");
			expect(body).toContain("systemctl status");
			expect(body).toContain("active (running)");
		});

		it("renders launch summary and body with daemons, states, exit phrases and logs", () => {
			const summary = renderSummary(
				"launch",
				{ op: "start", name: "dev-server" },
				{
					content: [],
					details: {
						daemon: { name: "dev-server", state: "running", pid: 12345 },
					},
				},
			);
			expect(summary).toContain("start");
			expect(summary).toContain("dev-server");
			expect(summary).toContain("running");

			const body = renderBody(
				"launch",
				{ op: "logs", name: "dev-server" },
				{
					content: [],
					details: {
						daemon: { name: "dev-server", state: "exited", exitCode: 137, signal: "SIGKILL" },
						terminalRows: ["Server listening on port 3000", "Killed by OOM"],
					},
				},
			);
			expect(body).toContain("killed by SIGKILL");
			expect(body).toContain("Server listening on port 3000");
		});

		it("renders job summary and body with poll/cancel badges, status tallies, and durations", () => {
			const summary = renderSummary("job", {
				poll: ["job_1", "job_2"],
				cancel: ["job_3"],
			});
			expect(summary).toContain("poll job_1, job_2");
			expect(summary).toContain("cancel job_3");

			const body = renderBody(
				"job",
				{},
				{
					content: [],
					details: {
						jobs: [
							{
								id: "job_1",
								type: "bash",
								status: "running",
								label: "build step",
								durationMs: 4500,
								resultText: "",
								errorText: "",
							},
							{
								id: "job_2",
								type: "task",
								status: "completed",
								label: "subagent audit",
								durationMs: 12300,
								resultText: "Audit passed with 0 warnings",
								errorText: "",
							},
						],
					},
				},
			);
			expect(body).toContain("waiting on 1 of 2");
			expect(body).toContain("1 done");
			expect(body).toContain("build step");
			expect(body).toContain("4.5s");
			expect(body).toContain("Audit passed with 0 warnings");
		});

		it("renders debug action badges, stopped reason and frame inspection", () => {
			const summary = renderSummary("debug", {
				action: "set_breakpoint",
				file: "src/main.rs",
				line: 42,
			});
			expect(summary).toContain("set breakpoint");
			expect(summary).toContain("src/main.rs");
			expect(summary).toContain("42");

			const body = renderBody(
				"debug",
				{ action: "stack_trace" },
				{
					content: [{ type: "text", text: "frame 0: main at src/main.rs:42" }],
					details: {
						snapshot: {
							id: "sess_1",
							adapter: "lldb-dap",
							status: "stopped",
							program: "src/main.rs",
							stopReason: "breakpoint hit",
							frameName: "main",
							sourcePath: "src/main.rs",
							line: 42,
							column: 5,
						},
					},
				},
			);
			expect(body).toContain("sess_1");
			expect(body).toContain("lldb-dap");
			expect(body).toContain("breakpoint hit");
			expect(body).toContain("src/main.rs");
			expect(body).toContain(":42:5");
		});

		it("renders browser actions, selectors and screenshot outputs", () => {
			const summary = renderSummary("browser", {
				action: "open",
				url: "https://example.com",
			});
			expect(summary).toContain("open");
			expect(summary).toContain("https://example.com");

			const body = renderBody(
				"browser",
				{
					action: "screenshot",
					name: "main",
				},
				{
					content: [
						{
							type: "image",
							data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
							mimeType: "image/png",
						},
					],
					details: { title: "Example Domain", url: "https://example.com" },
				},
			);
			expect(body).toContain("image/png");
			expect(body).toContain("https://example.com");
		});

		it("renders fetch method, url, and headers", () => {
			const summary = renderSummary("fetch", {
				url: "https://api.github.com/repos/santhreal/veyyon",
				method: "POST",
			});
			expect(summary).toContain("https://api.github.com/repos/santhreal/veyyon");
			expect(summary).toContain("POST");

			const body = renderBody(
				"fetch",
				{
					url: "https://api.github.com/repos/santhreal/veyyon",
					method: "GET",
				},
				{
					content: [],
					details: {
						url: "https://api.github.com/repos/santhreal/veyyon",
						finalUrl: "https://api.github.com/repositories/123",
						contentType: "application/json",
						method: "curl",
						notes: ["redirected"],
					},
				},
			);
			expect(body).toContain("https://api.github.com/repositories/123");
			expect(body).toContain("application/json");
			expect(body).toContain("redirected");
		});

		it("renders eval js/py code cells and execution time", () => {
			const summary = renderSummary("eval", {
				language: "py",
				title: "run simulation",
				code: "x = 42\nprint(x)",
			});
			expect(summary).toContain("run simulation");
			expect(summary).toContain("py");

			const body = renderBody(
				"eval",
				{
					language: "py",
					code: "print('hello')",
				},
				{
					content: [{ type: "text", text: "hello" }],
					details: {
						cells: [
							{
								index: 0,
								language: "py",
								title: "cell 1",
								code: "print('hello')",
								output: "hello\n",
								status: "ok",
								durationMs: 120,
							},
						],
					},
				},
			);
			expect(body).toContain("print(&#x27;hello&#x27;)");
			expect(body).toContain("120ms");
		});

		// Each routing signal is isolated: a code field must not make an op-only
		// case pass when that operation is no longer recognized.
		it.each([
			{ signal: { op: "eval" }, target: "eval" },
			{ signal: { op: "exec" }, target: "eval" },
			{ signal: { op: "session_start" }, target: "eval" },
			{ signal: { op: "session_stop" }, target: "eval" },
			{ signal: { code: "print(1)" }, target: "eval" },
			{ signal: { language: "py" }, target: "eval" },
			{ signal: { op: "start" }, target: "launch" },
			{ signal: { op: "stop" }, target: "launch" },
			{ signal: { op: "unknown", code: 1, language: false }, target: "launch" },
		])("renders both runtime surfaces through $target for $signal", ({ signal, target }) => {
			const args = { name: "worker", application: "runner", ...signal };
			const result: ToolResultLike = {
				content: [{ type: "text", text: "finished" }],
				details: {
					cells: [{ index: 0, language: "py", code: "print(1)", output: "1", status: "ok" }],
				},
			};
			for (const render of [renderSummary, renderBody]) {
				const expected = render(target, args, result);
				const other = render(target === "eval" ? "launch" : "eval", args, result);
				expect(expected).not.toEqual(other);
				expect(render("runtime", args, result)).toEqual(expected);
			}
		});

		it("renders lsp requests with method, file and location details", () => {
			const summary = renderSummary("lsp", {
				action: "definition",
				file: "src/app.ts",
				line: 15,
			});
			expect(summary).toContain("definition");
			expect(summary).toContain("src/app.ts");
			expect(summary).toContain("15");

			const body = renderBody(
				"lsp",
				{ action: "references", file: "src/app.ts", line: 15 },
				{
					content: [{ type: "text", text: "src/app.ts:15:8\nsrc/other.ts:22:4\n2 reference(s)" }],
				},
			);
			expect(body).toContain("2 references");
			expect(body).toContain("src/other.ts");
		});
	});

	describe("agent.tsx descriptors (task, ask, irc, goal, yield)", () => {
		it("renders ask question and options", () => {
			const summary = renderSummary("ask", {
				question: "Should we proceed with migration?",
				options: ["yes", "no"],
			});
			expect(summary).toContain("Should we proceed with migration?");

			const body = renderBody(
				"ask",
				{
					question: "Pick database",
					options: [
						{ label: "PostgreSQL", description: "Relational DB" },
						{ label: "SQLite", description: "Embedded DB" },
					],
				},
				{
					content: [{ type: "text", text: "PostgreSQL selected" }],
					details: {
						question: "Pick database",
						selectedOptions: ["PostgreSQL"],
					},
				},
			);
			expect(body).toContain("PostgreSQL");
			expect(body).toContain("SQLite");
			expect(body).toContain("Relational DB");
		});

		it("renders irc operations and recipient badges", () => {
			const summary = renderSummary("irc", {
				op: "send",
				to: "AuthWorker",
				message: "Is JWT ready?",
			});
			expect(summary).toContain("send");
			expect(summary).toContain("AuthWorker");
			expect(summary).toContain("Is JWT ready?");

			const body = renderBody(
				"irc",
				{ op: "inbox" },
				{
					content: [{ type: "text", text: "1 message in inbox" }],
					details: {
						inbox: [{ from: "AuthWorker", body: "JWT handler is ready." }],
					},
				},
			);
			expect(body).toContain("AuthWorker");
			expect(body).toContain("JWT handler is ready.");
		});

		it("renders goal objective and progress status", () => {
			const summary = renderSummary(
				"goal",
				{
					op: "create",
					objective: "Implement unified tool renderers",
				},
				{
					content: [],
					details: {
						goal: {
							objective: "Implement unified tool renderers",
							status: "in-progress",
							tokenBudget: 100000,
							tokensUsed: 12000,
						},
					},
				},
			);
			expect(summary).toContain("set");
			expect(summary).toContain("Implement unified tool renderers");
			expect(summary).toContain("in-progress");

			const body = renderBody(
				"goal",
				{ op: "get" },
				{
					content: [],
					details: {
						goal: {
							objective: "Implement unified tool renderers",
							status: "in-progress",
							tokenBudget: 100000,
							tokensUsed: 12000,
						},
					},
				},
			);
			expect(body).toContain("12K / 100K tokens");
		});

		it("renders yield result and error payloads", () => {
			const summary = renderSummary("yield", {
				data: { status: "ok", count: 42 },
			});
			expect(summary).toContain("42");

			const body = renderBody(
				"yield",
				{
					data: { status: "ok", items: [1, 2, 3] },
				},
				{
					content: [{ type: "text", text: '{"status":"ok"}' }],
				},
			);
			expect(body).toContain("items");
		});
	});
});
