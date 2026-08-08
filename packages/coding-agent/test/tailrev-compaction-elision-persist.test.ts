/**
 * WHY: the success-path contract of compaction tail elision. A real
 * AgentSession whose kept tail carries an over-budget tool result compacts
 * through the real prepareCompaction elision and the real
 * `#persistCompactionTailElisions`: the marker left on the branch must carry
 * the `artifact://` recovery pointer, the artifact must hold the original
 * bytes, the session file must persist the pointered marker (not the
 * pre-elision bulk), and the marker's token estimate must reflect the
 * pointer bytes.
 *
 * The estimate assertion is the sharp one. `estimateTokens` caches by
 * message object identity (token-estimate.ts), and the summarizer seam below
 * estimates the pointerless marker mid-pass — exactly what any consumer
 * between prepare and persist (context meter, advisor) legitimately does.
 * A persist step that patched the marker's content IN PLACE would leave that
 * primed, pre-pointer estimate behind for every later read; the persist step
 * therefore replaces the marker with a NEW message object, the same
 * replace-not-mutate rule the elision producer follows.
 *
 * Mutation gate: revert `#persistCompactionTailElisions` to
 * `elision.message.content = [...]` → the estimate assertions fail (the
 * mid-pass primed estimate survives the patch). Skip the artifact offload →
 * the pointer and artifact assertions fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentMessage, type StreamFn } from "@veyyon/agent-core";
import { estimateTokens } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Model, ToolResultMessage, Usage } from "@veyyon/ai";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import type { SessionEntry } from "@veyyon/coding-agent/session/session-entries";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

const HUGE = "x".repeat(40_000);

const usage = (input: number, output: number): Usage => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function assistantMessage(model: Model, text: string): AssistantMessage {
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

/** The tool-result message on the branch whose text is an elision marker, if any. */
function branchMarker(entries: SessionEntry[]): ToolResultMessage | undefined {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const content = (entry.message as ToolResultMessage).content;
		const text =
			typeof content === "string" ? content : content.map(b => (b.type === "text" ? b.text : "")).join("\n");
		if (text.includes("output elided by compaction")) return entry.message as ToolResultMessage;
	}
	return undefined;
}

describe("a successful compaction persists a pointered, correctly estimated elision marker", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let primedEstimate: number | undefined;

	beforeEach(async () => {
		primedEstimate = undefined;
		tempDir = TempDir.createSync("@pi-tailrev-elision-persist-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		// Six small turns to summarize away, then a final turn whose one tool
		// result dwarfs the keep-recent budget, so elideTailToolResults fires.
		for (let i = 0; i < 6; i++) {
			sessionManager.appendMessage({ role: "user", content: `old question ${i}`, timestamp: Date.now() });
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `old answer ${i}` }],
				api: model.api,
				provider: "anthropic",
				model: model.id,
				stopReason: "stop",
				usage: usage(1000, 100),
				timestamp: Date.now(),
			});
		}
		sessionManager.appendMessage({ role: "user", content: "read the big file", timestamp: Date.now() });
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-big", name: "read", arguments: { path: "big.txt" } }],
			api: model.api,
			provider: "anthropic",
			model: model.id,
			stopReason: "toolUse",
			usage: usage(1000, 100),
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-big",
			toolName: "read",
			content: [{ type: "text", text: HUGE }],
			isError: false,
			timestamp: Date.now(),
		});

		const sideStreamFn: StreamFn = requestModel => {
			// Elision is a prepare-time side effect, so the pointerless marker is
			// already on the branch when the summarizer runs. Estimate it here —
			// the mid-pass read any consumer may make — so a persist step that
			// mutated the marker in place would serve this pre-pointer size to
			// every later estimate.
			const marker = branchMarker(sessionManager.getBranch());
			primedEstimate = marker ? estimateTokens(marker as AgentMessage) : undefined;
			return completedStream(assistantMessage(requestModel, "SUMMARY-TEXT: the old turns condensed"));
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				// Manual compact() only: auto-compaction must never fire on its own.
				"compaction.enabled": false,
				// The local summarizer is the path under test; remote has its own suite.
				"compaction.remote": false,
				"compaction.keepRecentTokens": 200,
				"retry.enabled": false,
			}),
			modelRegistry,
			sideStreamFn,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
		}
	});

	it("leaves a pointered marker, a recovery artifact, and a truthful estimate", async () => {
		const result = await session.compact();
		expect(result.summary).toContain("SUMMARY-TEXT");

		// The elision really happened before the summarizer ran (the seam
		// observed the pointerless marker and primed its estimate).
		expect(primedEstimate).toBeDefined();

		const branch = sessionManager.getBranch();
		const marker = branchMarker(branch);
		expect(marker).toBeDefined();
		const content = marker!.content;
		const text =
			typeof content === "string" ? content : content.map(b => (b.type === "text" ? b.text : "")).join("\n");
		expect(text).toContain("output elided by compaction");
		expect(text).toContain("artifact://");

		// The recovery artifact holds the original bytes.
		const artifactId = text.match(/artifact:\/\/([A-Za-z0-9_-]+)/)?.[1];
		expect(artifactId).toBeDefined();
		const artifactPath = await sessionManager.getArtifactPath(artifactId!);
		expect(artifactPath).not.toBeNull();
		const artifactText = await fs.readFile(artifactPath!, "utf8");
		expect(artifactText).toContain(HUGE);

		// The marker's estimate reflects the pointer bytes: the persist step
		// replaced the message object, so the mid-pass primed estimate of the
		// pointerless marker could not ride forward. A structurally identical
		// fresh object is the estimator's ground truth.
		const fresh = JSON.parse(JSON.stringify(marker)) as AgentMessage;
		expect(estimateTokens(marker as AgentMessage)).toBe(estimateTokens(fresh));
		expect(estimateTokens(marker as AgentMessage)).toBeGreaterThan(primedEstimate!);

		// The session file persists the pointered marker, and the pre-elision
		// bulk is gone from it (that bound is the point of the elision).
		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const onDisk = await fs.readFile(sessionFile!, "utf8");
		expect(onDisk).toContain(`artifact://${artifactId}`);
		expect(onDisk).not.toContain(HUGE);
	});
});
