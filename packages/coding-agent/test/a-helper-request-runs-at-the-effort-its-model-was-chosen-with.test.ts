/**
 * WHY: picking a helper's model in the Roster also picks its effort, stored as `model:level`, and a
 * helper with no model runs the session's model at the session's effort. The title, auto-thinking,
 * unexpected-stop, speech and memory helpers ignored both: four sent `disableReasoning: true` and
 * memory sent a fixed low or medium effort, whatever was picked. A helper set to `model:high` ran with
 * reasoning off.
 *
 * The class this closes: a one-shot helper request whose reasoning is fixed in code rather than read
 * from the helper's selection and the session. Every one-shot helper is driven through its production
 * entry with the same cases, and the options its provider request carried are read back. `HELPER_IDS`
 * is swept, so a new helper turns this suite red until it is driven here or recorded with the suite
 * that drives it.
 *
 * Not covered: how long a request takes at a high effort, and the vision, completion and guided-goal
 * requests, whose own suites drive them.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@veyyon/ai";
import * as aiStream from "@veyyon/ai/stream";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import { emptyUsage } from "@veyyon/catalog/models";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { startMemoryStartupTask } from "@veyyon/coding-agent/memory/local";
import { mnemopiBackend } from "@veyyon/coding-agent/memory/mnemopi/backend";
import { getMnemopiSessionState, setMnemopiSessionState } from "@veyyon/coding-agent/memory/mnemopi/state";
import { classifyUnexpectedStop } from "@veyyon/coding-agent/session/unexpected-stop-classifier";
import { SpeechEnhancer } from "@veyyon/coding-agent/speech/tts/speech-enhancer";
import { HELPER_IDS, type HelperId } from "@veyyon/coding-agent/task/helper-settings";
import { classifyDifficulty } from "@veyyon/coding-agent/thinking/auto-classifier";
import {
	ONLINE_AUTO_THINKING_MODEL_KEY,
	ONLINE_MEMORY_MODEL_KEY,
	ONLINE_TINY_TITLE_MODEL_KEY,
} from "@veyyon/coding-agent/tiny/models";
import { generateCommitMessage } from "@veyyon/coding-agent/utils/commit-message-generator";
import { generateSessionTitle } from "@veyyon/coding-agent/utils/title-generator";
import { Snowflake, TempDir } from "@veyyon/utils";

/** A reasoning model offering only low and high, so fitting a level to it is observable. */
const model = buildModel({
	id: "helper-reasoner",
	name: "Helper Reasoner",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 32_000,
});
const SELECTOR = `${model.provider}/${model.id}`;

const registry = {
	find: () => model,
	getAll: () => [model],
	getAvailable: () => [model],
	getApiKey: async () => "test-key",
	getApiKeyForProvider: async () => "test-key",
	authStorage: { rotateSessionCredential: async () => false },
	resolver: () => async () => "test-key",
};

/** What one provider request carried. `capped` is whether it set an output cap. */
interface Sent {
	reasoning: unknown;
	disableReasoning: unknown;
	capped: boolean;
}

interface Case {
	name: string;
	helper: { model?: string; thinkingLevel?: string };
	sessionLevel: ThinkingLevel;
	expected: Sent;
}

const PICKED_HIGH: Sent = { reasoning: Effort.High, disableReasoning: false, capped: false };
const OFF: Sent = { reasoning: undefined, disableReasoning: true, capped: true };
const NONE: Sent = { reasoning: undefined, disableReasoning: false, capped: true };

const CASES: Case[] = [
	{
		name: "the effort picked with the helper's model",
		helper: { model: `${SELECTOR}:high` },
		sessionLevel: ThinkingLevel.Low,
		expected: PICKED_HIGH,
	},
	{
		name: "the helper's Effort row, fitted to the efforts the model offers",
		helper: { model: SELECTOR, thinkingLevel: "medium" },
		sessionLevel: ThinkingLevel.High,
		expected: { reasoning: Effort.Low, disableReasoning: false, capped: false },
	},
	{
		name: "the session's effort when the helper names none, fitted to the model",
		helper: {},
		sessionLevel: ThinkingLevel.XHigh,
		expected: PICKED_HIGH,
	},
	{
		name: "off picked with the model disables reasoning and keeps the answer cap",
		helper: { model: `${SELECTOR}:off` },
		sessionLevel: ThinkingLevel.High,
		expected: OFF,
	},
];

/**
 * What an unset helper falls back to when the session's effort is not the rule. Auto-thinking runs
 * while the session's effort is `auto`, the level being chosen, so it classifies with reasoning off.
 * `veyyon commit` runs outside any session, so no effort is sent.
 */
const UNSET_FALLBACK: Partial<Record<string, Sent>> = { autoThinking: OFF, commit: NONE };

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...emptyUsage(), input: 1, output: 1, totalTokens: 2 },
		stopReason: "stop",
		timestamp: Date.now(),
		content: [{ type: "text", text }],
	};
}

/** Replace the provider call, answering with `answer(context)` and recording each request. */
function captureRequests(answer: (context: Context) => string): Sent[] {
	const sent: Sent[] = [];
	vi.spyOn(aiStream, "completeSimple").mockImplementation((async (
		_model: Model,
		context: Context,
		options?: SimpleStreamOptions,
	) => {
		if (typeof options?.apiKey === "function") await options.apiKey({ lastChance: false, error: undefined });
		sent.push({
			reasoning: options?.reasoning,
			disableReasoning: options?.disableReasoning,
			capped: typeof options?.maxTokens === "number",
		});
		return reply(answer(context));
	}) as typeof aiStream.completeSimple);
	return sent;
}

function settingsFor(id: HelperId, testCase: Case, extra: Record<string, unknown> = {}): Settings {
	const settings = Settings.isolated(extra);
	settings.set("agent.helpers", { [id]: testCase.helper });
	return settings;
}

async function withTempDir<T>(run: (dir: TempDir) => Promise<T>): Promise<T> {
	const dir = await TempDir.create(`@helper-effort-${Snowflake.next()}`);
	try {
		return await run(dir);
	} finally {
		await dir.remove();
	}
}

/** Runs the local memory backend's two passes over one rollout. */
async function runLocalMemory(testCase: Case): Promise<Sent[]> {
	const sent = captureRequests(context =>
		context.systemPrompt?.some(text => text.includes("memory-stage-one"))
			? JSON.stringify({ rollout_summary: "Summary", rollout_slug: "slug", raw_memory: "Memory" })
			: JSON.stringify({ memory_md: "# Memory", memory_summary: "Consolidated", skills: [] }),
	);
	// The memory database path follows XDG; keep it inside the temp agent dir.
	const saved = { data: process.env.XDG_DATA_HOME, state: process.env.XDG_STATE_HOME };
	process.env.XDG_DATA_HOME = "/nonexistent-xdg-data";
	process.env.XDG_STATE_HOME = "/nonexistent-xdg-state";
	try {
		return await withTempDir(async dir => {
			const agentDir = dir.path();
			const sessionDir = path.join(agentDir, "sessions");
			await fs.mkdir(sessionDir, { recursive: true });
			const sessionFile = path.join(sessionDir, "current-session.jsonl");
			await fs.writeFile(
				sessionFile,
				`${JSON.stringify({ type: "session", id: "current-thread", cwd: agentDir })}\n`,
			);
			const rollout = [
				{ type: "session", id: "past-thread", cwd: agentDir },
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "fix the parser" }] } },
			];
			await fs.writeFile(
				path.join(sessionDir, "past-thread.jsonl"),
				`${rollout.map(row => JSON.stringify(row)).join("\n")}\n`,
			);
			const settings = settingsFor("memory", testCase, {
				"memory.backend": "local",
				"memories.minRolloutIdleHours": 0,
				"memories.stage1Concurrency": 1,
				"memories.phase2HeartbeatSeconds": 1,
			});
			const settled = Promise.withResolvers<void>();
			const session = {
				sessionId: "memory-effort-session",
				sessionManager: {
					getSessionFile: () => sessionFile,
					getSessionDir: () => sessionDir,
					getSessionId: () => "current-thread",
					getCwd: () => agentDir,
				},
				settings,
				model,
				thinkingLevel: testCase.sessionLevel,
				modelRegistry: registry,
				obfuscateProviderText: (text: string) => text,
				refreshBaseSystemPrompt: async () => settled.resolve(),
			};
			startMemoryStartupTask({
				session: session as never,
				settings,
				modelRegistry: registry as never,
				agentDir,
				taskDepth: 0,
			});
			await settled.promise;
			// Stage one and consolidation both ran, so neither pass escaped the assertion.
			expect(sent).toHaveLength(2);
			return sent;
		});
	} finally {
		process.env.XDG_DATA_HOME = saved.data;
		process.env.XDG_STATE_HOME = saved.state;
	}
}

/** Starts the Mnemopi backend online and sends one completion through the LLM it was handed. */
async function runMnemopiMemory(testCase: Case): Promise<Sent[]> {
	const sent = captureRequests(() => "a memory");
	return withTempDir(async dir => {
		const settings = settingsFor("memory", testCase, {
			"mnemopi.dbPath": dir.join("mnemopi.db"),
			"mnemopi.llmMode": "online",
			"providers.memoryModel": ONLINE_MEMORY_MODEL_KEY,
			"mnemopi.noEmbeddings": true,
			"mnemopi.autoRecall": false,
			"mnemopi.autoRetain": false,
		});
		const session = {
			sessionId: "mnemopi-effort-session",
			settings,
			model,
			thinkingLevel: testCase.sessionLevel,
			obfuscateProviderText: (text: string) => text,
			sessionManager: { getCwd: () => dir.path(), getEntries: () => [] },
			subscribe: () => () => {},
			emitNotice: () => {},
		} as never;
		await mnemopiBackend.start({
			session,
			settings,
			modelRegistry: registry as never,
			agentDir: dir.path(),
			taskDepth: 0,
		});
		const state = getMnemopiSessionState(session);
		if (!state) throw new Error("Mnemopi state did not start");
		try {
			const llm = state.config.providerOptions.llm;
			if (!llm || !("complete" in llm) || !llm.complete) throw new Error("Mnemopi received no online LLM");
			await llm.complete("remember this", { maxTokens: 256, onPayload: payload => payload });
		} finally {
			await state.dispose({ consolidate: false });
			setMnemopiSessionState(session, undefined);
		}
		return sent;
	});
}

/** Every one-shot helper surface, each returning the requests it sent for one case. */
const DRIVERS: Record<string, { id: HelperId; run: (testCase: Case) => Promise<Sent[]> }> = {
	title: {
		id: "title",
		run: async testCase => {
			const sent = captureRequests(() => "<title>Parser failure</title>");
			const settings = settingsFor("title", testCase, { "providers.tinyModel": ONLINE_TINY_TITLE_MODEL_KEY });
			await generateSessionTitle(
				"Investigate why the parser rejects nested generics",
				registry as never,
				settings,
				"title-session",
				model,
				undefined,
				undefined,
				undefined,
				undefined,
				testCase.sessionLevel,
			);
			return sent;
		},
	},
	autoThinking: {
		id: "autoThinking",
		run: async testCase => {
			const sent = captureRequests(() => "medium");
			const settings = settingsFor("autoThinking", testCase, {
				"providers.autoThinkingModel": ONLINE_AUTO_THINKING_MODEL_KEY,
			});
			await classifyDifficulty("Refactor the parser into a streaming tokenizer", {
				settings,
				registry: registry as never,
				model,
			});
			return sent;
		},
	},
	unexpectedStop: {
		id: "unexpectedStop",
		run: async testCase => {
			const sent = captureRequests(() => "yes");
			const settings = settingsFor("unexpectedStop", testCase, {
				"providers.unexpectedStopModel": ONLINE_MEMORY_MODEL_KEY,
			});
			await classifyUnexpectedStop("I will now run the tests.", {
				settings,
				registry: registry as never,
				model,
				thinkingLevel: testCase.sessionLevel,
				sessionId: "stop-session",
				obfuscateProviderText: text => text,
			});
			return sent;
		},
	},
	speech: {
		id: "speech",
		run: async testCase => {
			const sent = captureRequests(() => "The parser now accepts nested generics.");
			await new SpeechEnhancer({
				settings: settingsFor("speech", testCase),
				registry: registry as never,
				sessionId: "speech-session",
				currentModel: () => model,
				thinkingLevel: () => testCase.sessionLevel,
			}).rewrite("The parser now accepts `nested<generics>`.");
			return sent;
		},
	},
	commit: {
		id: "commit",
		run: async testCase => {
			const sent = captureRequests(() => "fix(parser): accept nested generics");
			await generateCommitMessage(
				"diff --git a/parser.ts b/parser.ts\n+accept nested generics\n",
				registry as never,
				settingsFor("commit", testCase),
				() => text => text,
			);
			return sent;
		},
	},
	"memory (local)": { id: "memory", run: runLocalMemory },
	"memory (mnemopi)": { id: "memory", run: runMnemopiMemory },
};

/** Helpers whose request this suite does not drive, each with the suite or reason that covers it. */
const COVERED_ELSEWHERE: Partial<Record<HelperId, string>> = {
	advisor: "runs as an agent with its own session, not a one-shot request",
	plan: "switches the session's model; the guided goal request is driven in test/goals/guided-goal.test.ts",
	vision: "test/a-vision-request-runs-at-the-vision-helpers-effort.test.ts",
	completion: "test/eval/a-completion-runs-at-the-effort-its-model-was-chosen-with.test.ts",
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a helper request runs at the effort its model was chosen with", () => {
	it("drives every helper or records the suite that does", () => {
		const driven = new Set(Object.values(DRIVERS).map(driver => driver.id));
		const undriven = HELPER_IDS.filter(id => !driven.has(id));
		expect(undriven).toEqual(Object.keys(COVERED_ELSEWHERE) as HelperId[]);
	});

	for (const [surface, driver] of Object.entries(DRIVERS)) {
		describe(surface, () => {
			for (const testCase of CASES) {
				it(testCase.name, async () => {
					const expected =
						testCase.helper.model === undefined
							? (UNSET_FALLBACK[driver.id] ?? testCase.expected)
							: testCase.expected;
					const sent = await driver.run(testCase);
					expect(sent.length).toBeGreaterThan(0);
					for (const request of sent) expect(request).toEqual(expected);
				}, 30_000);
			}
		});
	}
});
