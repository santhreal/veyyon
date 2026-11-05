/**
 * WHY: `--mode json` printed a line for some events and silently dropped others. Every line goes
 * through the provider redaction walk, which rejects enumerable symbol keys and getters, and the
 * walk ran over the live event objects. A streamed assistant message holds symbol-keyed streaming
 * state on its content blocks, and a recorded read result holds a lazily built card text behind a
 * getter, so the walk threw for every tool-call message, `turn_end`, `agent_end`, and the read's
 * `tool_execution_end`, and the subscriber dropped the line with no trace.
 *
 * THE CLASS THIS CLOSES. Any in-memory shape the session emits that `JSON.stringify` writes but the
 * walk rejects. The invariant is checked at the one choke point: a real session streaming from a real
 * provider adapter, running the real read tool, prints exactly one line per event it emits, in order.
 * A new event type, a new symbol on a block, or a new getter on a result is covered without a list.
 *
 * WHAT IT DOES NOT CATCH. A shape that `JSON.stringify` itself cannot write (a `BigInt`, a cycle):
 * that line is still dropped, with a stderr report, which this suite does not exercise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import type { Model, ModelSpec } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { runPrintMode } from "@veyyon/coding-agent/modes/print-mode";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir, withTimeout } from "@veyyon/utils";

const PROVIDER = "json-stream-host";
const BASE_URL = "https://json-stream-host.invalid/v1";
const RUN_BOUND_MS = 10_000;
/**
 * A persisting session settles a recorded read into a lazily built card (a getter); `--no-session`
 * holds the result as the tool returned it. Both are print-mode configurations.
 */
const SESSION_KINDS: readonly { label: string; manager: (cwd: string, sessionDir: string) => SessionManager }[] = [
	{ label: "a persisted session", manager: (cwd, sessionDir) => SessionManager.create(cwd, sessionDir) },
	{ label: "an in-memory session (--no-session)", manager: cwd => SessionManager.inMemory(cwd) },
];
/** A source file long enough that the session stores the read's card as a rebuild of its text. */
const SOURCE = Array.from({ length: 40 }, (_, i) => `export const value${i} = ${i} * 2;`).join("\n");

function hostModel(): Model<"openai-completions"> {
	return buildModel({
		id: "json-stream-host-model",
		name: "JSON stream host model",
		api: "openai-completions",
		provider: PROVIDER,
		baseUrl: BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	} as ModelSpec<"openai-completions">) as Model<"openai-completions">;
}

function sse(chunks: readonly unknown[]): Response {
	const body = [...chunks.map(chunk => JSON.stringify(chunk)), "[DONE]"].map(data => `data: ${data}`).join("\n\n");
	return new Response(`${body}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunk(delta: unknown, finish: string | null): unknown {
	return {
		id: "chatcmpl-json",
		object: "chat.completion.chunk",
		created: 0,
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
}

/** The first request is answered with a read of `src/sample.ts`, its arguments streamed in two parts. */
function hostReply(request: number): Response {
	if (request > 1) return sse([chunk({ content: "Read it." }, null), chunk({}, "stop")]);
	const call = (args: string, head: boolean) => ({
		index: 0,
		...(head ? { id: "call_read", type: "function" } : {}),
		function: { ...(head ? { name: "read" } : {}), arguments: args },
	});
	return sse([
		chunk({ tool_calls: [call('{"path":"src/', true)] }, null),
		chunk({ tool_calls: [call('sample.ts"}', false)] }, null),
		chunk({}, "tool_calls"),
	]);
}

describe("a --mode json print run", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	let stdout: string;
	let stderr: string;

	beforeEach(() => {
		stdout = "";
		stderr = "";
		let requests = 0;
		const realFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (!url.startsWith(BASE_URL)) return realFetch(input, init);
			requests++;
			return hostReply(requests);
		}) as typeof fetch);
		vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
			stderr += String(chunk);
			return true;
		});
		vi.spyOn(process.stdout, "write").mockImplementation((chunk, callback) => {
			stdout += String(chunk);
			if (typeof callback === "function") callback();
			return true;
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		tempDir?.removeSync();
	});

	for (const { label, manager } of SESSION_KINDS) {
		it(
			`over ${label}: prints one line per event the session emits, in order, including tool-call and read events`,
			async () => {
				tempDir = TempDir.createSync("@veyyon-json-print-");
				const cwd = tempDir.join("project");
				const agentDir = tempDir.join("agent");
				fs.mkdirSync(`${cwd}/src`, { recursive: true });
				fs.mkdirSync(agentDir, { recursive: true });
				fs.writeFileSync(`${cwd}/src/sample.ts`, `${SOURCE}\n`);
				authStorage = await AuthStorage.create(tempDir.join("auth.db"));
				authStorage.setRuntimeApiKey(PROVIDER, "test-key");
				({ session } = await createAgentSession({
					cwd,
					agentDir,
					authStorage,
					modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
					sessionManager: manager(cwd, tempDir.join("sessions")),
					settings: Settings.isolated({ "compaction.enabled": false, "tools.approvalMode": "yolo" }),
					model: hostModel(),
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					skipPythonPreflight: true,
					rules: [],
					workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
				}));
				const emitted: string[] = [];
				session.subscribe(event => {
					emitted.push(event.type);
				});

				await withTimeout(
					runPrintMode(session, { mode: "json", initialMessage: "Read the sample" }),
					RUN_BOUND_MS,
					"the json print run did not return",
				);

				expect(stderr).not.toContain("Dropped a --mode json line");
				const lines = stdout
					.split("\n")
					.filter(line => line.length > 0)
					.map(line => JSON.parse(line) as { type: string; [key: string]: unknown });
				const printed = lines.filter(line => line.type !== "session").map(line => line.type);
				expect(printed).toEqual(emitted);

				// The run reached every shape the defect dropped, so the equality above is not vacuous.
				const toolCallEnd = lines.find(
					line => line.type === "message_end" && JSON.stringify(line.message).includes('"toolCall"'),
				);
				expect(toolCallEnd).toBeDefined();
				const readEnd = lines.find(line => line.type === "tool_execution_end" && line.toolName === "read");
				expect(JSON.stringify(readEnd)).toContain("export const value39 = 39 * 2;");
				expect(printed.filter(type => type === "turn_end")).toHaveLength(2);
				expect(printed.at(-1)).toBe("agent_end");
			},
			RUN_BOUND_MS * 3,
		);
	}
});
