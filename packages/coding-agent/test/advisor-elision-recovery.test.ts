/**
 * WHY: the advisor leg of compaction tail elision. `#maintainAdvisorContext`
 * runs the real `prepareCompaction` on the advisor's in-memory history, and
 * `prepareCompaction` elides over-budget tool results in the kept tail as a
 * side effect — swapping them for POINTERLESS markers whose only copy of the
 * original bytes rides on the preparation. The primary session paths close
 * that out (`#persistCompactionTailElisions` offloads the bytes and points
 * the marker at the artifact; failure paths roll the elision back). The
 * advisor path used to feed `preparation.recentMessages` straight into
 * advisor memory, so a successful advisor compaction stranded the bytes
 * behind a dead marker: advisor memory is in-memory, nothing else kept the
 * pre-elision copy, and every later advisor turn reasoned over marker text
 * instead of the content.
 *
 * These tests drive the REAL maintenance path: a real AgentSession with the
 * advisor enabled, a primary turn whose turn_end feeds the advisor runtime,
 * and `advisor.syncBacklog: "1"` so the primary turn awaits the advisor
 * drain. The compaction summarizer is scripted through a registered runtime
 * provider (custom api + streamSimple), the advisor's own turns through
 * `advisorStreamFn`, the primary through a MockModel — no live calls.
 *
 * Mutation gates:
 *  - Feed `preparation.recentMessages` unchanged (the pre-fix behavior) →
 *    "pointered marker" fails: the marker carries no artifact:// and no
 *    recovery artifact exists.
 *  - Drop the restore-on-offload-failure branch → "offload failure" fails:
 *    a pointerless marker sits in advisor memory.
 *  - Let a failed compaction feed partial results into advisor memory →
 *    "summarizer failure" fails: marker text or stranded bytes present.
 *  - Mutate advisor history during a maintenance pass that dies mid-flight
 *    → "mid-pass failure" fails: the pre-pass prefix is no longer
 *    byte-identical.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentMessage, type StreamFn } from "@veyyon/agent-core";
import type { AssistantMessage, Model, Usage } from "@veyyon/ai";
import { clearCustomApis } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import type { Api } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { ModelRegistry, type ProviderConfigInput } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

const HUGE = "x".repeat(40_000);
const ELISION_PROVIDER = "advisor-elision-test";
const ELISION_API = "advisor-elision-test-api";
const ELISION_MODEL_ID = "advisor-model";
const ELISION_SOURCE = "ext://advisor-elision-test";

const usage = (input: number, output: number): Usage => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function assistantMessage(model: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: usage(100, 50),
		timestamp: Date.now(),
	};
}

function completedStream(message: AssistantMessage): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

/** The text of the advisor-history tool result that is an elision marker, if any. */
function advisorMarkerText(messages: AgentMessage[]): string | undefined {
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const content = message.content;
		const text =
			typeof content === "string" ? content : content.map(b => (b.type === "text" ? b.text : "")).join("\n");
		if (text.includes("output elided by compaction")) return text;
	}
	return undefined;
}

interface AdvisorElisionHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	modelRegistry: ModelRegistry;
	advisor: Agent;
	/** Compaction summarizer invocations (the registered provider's streamSimple). */
	compactionStreamCalls: () => number;
	/** User-message text of every advisor turn, in order. */
	advisorBatches: string[];
}

describe("advisor compaction closes out tail elisions", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-advisor-elision-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			authStorage?.close();
			clearCustomApis();
			await tempDir?.remove();
		}
	});

	async function createHarness(summarizer: "ok" | "fail"): Promise<AdvisorElisionHarness> {
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		// The primary turn preflights auth through the registry for the main
		// (mock) model; the scripted streamFn never uses the key.
		authStorage.setRuntimeApiKey("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		let compactionStreamCalls = 0;
		const streamSimple: NonNullable<ProviderConfigInput["streamSimple"]> = requestModel => {
			compactionStreamCalls++;
			if (summarizer === "fail") throw new Error("summarizer down");
			return completedStream(assistantMessage(requestModel, "SUMMARY-TEXT: advisor history condensed"));
		};
		modelRegistry.registerProvider(
			ELISION_PROVIDER,
			{
				baseUrl: "https://advisor-elision.test/v1",
				apiKey: "ELISION-TEST-KEY",
				api: ELISION_API,
				streamSimple,
				models: [
					{
						id: ELISION_MODEL_ID,
						name: "Advisor Elision Test Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 10_000,
						maxTokens: 4096,
					},
				],
			},
			ELISION_SOURCE,
		);

		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const mainMock = createMockModel({ responses: [{ content: ["MAIN-ANSWER"], stopReason: "stop" }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mainMock, systemPrompt: ["Test"], tools: [] },
			streamFn: mainMock.stream,
		});
		const settings = Settings.isolated({
			"async.enabled": false,
			"retry.enabled": false,
			// The primary turn's turn_end awaits the advisor drain until the
			// backlog empties, so `await session.prompt(...)` observes the whole
			// maintenance pass with no wall-clock polling.
			"advisor.syncBacklog": "1",
			"compaction.enabled": true,
			"compaction.remote": false,
			// Absolute trigger: the keep-recent ceiling derivation only runs for
			// the AUTO threshold, so 200 stays the elision budget.
			"compaction.threshold": "1000",
			"compaction.keepRecentTokens": 200,
			// No model promotion mid-test: the advisor model under test stays put.
			"contextPromotion.enabled": false,
		});
		settings.setModelRole("advisor", `${ELISION_PROVIDER}/${ELISION_MODEL_ID}`);

		const advisorBatches: string[] = [];
		const advisorStreamFn: StreamFn = (requestModel, requestContext) => {
			const last = requestContext.messages.at(-1);
			let text = "";
			if (last?.role === "user") {
				const content = last.content;
				text =
					typeof content === "string" ? content : content.map(b => (b.type === "text" ? b.text : "")).join("\n");
			}
			advisorBatches.push(text);
			return completedStream(assistantMessage(requestModel, "ADVISOR-REPLY"));
		};

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn,
		});
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		// Seed the advisor's accumulated history: six small turns to summarize
		// away, then a final turn whose one tool result dwarfs the keep-recent
		// budget, so prepareCompaction's elision fires.
		const advisorModel = modelRegistry.find(ELISION_PROVIDER, ELISION_MODEL_ID);
		if (!advisorModel) throw new Error("Expected the registered advisor model to resolve");
		const seeded: AgentMessage[] = [];
		for (let i = 0; i < 6; i++) {
			seeded.push({ role: "user", content: `old question ${i}`, timestamp: Date.now() });
			seeded.push(assistantMessage(advisorModel, `old answer ${i}`));
		}
		seeded.push({ role: "user", content: "read the big file", timestamp: Date.now() });
		seeded.push({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-big", name: "read", arguments: { path: "big.txt" } }],
			api: advisorModel.api,
			provider: advisorModel.provider,
			model: advisorModel.id,
			stopReason: "toolUse",
			usage: usage(1000, 100),
			timestamp: Date.now(),
		});
		seeded.push({
			role: "toolResult",
			toolCallId: "call-big",
			toolName: "read",
			content: [{ type: "text", text: HUGE }],
			isError: false,
			timestamp: Date.now(),
		});
		advisor.replaceMessages(seeded);

		return {
			session,
			sessionManager,
			modelRegistry,
			advisor,
			compactionStreamCalls: () => compactionStreamCalls,
			advisorBatches,
		};
	}

	it("a successful advisor compaction leaves a pointered marker and a recovery artifact", async () => {
		const harness = await createHarness("ok");

		await harness.session.prompt("inspect the big file run");
		await harness.session.waitForIdle();

		// The maintenance pass really compacted (summarizer ran) and the drain
		// still delivered the primary turn to the advisor afterwards.
		expect(harness.compactionStreamCalls()).toBeGreaterThan(0);
		expect(harness.advisorBatches).toHaveLength(1);

		const messages = harness.advisor.state.messages;
		expect(messages[0]?.role).toBe("compactionSummary");
		expect(JSON.stringify(messages[0])).toContain("SUMMARY-TEXT");

		// The marker in advisor memory carries the recovery pointer, and the
		// artifact behind it holds the original bytes.
		const marker = advisorMarkerText(messages);
		expect(marker).toBeDefined();
		expect(marker!).toContain("artifact://");
		const artifactId = marker!.match(/artifact:\/\/([A-Za-z0-9_-]+)/)?.[1];
		expect(artifactId).toBeDefined();
		const artifactPath = await harness.sessionManager.getArtifactPath(artifactId!);
		expect(artifactPath).not.toBeNull();
		expect(await fs.readFile(artifactPath!, "utf8")).toContain(HUGE);

		// The pre-elision bulk itself is out of advisor memory (that bound is
		// the point of the elision).
		expect(JSON.stringify(messages)).not.toContain(HUGE);
	});

	it("a failed offload restores the original content instead of a dead marker", async () => {
		const harness = await createHarness("ok");
		vi.spyOn(harness.sessionManager, "saveArtifact").mockRejectedValue(new Error("disk full"));

		await harness.session.prompt("inspect the big file run");
		await harness.session.waitForIdle();

		expect(harness.compactionStreamCalls()).toBeGreaterThan(0);
		const messages = harness.advisor.state.messages;
		// The compaction itself succeeded: the summary leads the rebuilt history.
		expect(messages[0]?.role).toBe("compactionSummary");
		// No pointerless marker may persist: with nothing to point at, the
		// advisor keeps the original bytes (its next pass re-elides if the tail
		// is still heavy).
		const json = JSON.stringify(messages);
		expect(json).not.toContain("output elided by compaction");
		expect(json).toContain(HUGE);
	});

	it("a failed summarizer falls back to re-prime with no elision trace", async () => {
		const harness = await createHarness("fail");

		await harness.session.prompt("inspect the big file run");
		await harness.session.waitForIdle();

		// The summarizer was attempted and failed, so the pass fell back to
		// re-prime: the advisor was rebuilt from the primary transcript.
		expect(harness.compactionStreamCalls()).toBeGreaterThan(0);
		expect(harness.advisorBatches).toHaveLength(1);
		expect(harness.advisorBatches[0]).toContain("MAIN-ANSWER");

		const json = JSON.stringify(harness.advisor.state.messages);
		expect(json).not.toContain("output elided by compaction");
		// Re-prime replaced the seeded history by design; nothing from the
		// failed pass may linger.
		expect(json).not.toContain(HUGE);
		expect(json).not.toContain("old question 0");
	});

	it("a maintenance pass that dies mid-flight leaves advisor memory byte-identical", async () => {
		const harness = await createHarness("ok");
		// Throw between prepareCompaction (which already applied the elision to
		// its scratch entries) and the summarizer: the candidate loop's key
		// lookup sits outside its try, so the pass dies here. The advisor turn's
		// own key path goes through getApiKeyForProvider and is unaffected.
		const getApiKey = harness.modelRegistry.getApiKey.bind(harness.modelRegistry);
		vi.spyOn(harness.modelRegistry, "getApiKey").mockImplementation(async (model, sessionId) => {
			if (model.provider === ELISION_PROVIDER) throw new Error("keystore unavailable");
			return getApiKey(model, sessionId);
		});

		const prePassCount = harness.advisor.state.messages.length;
		const prePassJson = JSON.stringify(harness.advisor.state.messages);

		await harness.session.prompt("inspect the big file run");
		await harness.session.waitForIdle();

		// The runtime caught the dead pass and still delivered the turn.
		expect(harness.compactionStreamCalls()).toBe(0);
		expect(harness.advisorBatches).toHaveLength(1);

		const after = harness.advisor.state.messages;
		// The pre-pass history survived untouched: the elision only ever
		// touched the preparation's scratch entries, which died with the pass.
		expect(JSON.stringify(after.slice(0, prePassCount))).toBe(prePassJson);
		expect(JSON.stringify(after)).not.toContain("output elided by compaction");
	});
});
