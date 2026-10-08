/**
 * Creates one agent session in a fresh process, calls every built-in and hidden tool factory, then
 * builds and runs the isolation commit-message callback, and prints as JSON the commit prompt modules
 * evaluated at each of those points, the task tool's presence in the session, what the `generic`
 * style's factory returned, and the message the `ai` style's callback produced.
 * argv[2] is the scratch directory.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Api, AssistantMessage, Model, ModelSpec } from "@veyyon/ai";
import { registerCustomApi } from "@veyyon/ai/api-registry";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { buildModel } from "@veyyon/catalog/build";
import { getBundledModel } from "@veyyon/catalog/models";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { postmortem } from "@veyyon/utils";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { createAgentSession } from "../../src/sdk";
import { makeIsolationCommitMessage } from "../../src/task/isolation-runner";
import type { ToolSession } from "../../src/tools";
import { visitEveryFirstPartyTool } from "../helpers/every-first-party-tool";

const COMMIT_PROMPTS = `${path.sep}src${path.sep}prompts${path.sep}commit${path.sep}`;
const PROBE_API = "commit-pipeline-probe";
const PROBE_MESSAGE = "fix the probe";
/** Long enough for a dynamic import started at a probed point to finish evaluating. */
const SETTLE_MS = 250;

/**
 * The file names of the commit prompt modules the process has evaluated, read after a timer turn so a
 * dynamic import started at the probed point counts at that point.
 */
async function commitPromptModules(): Promise<string[]> {
	await sleep(SETTLE_MS);
	return Object.keys(require.cache)
		.filter(file => path.normalize(file).includes(COMMIT_PROMPTS))
		.map(file => path.basename(file))
		.sort();
}

function probeMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: PROBE_MESSAGE }],
		api: PROBE_API,
		provider: "probe",
		model: "probe-smol",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}

try {
	const scratch = process.argv[2];
	if (!scratch) throw new Error("usage: commit-pipeline-evaluation.ts <scratch-dir>");
	const cwd = path.join(scratch, "project");
	fs.mkdirSync(cwd, { recursive: true });
	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(scratch, "agent"),
		sessionManager: SessionManager.inMemory(cwd),
		settings: Settings.isolated(),
		model: getBundledModel<"anthropic-messages">("anthropic", "claude-sonnet-4-5"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	const taskActive = session.getActiveToolNames().includes("task");
	const atCreate = await commitPromptModules();
	await visitEveryFirstPartyTool(path.join(scratch, "sweep"), () => {});
	const atEveryTool = await commitPromptModules();

	registerCustomApi(PROBE_API, () => {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: probeMessage() }));
		return stream;
	});
	const model = buildModel({
		id: "probe-smol",
		name: "Probe Smol",
		api: PROBE_API,
		provider: "probe",
		baseUrl: "http://127.0.0.1:9",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
	const registry = {
		getAvailable: () => [model],
		getApiKey: async () => "probe-key",
		resolver: () => async () => "probe-key",
	} as unknown as ModelRegistry;
	const toolSession = (style: "generic" | "ai"): ToolSession =>
		({
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "agent.isolation.commits": style }),
			modelRegistry: registry,
		}) as ToolSession;

	const genericCallback = makeIsolationCommitMessage(toolSession("generic"))();
	const aiCallback = makeIsolationCommitMessage(toolSession("ai"))();
	const atCallback = await commitPromptModules();
	const message = aiCallback ? await aiCallback("diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n") : null;
	const afterCommit = await commitPromptModules();

	process.stdout.write(
		`${JSON.stringify({
			taskActive,
			atCreate,
			atEveryTool,
			atCallback,
			afterCommit,
			generic: typeof genericCallback,
			ai: typeof aiCallback,
			message,
		})}\n`,
	);
	await session.dispose();
} finally {
	await postmortem.cleanup();
}
