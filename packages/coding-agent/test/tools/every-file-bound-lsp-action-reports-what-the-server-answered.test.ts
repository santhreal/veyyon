/**
 * What a file-bound LSP action reports, driven through the tool against an in-process server.
 *
 * WHY. `LspTool` routes every action that names a file through one shared preamble (start the server,
 * open the file, wait for the project, resolve the cursor) and then one handler per action. The class
 * this suite closes is a handler whose report drifts from what the server answered, whose empty answer
 * gains or loses the `useless` flag compaction elides a result by, or whose side effect (a file edit, a
 * workspace command) stops reaching the disk or the server. Every file-bound action the schema declares
 * is swept, so a new one turns this red until it has cases here.
 *
 * WHAT THIS DOES NOT CATCH. The file-less actions (`status`, `diagnostics`, `rename_file`,
 * `capabilities`, `request`) and rust-analyzer's workspace wait are `lsp-regressions.test.ts`'s. No
 * server here outlives the tool's wall-clock budget, so the mapping of a timeout to a `ToolError` is not
 * exercised; only the caller-cancel half of that mapping is. The fake loads its project as it
 * initializes, so a project-indexed action that skipped the wait for the project load would pass here.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@veyyon/agent-core";
import { LspTool } from "@veyyon/coding-agent/lsp";
import * as lspClient from "@veyyon/coding-agent/lsp/client";
import * as lspConfig from "@veyyon/coding-agent/lsp/config";
import {
	type LspParams,
	type LspToolDetails,
	lspSchema,
	type Range,
	type ServerConfig,
} from "@veyyon/coding-agent/lsp/types";
import { fileToUri, symbolKindToIcon } from "@veyyon/coding-agent/lsp/utils";
import { ToolAbortError, ToolError } from "@veyyon/coding-agent/tools/core/tool-errors";
import { TempDir } from "@veyyon/utils";
import { type FakeLspHandler, type FakeLspServer, installFakeLsp } from "../helpers/fake-lsp";
import { makeToolSession } from "../helpers/tool-session";

/** The actions the tool answers without a file-bound server; everything else goes through the preamble. */
const FILE_LESS_ACTIONS = ["capabilities", "diagnostics", "rename_file", "request", "status"] as const;

type FileBoundAction = Exclude<LspParams["action"], (typeof FILE_LESS_ACTIONS)[number]>;

const SERVER_NAME = "fake-ts";
const SERVER: ServerConfig = {
	command: SERVER_NAME,
	resolvedCommand: process.execPath,
	fileTypes: ["ts"],
	rootMarkers: [],
};

const SOURCE = 'export function greet(name: string) {\n\treturn name;\n}\ngreet("a");\n';
const RENAMED = 'export function welcome(name: string) {\n\treturn name;\n}\nwelcome("a");\n';
const RETURN_TYPED = 'export function greet(name: string): string {\n\treturn name;\n}\ngreet("a");\n';

function range(line: number, start: number, end: number): Range {
	return { start: { line, character: start }, end: { line, character: end } };
}

const GREET_DECLARATION = range(0, 16, 21);
const GREET_CALL = range(3, 0, 5);

/** How a location in the fixture is listed: its position, then the line either side of it. */
const AT_DECLARATION = [
	"  src/app.ts:1:17",
	"    1: export function greet(name: string) {",
	"    2: \treturn name;",
].join("\n");
const AT_CALL = ["  src/app.ts:4:1", "    3: }", '    4: greet("a");', "    5: "].join("\n");

type RpcAnswer = { readonly result: unknown } | { readonly error: { readonly code: number; readonly message: string } };

interface Fixture {
	readonly dir: string;
	readonly file: string;
	readonly uri: string;
}

interface ActionCase {
	/** What the case exercises. */
	readonly name: string;
	/** Params beyond `action` and `file`. */
	readonly params?: Omit<LspParams, "action" | "file">;
	/** What the server answers, by method; any other request is answered method-not-found. */
	readonly answers?: (fixture: Fixture) => Readonly<Record<string, RpcAnswer>>;
	/** The text the result carries. */
	readonly text: string;
	/** Whether the result is a bare empty lookup that compaction may elide. */
	readonly useless?: true;
	/** What else the action must have done. */
	readonly after?: (fixture: Fixture, server: FakeLspServer) => void;
}

function requestsFor(server: FakeLspServer, method: string): unknown[] {
	return server.received.filter(message => message.method === method && message.id !== undefined);
}

function locationCases(noun: string, method: string): ActionCase[] {
	return [
		{
			name: "lists each location with the line either side",
			params: { line: 4, symbol: "greet" },
			answers: ({ uri }) => ({ [method]: { result: [{ uri, range: GREET_DECLARATION }] } }),
			text: `Found 1 ${noun}(s):\n${AT_DECLARATION}`,
		},
		{
			name: "lists a location link at its selection range",
			params: { line: 4, symbol: "greet" },
			answers: ({ uri }) => ({
				[method]: {
					result: [{ targetUri: uri, targetRange: range(0, 0, 38), targetSelectionRange: GREET_DECLARATION }],
				},
			}),
			text: `Found 1 ${noun}(s):\n${AT_DECLARATION}`,
		},
		{
			name: "reports an empty answer as a useless lookup",
			params: { line: 4, symbol: "greet" },
			answers: () => ({ [method]: { result: null } }),
			text: `No ${noun} found`,
			useless: true,
		},
	];
}

const ADD_RETURN_TYPE_EDIT = (uri: string) => ({
	changes: { [uri]: [{ range: range(0, 35, 35), newText: ": string" }] },
});

const CODE_ACTIONS = (uri: string) => [
	{ title: "Add return type", kind: "quickfix", isPreferred: true, edit: ADD_RETURN_TYPE_EDIT(uri) },
	{ title: "Organize imports", command: "organize" },
];

const CODE_ACTION_LIST = ["  0: [quickfix] Add return type (preferred)", "  1: [action] Organize imports"].join("\n");

/** A call hierarchy item named `name`, declared at `selection` in the file `uri` names. */
function callItem(name: string, uri: string, selection: Range) {
	return { name, kind: 12, uri, range: selection, selectionRange: selection };
}

const CALLER = range(3, 0, 5);
const GREET_BODY_CALL = range(1, 8, 12);
const GREET_ITEM_ROW = "greet (Function) at src/app.ts:1:17";

/** A file under the fixture that does not exist, so a call site read from it has no source line. */
const MISSING_URI = ({ dir }: Fixture) => fileToUri(path.join(dir, "src", "lib.ts"));

const CASES: Readonly<Record<FileBoundAction, readonly ActionCase[]>> = {
	definition: locationCases("definition", "textDocument/definition"),
	type_definition: locationCases("type definition", "textDocument/typeDefinition"),
	implementation: locationCases("implementation", "textDocument/implementation"),
	incoming_calls: [
		{
			name: "lists each caller with its call sites, a repeated site once",
			params: { line: 1, symbol: "greet" },
			answers: ({ uri }) => ({
				"textDocument/prepareCallHierarchy": { result: [callItem("greet", uri, GREET_DECLARATION)] },
				"callHierarchy/incomingCalls": {
					result: [{ from: callItem("main", uri, CALLER), fromRanges: [GREET_CALL, GREET_CALL] }],
				},
			}),
			text: [
				`Found 1 caller(s) of ${GREET_ITEM_ROW}:`,
				"  main (Function) at src/app.ts:4:1",
				'    4:1: greet("a");',
			].join("\n"),
			after: ({ uri }, server) => {
				expect(requestsFor(server, "callHierarchy/incomingCalls")).toEqual([
					expect.objectContaining({ params: { item: callItem("greet", uri, GREET_DECLARATION) } }),
				]);
			},
		},
		{
			name: "asks for the callers of every item the server prepared",
			params: { line: 1, symbol: "greet" },
			answers: fixture => ({
				"textDocument/prepareCallHierarchy": {
					result: [
						callItem("greet", fixture.uri, GREET_DECLARATION),
						callItem("greet", MISSING_URI(fixture), GREET_DECLARATION),
					],
				},
				"callHierarchy/incomingCalls": {
					result: [{ from: callItem("main", fixture.uri, CALLER), fromRanges: [GREET_CALL] }],
				},
			}),
			text: [
				`Found 1 caller(s) of ${GREET_ITEM_ROW}:`,
				"  main (Function) at src/app.ts:4:1",
				'    4:1: greet("a");',
				"",
				"Found 1 caller(s) of greet (Function) at src/lib.ts:1:17:",
				"  main (Function) at src/app.ts:4:1",
				'    4:1: greet("a");',
			].join("\n"),
		},
		{
			name: "reports a position with no callable symbol as a useless lookup",
			params: { line: 1, symbol: "greet" },
			answers: () => ({ "textDocument/prepareCallHierarchy": { result: null } }),
			text: "No callable symbol at this position",
			useless: true,
			after: (_fixture, server) => {
				expect(requestsFor(server, "callHierarchy/incomingCalls")).toEqual([]);
			},
		},
		{
			name: "reports a symbol nothing calls as a useless lookup",
			params: { line: 1, symbol: "greet" },
			answers: ({ uri }) => ({
				"textDocument/prepareCallHierarchy": { result: [callItem("greet", uri, GREET_DECLARATION)] },
				"callHierarchy/incomingCalls": { result: [] },
			}),
			text: `No callers of ${GREET_ITEM_ROW}`,
			useless: true,
		},
	],
	outgoing_calls: [
		{
			name: "lists each callee with its call sites read from the calling file",
			params: { line: 1, symbol: "greet" },
			answers: fixture => ({
				"textDocument/prepareCallHierarchy": { result: [callItem("greet", fixture.uri, GREET_DECLARATION)] },
				"callHierarchy/outgoingCalls": {
					result: [{ to: callItem("echo", MISSING_URI(fixture), range(0, 0, 4)), fromRanges: [GREET_BODY_CALL] }],
				},
			}),
			text: [
				`Found 1 callee(s) from ${GREET_ITEM_ROW}:`,
				"  echo (Function) at src/lib.ts:1:1",
				"    2:9: return name;",
			].join("\n"),
		},
		{
			name: "states a call site in a file that no longer exists as its position",
			params: { line: 1, symbol: "greet" },
			answers: fixture => ({
				"textDocument/prepareCallHierarchy": {
					result: [callItem("greet", MISSING_URI(fixture), GREET_DECLARATION)],
				},
				"callHierarchy/outgoingCalls": {
					result: [{ to: callItem("echo", fixture.uri, range(0, 0, 4)), fromRanges: [GREET_BODY_CALL] }],
				},
			}),
			text: [
				"Found 1 callee(s) from greet (Function) at src/lib.ts:1:17:",
				"  echo (Function) at src/app.ts:1:1",
				"    2:9",
			].join("\n"),
		},
		{
			name: "reports a symbol that calls nothing as a useless lookup",
			params: { line: 1, symbol: "greet" },
			answers: ({ uri }) => ({
				"textDocument/prepareCallHierarchy": { result: [callItem("greet", uri, GREET_DECLARATION)] },
				"callHierarchy/outgoingCalls": { result: null },
			}),
			text: `No callees from ${GREET_ITEM_ROW}`,
			useless: true,
		},
	],
	references: [
		{
			name: "lists every reference with the line either side",
			params: { line: 1, symbol: "greet" },
			answers: ({ uri }) => ({
				"textDocument/references": {
					result: [
						{ uri, range: GREET_DECLARATION },
						{ uri, range: GREET_CALL },
					],
				},
			}),
			text: `Found 2 reference(s):\n${AT_DECLARATION}\n${AT_CALL}`,
			after: (_fixture, server) => {
				expect(requestsFor(server, "textDocument/references")).toHaveLength(1);
			},
		},
		{
			name: "lists references past the context limit without their lines",
			params: { line: 1, symbol: "greet" },
			answers: ({ uri }) => ({
				"textDocument/references": { result: Array.from({ length: 52 }, () => ({ uri, range: GREET_CALL })) },
			}),
			text: [
				"Found 52 reference(s):",
				...Array.from({ length: 50 }, () => AT_CALL),
				"  ... 2 additional reference(s) shown without context",
				"  src/app.ts:4:1",
				"  src/app.ts:4:1",
			].join("\n"),
		},
		{
			name: "asks again, a bounded number of times, while only the declaration comes back",
			params: { line: 1, symbol: "greet" },
			answers: ({ uri }) => ({ "textDocument/references": { result: [{ uri, range: GREET_DECLARATION }] } }),
			text: `Found 1 reference(s):\n${AT_DECLARATION}`,
			after: (_fixture, server) => {
				expect(requestsFor(server, "textDocument/references")).toHaveLength(3);
			},
		},
		{
			name: "reports no references as a useless lookup after the bounded retries",
			params: { line: 1, symbol: "greet" },
			answers: () => ({ "textDocument/references": { result: [] } }),
			text: "No references found",
			useless: true,
			after: (_fixture, server) => {
				expect(requestsFor(server, "textDocument/references")).toHaveLength(3);
			},
		},
	],
	hover: [
		{
			name: "reports the markup the server answered",
			params: { line: 4, symbol: "greet" },
			answers: () => ({
				"textDocument/hover": {
					result: { contents: { kind: "markdown", value: "```ts\nfunction greet(name: string): void\n```" } },
				},
			}),
			text: "```ts\nfunction greet(name: string): void\n```",
		},
		{
			name: "joins marked strings with a blank line",
			params: { line: 4, symbol: "greet" },
			answers: () => ({
				"textDocument/hover": { result: { contents: ["greet", { language: "ts", value: "function greet()" }] } },
			}),
			text: "greet\n\nfunction greet()",
		},
		{
			name: "reports no hover without marking the result useless",
			params: { line: 4, symbol: "greet" },
			answers: () => ({ "textDocument/hover": { result: null } }),
			text: "No hover information",
		},
	],
	code_actions: [
		{
			name: "lists the actions with their kind and preference",
			params: { line: 1 },
			answers: ({ uri }) => ({ "textDocument/codeAction": { result: CODE_ACTIONS(uri) } }),
			text: `2 code action(s):\n${CODE_ACTION_LIST}`,
		},
		{
			name: "asks the server for the kind a listing query names",
			params: { line: 1, query: "quickfix" },
			answers: ({ uri }) => ({ "textDocument/codeAction": { result: CODE_ACTIONS(uri).slice(0, 1) } }),
			text: "1 code action(s):\n  0: [quickfix] Add return type (preferred)",
			after: (_fixture, server) => {
				const [request] = requestsFor(server, "textDocument/codeAction") as Array<{ params: unknown }>;
				expect(request?.params).toMatchObject({ context: { only: ["quickfix"] } });
			},
		},
		{
			name: "reports no actions",
			params: { line: 1 },
			answers: () => ({ "textDocument/codeAction": { result: [] } }),
			text: "No code actions available",
		},
		{
			name: "applies the action whose title the query names",
			params: { line: 1, apply: true, query: "RETURN type" },
			answers: ({ uri }) => ({ "textDocument/codeAction": { result: CODE_ACTIONS(uri) } }),
			text: 'Applied "Add return type":\n  Workspace edit:\n    Applied 1 edit(s) to src/app.ts',
			after: ({ file }) => {
				expect(fs.readFileSync(file, "utf-8")).toBe(RETURN_TYPED);
			},
		},
		{
			name: "runs the command action the query indexes",
			params: { line: 1, apply: true, query: "1" },
			answers: ({ uri }) => ({
				"textDocument/codeAction": { result: CODE_ACTIONS(uri) },
				"workspace/executeCommand": { result: null },
			}),
			text: 'Applied "Organize imports":\n  Executed command(s):\n    organize',
			after: ({ file }, server) => {
				const [request] = requestsFor(server, "workspace/executeCommand") as Array<{ params: unknown }>;
				expect(request?.params).toEqual({ command: "organize", arguments: [] });
				expect(fs.readFileSync(file, "utf-8")).toBe(SOURCE);
			},
		},
		{
			name: "resolves an action that arrives without its edit before applying it",
			params: { line: 1, apply: true, query: "0" },
			answers: ({ uri }) => ({
				"textDocument/codeAction": { result: [{ title: "Add return type", kind: "quickfix" }] },
				"codeAction/resolve": { result: CODE_ACTIONS(uri)[0] },
			}),
			text: 'Applied "Add return type":\n  Workspace edit:\n    Applied 1 edit(s) to src/app.ts',
			after: ({ file }) => {
				expect(fs.readFileSync(file, "utf-8")).toBe(RETURN_TYPED);
			},
		},
		{
			name: "lists the actions when the query matches none of them",
			params: { line: 1, apply: true, query: "rename everything" },
			answers: ({ uri }) => ({ "textDocument/codeAction": { result: CODE_ACTIONS(uri) } }),
			text: `No code action matches "rename everything". Available actions:\n${CODE_ACTION_LIST}`,
			after: ({ file }) => {
				expect(fs.readFileSync(file, "utf-8")).toBe(SOURCE);
			},
		},
		{
			name: "rejects a blank query when asked to apply",
			params: { line: 1, apply: true, query: "   " },
			answers: ({ uri }) => ({ "textDocument/codeAction": { result: CODE_ACTIONS(uri) } }),
			text: "Error: query parameter required when apply=true for code_actions",
		},
		{
			name: "reports an action that has nothing to apply",
			params: { line: 1, apply: true, query: "explain" },
			answers: () => ({
				"textDocument/codeAction": { result: [{ title: "Explain", kind: "quickfix" }] },
				"codeAction/resolve": { result: { title: "Explain", kind: "quickfix" } },
			}),
			text: 'Action "Explain" has no workspace edit or command to apply',
		},
	],
	symbols: [
		{
			name: "lists document symbols as a tree",
			answers: () => ({
				"textDocument/documentSymbol": {
					result: [
						{
							name: "greet",
							detail: "(name: string)",
							kind: 12,
							range: range(0, 0, 38),
							selectionRange: GREET_DECLARATION,
							children: [{ name: "name", kind: 13, range: range(0, 22, 26), selectionRange: range(0, 22, 26) }],
						},
					],
				},
			}),
			text: `Symbols in src/app.ts:\n${symbolKindToIcon(12)} greet (name: string) @ line 1\n  ${symbolKindToIcon(13)} name @ line 1`,
		},
		{
			name: "lists flat symbol information by line",
			answers: ({ uri }) => ({
				"textDocument/documentSymbol": {
					result: [{ name: "greet", kind: 12, location: { uri, range: GREET_DECLARATION } }],
				},
			}),
			text: `Symbols in src/app.ts:\n${symbolKindToIcon(12)} greet @ line 1`,
		},
		{
			name: "reports no symbols as a useless lookup",
			answers: () => ({ "textDocument/documentSymbol": { result: [] } }),
			text: "No symbols found",
			useless: true,
		},
	],
	rename: [
		{
			name: "applies the rename by default",
			params: { line: 1, symbol: "greet", new_name: "welcome" },
			answers: ({ uri }) => ({
				"textDocument/rename": {
					result: {
						changes: {
							[uri]: [
								{ range: GREET_DECLARATION, newText: "welcome" },
								{ range: GREET_CALL, newText: "welcome" },
							],
						},
					},
				},
			}),
			text: "Applied rename:\n  Applied 2 edit(s) to src/app.ts",
			after: ({ file }, server) => {
				const [request] = requestsFor(server, "textDocument/rename") as Array<{ params: unknown }>;
				expect(request?.params).toMatchObject({ position: { line: 0, character: 16 }, newName: "welcome" });
				expect(fs.readFileSync(file, "utf-8")).toBe(RENAMED);
			},
		},
		{
			name: "previews the rename without writing when apply is false",
			params: { line: 1, symbol: "greet", new_name: "welcome", apply: false },
			answers: ({ uri }) => ({
				"textDocument/rename": {
					result: {
						changes: {
							[uri]: [
								{ range: GREET_DECLARATION, newText: "welcome" },
								{ range: GREET_CALL, newText: "welcome" },
							],
						},
					},
				},
			}),
			text: "Rename preview:\n  src/app.ts: 2 edits",
			after: ({ file }) => {
				expect(fs.readFileSync(file, "utf-8")).toBe(SOURCE);
			},
		},
		{
			name: "reports a rename that returned no edits",
			params: { line: 1, symbol: "greet", new_name: "welcome" },
			answers: () => ({ "textDocument/rename": { result: null } }),
			text: "Rename returned no edits",
		},
	],
	reload: [
		{
			name: "reloads the file's server through workspace configuration when it has no reload request",
			text: `Reloaded ${SERVER_NAME}`,
			after: (_fixture, server) => {
				expect(requestsFor(server, "rust-analyzer/reloadWorkspace")).toHaveLength(1);
				expect(server.received.some(message => message.method === "workspace/didChangeConfiguration")).toBe(true);
			},
		},
	],
};

/**
 * A server that finishes loading its project as soon as it is initialized, answers `answers` by
 * method, acknowledges shutdown, and answers any other request method-not-found.
 */
function answering(answers: Readonly<Record<string, RpcAnswer>>): FakeLspHandler {
	return (message, server) => {
		if (message.method === "exit") {
			server.exit(0);
			return;
		}
		if (message.id === undefined || message.method === undefined) return;
		if (message.method === "initialize") {
			server.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
			server.send({ jsonrpc: "2.0", method: "$/progress", params: { token: "load", value: { kind: "begin" } } });
			server.send({ jsonrpc: "2.0", method: "$/progress", params: { token: "load", value: { kind: "end" } } });
			return;
		}
		if (message.method === "shutdown") {
			server.send({ jsonrpc: "2.0", id: message.id, result: null });
			return;
		}
		const answer = Object.hasOwn(answers, message.method)
			? answers[message.method]
			: { error: { code: -32601, message: `Method not found: ${message.method}` } };
		server.send({ jsonrpc: "2.0", id: message.id, ...answer });
	};
}

function writeFixture(): Fixture & { readonly temp: TempDir } {
	const temp = TempDir.createSync("@veyyon-lsp-file-actions-");
	const file = path.join(temp.path(), "src", "app.ts");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, SOURCE);
	return { temp, dir: temp.path(), file, uri: fileToUri(file) };
}

function useServer(servers: Array<[string, ServerConfig]>): void {
	vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
		servers: Object.fromEntries(servers),
		idleTimeoutMs: undefined,
		missingServers: [],
	});
	vi.spyOn(lspConfig, "getServersForFile").mockReturnValue(servers);
}

function textOf(result: AgentToolResult<LspToolDetails>): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

/** Every action the schema declares, so a new one arrives uncovered and fails the sweep. */
function declaredActions(): string[] {
	return [...new Set(lspSchema.value.get("action").expression.match(/[a-z_]+/g) ?? [])];
}

describe("a file-bound lsp action", () => {
	const fixtures: TempDir[] = [];

	afterEach(async () => {
		await lspClient.shutdownAll();
		vi.restoreAllMocks();
		for (const temp of fixtures.splice(0)) temp.removeSync();
	});

	function fixture(): Fixture {
		const created = writeFixture();
		fixtures.push(created.temp);
		useServer([[SERVER_NAME, SERVER]]);
		return created;
	}

	it("is every declared action the tool does not answer without a file", () => {
		const declared = declaredActions();
		expect(declared).toContain("hover");
		expect(declared.filter(action => !Object.hasOwn(CASES, action)).sort()).toEqual([...FILE_LESS_ACTIONS]);
		expect(Object.keys(CASES).filter(action => !declared.includes(action))).toEqual([]);
	});

	for (const [action, cases] of Object.entries(CASES) as Array<[FileBoundAction, readonly ActionCase[]]>) {
		for (const entry of cases) {
			it(`${action} ${entry.name}`, async () => {
				const target = fixture();
				const server = installFakeLsp(answering(entry.answers?.(target) ?? {}));
				const params: LspParams = { action, file: target.file, ...entry.params, timeout: 10 };
				const result = await new LspTool(makeToolSession({ cwd: target.dir })).execute(`lsp-${action}`, params);

				expect(textOf(result)).toBe(entry.text);
				expect(result.details).toEqual({ serverName: SERVER_NAME, action, success: true, request: params });
				expect(result.useless).toBe(entry.useless);
				entry.after?.(target, server);
			});
		}
	}

	it("requires a symbol where a project-aware server would guess the column, and only there", async () => {
		const required: string[] = [];
		for (const action of Object.keys(CASES) as FileBoundAction[]) {
			const target = fixture();
			installFakeLsp(answering({}));
			const tool = new LspTool(makeToolSession({ cwd: target.dir }));
			try {
				await tool.execute(`lsp-${action}`, { action, file: target.file, line: 1, timeout: 10 });
			} catch (err) {
				expect(err).toBeInstanceOf(ToolError);
				expect((err as ToolError).message).toBe(
					`symbol is required for project-aware ${action}; pass symbol=<name>, optionally symbol#N for repeated occurrences`,
				);
				required.push(action);
			}
			await lspClient.shutdownAll();
			vi.restoreAllMocks();
		}
		expect(required.sort()).toEqual(["definition", "incoming_calls", "outgoing_calls", "references", "rename"]);
	});

	it("rejects a rename with no new name before asking the server", async () => {
		const target = fixture();
		const server = installFakeLsp(answering({}));
		const result = await new LspTool(makeToolSession({ cwd: target.dir })).execute("lsp-rename", {
			action: "rename",
			file: target.file,
			line: 1,
			symbol: "greet",
			timeout: 10,
		});

		expect(textOf(result)).toBe("Error: new_name parameter required for rename");
		expect(result.details).toEqual({ action: "rename", serverName: SERVER_NAME, success: false });
		expect(requestsFor(server, "textDocument/rename")).toEqual([]);
	});

	it("reports a server error as a failed result", async () => {
		const target = fixture();
		installFakeLsp(answering({ "textDocument/hover": { error: { code: -32603, message: "hover crashed" } } }));
		const params: LspParams = { action: "hover", file: target.file, line: 4, symbol: "greet", timeout: 10 };
		const result = await new LspTool(makeToolSession({ cwd: target.dir })).execute("lsp-hover", params);

		expect(textOf(result)).toBe("LSP error: hover crashed");
		expect(result.details).toEqual({ serverName: SERVER_NAME, action: "hover", success: false, request: params });
	});

	it("reports a symbol missing from its line as a failed result", async () => {
		const target = fixture();
		installFakeLsp(answering({}));
		const params: LspParams = { action: "hover", file: target.file, line: 2, symbol: "greet", timeout: 10 };
		const result = await new LspTool(makeToolSession({ cwd: target.dir })).execute("lsp-hover", params);

		expect(textOf(result)).toBe('LSP error: Symbol "greet" not found on line 2');
		expect(result.details).toEqual({ serverName: SERVER_NAME, action: "hover", success: false, request: params });
	});

	it("stops with an abort when the caller cancels a request in flight", async () => {
		const target = fixture();
		const answer = answering({});
		// The hover request is received and never answered, so only the caller's cancel can end it.
		const server = installFakeLsp((message, srv) =>
			message.method === "textDocument/hover" ? undefined : answer(message, srv),
		);
		const caller = new AbortController();
		const pending = new LspTool(makeToolSession({ cwd: target.dir })).execute(
			"lsp-hover",
			{ action: "hover", file: target.file, line: 4, symbol: "greet", timeout: 10 },
			caller.signal,
		);
		await server.waitFor(message => message.method === "textDocument/hover", 5_000);
		caller.abort();

		await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
	});

	it("names no server when none handles the file", async () => {
		const target = fixture();
		useServer([]);
		const result = await new LspTool(makeToolSession({ cwd: target.dir })).execute("lsp-hover", {
			action: "hover",
			file: target.file,
			line: 4,
			timeout: 10,
		});

		expect(textOf(result)).toBe("No language server found for this action");
		expect(result.details).toEqual({ action: "hover", success: false });
	});

	it("asks for a file when a file-bound action names none", async () => {
		const target = fixture();
		const result = await new LspTool(makeToolSession({ cwd: target.dir })).execute("lsp-hover", {
			action: "hover",
			line: 4,
			timeout: 10,
		});

		expect(textOf(result)).toBe("Error: file parameter required. Use `*` for workspace scope where supported.");
		expect(result.details).toEqual({ action: "hover", success: false });
	});
});
