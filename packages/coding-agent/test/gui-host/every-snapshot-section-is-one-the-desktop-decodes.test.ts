/**
 * WHY: a `Snapshot` section the desktop cannot deserialize is a
 * `FatalProtocolError` and a dropped socket, not a warning: `FrameDecoder`
 * in `crates/veyyon-desktop/src/framing.rs` rejects the frame and the
 * transport closes. The defect this closes is a host handler emitting a
 * section name or shape the Rust `SnapshotSection` enum does not carry; the
 * class is any drift between the two mirrors of the wire.
 *
 * The fixture `crates/veyyon-desktop-model/tests/fixtures/snapshot-sections.json`
 * is read by both sides. Here the typed corpus below is checked against
 * `SnapshotSection` at `bun run check` time, and this test proves the file on
 * disk is that corpus byte-for-value and covers every tag in
 * `ALL_SNAPSHOT_SECTIONS`. The Rust side deserializes the same file into the
 * enum and asserts every variant is present.
 *
 * Not caught: a handler that emits a well-formed section with wrong contents.
 * The behaviour suites per action group assert those values.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ALL_SNAPSHOT_SECTIONS, getSnapshotSectionTag, type SnapshotSection } from "../../src/gui-host/wire";

const FIXTURE = path.join(
	import.meta.dirname,
	"../../../../crates/veyyon-desktop-model/tests/fixtures/snapshot-sections.json",
);

const CORPUS = [
	{
		Sessions: [
			{
				revision: 3,
				value: [
					{
						id: "sess-1",
						workspace: "repo",
						path: "/repo/.veyyon/sessions/sess-1.jsonl",
						cwd: "/repo",
						title: "Renamed Session",
						parent_path: null,
						created_at_ms: 1700000000000,
						modified_at_ms: 1700000001000,
						message_count: 2,
						size_bytes: 4096,
						first_message: "hello",
						searchable_messages: "hello world",
						status: "Complete",
					},
				],
			},
			[{ path: "/repo/.veyyon/sessions/broken.jsonl", reason: "header is not JSON" }],
		],
	},
	{
		ActiveSession: {
			revision: 4,
			value: {
				id: "sess-1",
				schema_version: 1,
				title: "Renamed Session",
				title_source: "user",
				parent: null,
				created_at_ms: 1700000000000,
				cwd: "/repo",
			},
		},
	},
	{
		Transcript: {
			revision: 5,
			value: [
				{
					id: "entry-1",
					parent: null,
					revision: 5,
					timestamp_ms: 1700000000000,
					role: "User",
					content: [{ Text: { text: "hello" } }],
					meta: null,
					raw_discriminator: "message",
					raw: { type: "message" },
				},
			],
		},
	},
	{
		Capabilities: [
			["Sessions", "Available"],
			["PendingEdits", { Unavailable: { reason: "the desktop holds no edit buffer" } }],
			["Lifecycle", "UnknownUntilAttached"],
		],
	},
	{
		Interactions: {
			session: "sess-1",
			pending: {
				approvals: [{ id: "int-1", tool_name: "bash", detail: "rm -rf build", requested_at_ms: 1700000002000 }],
				questions: [
					{
						id: "int-2",
						prompt: "Which backend?",
						options: ["SQLite", "Postgres"],
						requested_at_ms: 1700000002001,
					},
				],
				plans: [{ id: "int-3", markdown_plan: "# Plan\n\n1. Do the thing", requested_at_ms: 1700000002002 }],
			},
		},
	},
	{
		Settings: {
			"argot.enabled": {
				value: false,
				default: false,
				source: "default",
				type: "boolean",
				label: "Argot Shorthand",
				description: "Per-project shorthand vocabularies.",
				tab: "general",
				group: "Experimental",
				values: [],
				options: [],
				min: null,
				max: null,
				global: false,
				advanced: false,
				hidden: false,
			},
			"tools.approvalMode": {
				value: "auto",
				default: "auto",
				source: "profile",
				type: "enum",
				label: "Tool Approval",
				description: "How much the agent may do without asking.",
				tab: "interaction",
				group: "Approvals",
				values: ["plan", "ask", "auto"],
				options: [
					{ value: "ask", label: "Ask everything", description: "Every tool call asks first." },
					{ value: "auto", label: "Auto", description: null },
					{ value: "plan", label: "Plan", description: null },
				],
				min: null,
				max: null,
				global: false,
				advanced: false,
				hidden: false,
			},
			onboardingVersion: {
				value: 3,
				default: 0,
				source: "profile",
				type: "number",
				label: null,
				description: null,
				tab: null,
				group: null,
				values: [],
				options: [],
				min: 0,
				max: null,
				global: true,
				advanced: false,
				hidden: true,
			},
		},
	},
	{ Diagnostics: { sources: [{ name: "lsp", status: "ok" }] } },
	{
		Changes: {
			revision: 6,
			repository: "/repo",
			scope: "WorkingTree",
			files: [
				{ path: "src/app.ts", previous_path: null, status: "Modified", additions: 3, deletions: 1 },
				{ path: "src/new.ts", previous_path: "src/old.ts", status: "Renamed", additions: 0, deletions: 0 },
			],
			diff: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1,3 @@\n-old\n+new\n+lines\n+here\n",
		},
	},
	{
		FileTree: {
			root: "/repo",
			entries: [
				{ path: "src", name: "src", kind: "Directory", depth: 0 },
				{ path: "src/app.ts", name: "app.ts", kind: "File", depth: 1 },
				{ path: "link", name: "link", kind: "Symlink", depth: 0 },
			],
			truncated: false,
		},
	},
	{
		FileContent: {
			path: "src/app.ts",
			content: "export const x = 1;\n",
			size_bytes: 20,
			truncated: false,
			binary: false,
		},
	},
	{ SearchResults: { query: "app", paths: ["src/app.ts"], truncated: false } },
	{
		Terminals: [
			{ id: "term-1", cwd: "/repo", shell: "/bin/bash", cols: 80, rows: 24, status: "Running" },
			{ id: "term-2", cwd: "/repo", shell: "/bin/bash", cols: 80, rows: 24, status: { Exited: { code: 0 } } },
			{
				id: "term-3",
				cwd: "/repo",
				shell: "/bin/nosuch",
				cols: 80,
				rows: 24,
				status: { Failed: { message: "spawn ENOENT" } },
			},
		],
	},
	{ TerminalOutput: { terminal: "term-1", seq: 1, data: [36, 32], reset: true } },
	{
		Processes: [
			{
				name: "web",
				pid: 4242,
				status: "running",
				application: "bun",
				args: ["run", "dev"],
				cwd: "/repo",
				lifetime: "last-client-exit",
				started_at_ms: 1700000003000,
				exit_code: null,
				terminated_by: null,
			},
			{
				name: "old",
				pid: null,
				status: "exited",
				application: "bun",
				args: ["test"],
				cwd: "/repo",
				lifetime: "detached",
				started_at_ms: 1700000000000,
				exit_code: 1,
				terminated_by: "process-exit",
			},
		],
	},
	{ ProcessLogs: { process: "web", lines: ["Local: http://127.0.0.1:5173"], cursor: 1842, reset: true } },
	{
		Models: {
			models: [
				{
					provider: "anthropic",
					id: "claude-sonnet-4",
					name: "Claude Sonnet 4",
					reasoning: true,
					context_window: 200000,
					max_output: 64000,
				},
			],
			current: { provider: "anthropic", id: "claude-sonnet-4" },
			thinking_level: "medium",
			thinking_levels: ["off", "minimal", "low", "medium", "high", "xhigh"],
		},
	},
	{
		Providers: [
			{ id: "anthropic", name: "Anthropic", authenticated: true, oauth: true, api_key: true },
			{ id: "openai", name: "OpenAI", authenticated: false, oauth: true, api_key: true },
		],
	},
	{
		AuthFlow: {
			provider: "anthropic",
			state: "AwaitingBrowser",
			url: "https://example.invalid/oauth",
			prompt: null,
			message: null,
		},
	},
	{
		Mcp: [
			{ name: "filesystem", enabled: true, status: "Connected", tools: ["read_file", "list_dir"] },
			{ name: "broken", enabled: true, status: { Error: { message: "spawn failed" } }, tools: [] },
			{ name: "paused", enabled: false, status: "Disconnected", tools: [] },
		],
	},
	{ McpToolResult: { server: "filesystem", tool: "read_file", is_error: false, output: "contents" } },
	{
		Agents: [
			{
				id: "agent-1",
				display_name: "HostCoverage",
				kind: "sub",
				status: "running",
				parent: "main",
				scope: "/repo",
				session: "sess-1",
			},
		],
	},
	{
		Usage: {
			session: "sess-1",
			totals: {
				input_tokens: 1200,
				output_tokens: 300,
				cache_read_tokens: 800,
				cache_write_tokens: 0,
				orchestration_tokens: 0,
				premium_requests: 1,
				cost_microusd: 4200,
			},
		},
	},
	{
		ContextBreakdown: {
			session: "sess-1",
			total_tokens: 15000,
			limit_tokens: 200000,
			categories: [
				{ name: "system", tokens: 5000 },
				{ name: "messages", tokens: 10000 },
			],
		},
	},
	{ Export: { session: "sess-1", format: "html", path: "/repo/.veyyon/exports/sess-1.html", content: null } },
	{
		Themes: {
			themes: [
				{ id: "dark", name: "Dark", dark: true },
				{ id: "light", name: "Light", dark: false },
			],
			current: "dark",
		},
	},
	{ Keybindings: [{ action: "composer.send", keys: ["ctrl+enter"], source: "default" }] },
] satisfies SnapshotSection[];

describe("every snapshot section is one the desktop decodes", () => {
	test("the shared fixture is the typed corpus", async () => {
		const onDisk = JSON.parse(await fs.readFile(FIXTURE, "utf8")) as unknown;
		expect(onDisk).toEqual(CORPUS);
	});

	test("the corpus carries every section tag once", () => {
		const tags = CORPUS.map(section => getSnapshotSectionTag(section));
		expect(tags).toEqual([...ALL_SNAPSHOT_SECTIONS]);
	});
});
