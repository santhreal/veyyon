/**
 * WHY THIS SUITE EXISTS.
 *
 * THE DEFECT IT CLOSES. `createAgentSession` built a telemetry config for every session, so that span text
 * passed through the session's secret obfuscator, including a session whose caller passed no config. Every
 * turn of every session then resolved a tracer, evaluated `@opentelemetry/api` (44 modules on the first
 * turn), ran a run collector and built `invoke_agent`, `chat` and `execute_tool` spans, and a host that
 * registered an OTEL tracer provider for its own spans received the agent's spans with no telemetry config.
 *
 * THE CLASS. A session that traces a turn its caller did not opt into, and a session that traces with a
 * secret or caller-sanitized text left in a span. `sessionTelemetry` in `session/startup-request-hooks.ts`,
 * which `createAgentSession` calls, is the one place a session's telemetry config is built: a spawned
 * agent, an advisor, and the compaction and setup oneshots derive theirs from it,
 * and derive none from an absent one (`task/executor-agent-reminders.test.ts` and `advisor/advise-tool.test.ts`
 * pin that for the spawned agent and the advisor). Each case drives a real turn through `createAgentSession`
 * against one global tracer provider, so the exporter that records nothing for a session with no config is the
 * exporter that records the spans of a session with one.
 *
 * WHAT IT DOES NOT CATCH. A config a host installs with `agent.setTelemetry()` after creation reaches the loop
 * without the secret obfuscator. The provider transport is a scripted stream, so a span a provider client
 * starts on its own is outside the suite.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trace } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { AgentTelemetryConfig } from "@veyyon/agent-core";
import type { AssistantMessage, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

const PROVIDER = "anthropic";
const MODEL_ID = "claude-sonnet-4-5";
/** A credential the project's secrets file declares, so the session's obfuscator replaces it. */
const SECRET = "trace-secret-token-5f1c9e27";
/** Text only the caller's own sanitizer removes. */
const CALLER_PRIVATE = "caller-private-marker-41d8";
const CALLER_REPLACEMENT = "[caller-redacted]";
/**
 * The file the turn reads. A tool result holds what the file holds, unobfuscated, and the execute_tool span
 * records that result when content capture is on: the span text the secret obfuscator exists for.
 */
const NOTES = "notes.txt";
const NOTES_TEXT = `token ${SECRET}\nowner ${CALLER_PRIVATE}\n`;

const sessions: AgentSession[] = [];
const tempDirs: string[] = [];
let sharedDir: string;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

function bundledModel(): Model {
	const model = getBundledModel(PROVIDER, MODEL_ID);
	if (!model) throw new Error(`missing bundled model ${PROVIDER}/${MODEL_ID}`);
	return model as Model;
}

/** A provider reply carrying `content`, which ends the turn unless it calls a tool. */
function reply(model: Model, content: AssistantMessage["content"]): AssistantMessageEventStream {
	const reason = content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
	const message: AssistantMessage = {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: reason,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => stream.push({ type: "done", reason, message }));
	return stream;
}

/** Run one turn that reads the notes file, in a session with secret obfuscation on and the given telemetry config. */
async function runTurn(telemetry: AgentTelemetryConfig | undefined): Promise<ReadableSpan[]> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `traces-only-when-given-${Snowflake.next()}-`));
	tempDirs.push(tempDir);
	const cwd = path.join(tempDir, "project");
	const globalConfigRoot = path.join(tempDir, "global");
	fs.mkdirSync(path.join(cwd, ".veyyon"), { recursive: true });
	fs.mkdirSync(globalConfigRoot, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(cwd, ".veyyon", "secrets.yml"), `- type: plain\n  content: ${SECRET}\n`);
	fs.writeFileSync(path.join(cwd, NOTES), NOTES_TEXT);
	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(tempDir, "agent"),
		globalConfigRoot,
		sessionManager: SessionManager.create(cwd, path.join(tempDir, "sessions")),
		settings: Settings.isolated({ "secrets.enabled": true }),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		modelRegistry,
		model: bundledModel(),
		telemetry,
	});
	sessions.push(session);
	expect(session.obfuscator?.hasSecrets()).toBe(true);
	// The provider transport: the first request calls `read` on the notes, the second ends the turn.
	let requests = 0;
	session.agent.streamFn = model =>
		requests++ === 0
			? reply(model, [{ type: "toolCall", id: "call-read-notes", name: "read", arguments: { path: NOTES } }])
			: reply(model, [{ type: "text", text: "done" }]);
	await session.prompt(`read ${NOTES} for ${CALLER_PRIVATE}`);
	await session.waitForIdle();
	return exporter.getFinishedSpans();
}

/** Every operation the recorded spans name, sorted and without repeats. */
function operations(spans: readonly ReadableSpan[]): string[] {
	return [...new Set(spans.map(span => String(span.attributes["gen_ai.operation.name"])))].sort();
}

/** Everything a span exporter would send: names, attributes, events and status. */
function exported(spans: readonly ReadableSpan[]): string {
	return JSON.stringify(
		spans.map(span => ({ name: span.name, attributes: span.attributes, events: span.events, status: span.status })),
	);
}

beforeAll(async () => {
	sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "traces-only-when-given-"));
	authStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
	authStorage.setRuntimeApiKey(PROVIDER, "anthropic-test-key");
	modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir, "models.yml"));
});

afterAll(() => {
	authStorage.close();
	removeSyncWithRetries(sharedDir);
});

beforeEach(() => {
	exporter = new InMemorySpanExporter();
	provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
	expect(trace.setGlobalTracerProvider(provider)).toBe(true);
});

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	trace.disable();
	await provider.shutdown();
	for (const tempDir of tempDirs.splice(0)) removeSyncWithRetries(tempDir);
});

describe("a session traces its turns only when given telemetry", () => {
	it("records no span for a session created without a telemetry config", async () => {
		const spans = await runTurn(undefined);

		expect(spans.map(span => span.name)).toEqual([]);
	});

	it("records the turn of a session given an empty config", async () => {
		const spans = await runTurn({});

		expect(operations(spans)).toEqual(["chat", "execute_tool", "invoke_agent"]);
	});

	it("passes span text through the caller's sanitizer and then the session's secret obfuscator", async () => {
		const spans = await runTurn({
			captureMessageContent: "full",
			textSanitizer: text => text.replaceAll(CALLER_PRIVATE, CALLER_REPLACEMENT),
		});
		const payload = exported(spans);

		expect(operations(spans)).toEqual(["chat", "execute_tool", "invoke_agent"]);
		expect(payload).toContain(CALLER_REPLACEMENT);
		expect(payload).not.toContain(CALLER_PRIVATE);
		expect(payload).not.toContain(SECRET);
	});
});
