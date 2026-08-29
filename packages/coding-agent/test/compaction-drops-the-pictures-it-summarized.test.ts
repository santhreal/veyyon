/**
 * WHY: a compaction writes a summary of the history it discards, and until now
 * the pictures that history carried rode straight through it. An image costs
 * the same large block of the window on every turn that replays it, so a
 * session that pasted three screenshots kept paying for them long after the
 * turns around them were summarized into a sentence. Compaction now drops the
 * images the KEPT region still carries, and `compaction.keepImages` turns that
 * off for a session whose subject is the picture itself.
 *
 * The class this closes is "a compaction landed and the images survived it",
 * for every entry point that appends a compaction entry: the manual `/compact`
 * path (`AgentSession.compact`) and the threshold-triggered automatic one. Both
 * are driven here through the real session, the real preparation and a
 * summarizer seam, not through the private helper.
 *
 * What it does not catch: a THIRD commit site added later, since the two are
 * enumerated by hand — the suite cannot see a new one that forgets the drop. It
 * also says nothing about a provider-side ("remote") compaction that never
 * rewrites the local branch.
 *
 * Mutation gate: delete either `#dropImagesAfterCompaction` call → the matching
 * case fails; make the drop unconditional (ignore the setting) → the keep case
 * fails; widen it past `firstKeptEntryId` → the summarized-away case fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type StreamFn } from "@veyyon/agent-core";
import type { AssistantMessage, Model, Usage } from "@veyyon/ai";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import type { SessionEntry } from "@veyyon/coding-agent/session/session-entries";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

/** Distinct payloads, so "which image survived" is answerable from the bytes. */
const OLD_IMAGE = "b2xkLXBpY3R1cmUtYnl0ZXM";
const KEPT_IMAGE = "a2VwdC1waWN0dXJlLWJ5dGVz";

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

/** Every base64 payload of every image block still on the branch. */
function imagesOnBranch(entries: readonly SessionEntry[]): string[] {
	const found: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !("content" in entry.message)) continue;
		const content = entry.message.content;
		if (typeof content === "string" || !Array.isArray(content)) continue;
		for (const block of content) {
			if (block.type === "image") found.push(block.data);
		}
	}
	return found;
}

/** Every text block on the branch, so a placeholder can be looked for. */
function textOnBranch(entries: readonly SessionEntry[]): string {
	const parts: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !("content" in entry.message)) continue;
		const content = entry.message.content;
		if (typeof content === "string") {
			parts.push(content);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block.type === "text") parts.push(block.text);
		}
	}
	return parts.join("\n");
}

describe("a compaction drops the pictures it summarized", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let model: Model;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-compaction-images-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
		model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };
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

	/**
	 * Six early turns carrying one image, then a recent turn carrying another.
	 * The cut lands between them, so one image is in the summarized-away region
	 * and one is in the kept tail.
	 */
	function seedBranch(): void {
		sessionManager.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "here is the old screenshot" },
				{ type: "image", data: OLD_IMAGE, mimeType: "image/png" },
			],
			timestamp: Date.now(),
		});
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
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "image", data: KEPT_IMAGE, mimeType: "image/png" }],
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "the recent picture shows a stack trace" }],
			api: model.api,
			provider: "anthropic",
			model: model.id,
			stopReason: "stop",
			usage: usage(1000, 100),
			timestamp: Date.now(),
		});
	}

	function startSession(overrides: Record<string, unknown> = {}): void {
		const sideStreamFn: StreamFn = requestModel =>
			completedStream(assistantMessage(requestModel, "SUMMARY-TEXT: the old turns, condensed"));
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"compaction.remote": false,
				"compaction.keepRecentTokens": 200,
				"retry.enabled": false,
				...overrides,
			}),
			modelRegistry: new ModelRegistry(authStorage),
			sideStreamFn,
		});
	}

	it("leaves no image in the history the next request replays", async () => {
		seedBranch();
		startSession();

		const result = await session.compact();
		expect(result.summary).toContain("SUMMARY-TEXT");

		expect(imagesOnBranch(sessionManager.getBranch())).not.toContain(KEPT_IMAGE);
		// The message was nothing but the picture, so something has to stand
		// where it was: an empty content array is rejected by every provider.
		expect(textOnBranch(sessionManager.getBranch())).toContain("[image removed]");

		// The rebuilt context is what actually travels, and the rewrite is on disk.
		const contextImages = session.buildDisplaySessionContext().messages.flatMap(message => {
			if (!("content" in message)) return [];
			const content = message.content;
			if (typeof content === "string" || !Array.isArray(content)) return [];
			return content.filter(block => block.type === "image");
		});
		expect(contextImages).toHaveLength(0);

		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		expect(await fs.readFile(sessionFile!, "utf8")).not.toContain(KEPT_IMAGE);
	});

	it("keeps every picture when the setting says to", async () => {
		seedBranch();
		startSession({ "compaction.keepImages": true });

		await session.compact();

		expect(imagesOnBranch(sessionManager.getBranch())).toContain(KEPT_IMAGE);
		expect(textOnBranch(sessionManager.getBranch())).not.toContain("[image removed]");
	});

	it("does not reach back into the transcript it summarized away", async () => {
		// Those entries reach no request, so stripping them would free nothing
		// and would erase what an export, a `/fork` or a resume reads.
		seedBranch();
		startSession();

		await session.compact();

		expect(imagesOnBranch(sessionManager.getBranch())).toContain(OLD_IMAGE);
	});

	it("drops them on the automatic path too, not only on /compact", async () => {
		seedBranch();
		// A wide keep-recent window, so the picture is inside the region the
		// automatic cut keeps rather than inside the region it summarizes away:
		// the drop, not the cut, has to be what removes it.
		startSession({ "compaction.enabled": true, "compaction.keepRecentTokens": 20_000 });

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);

		// A turn that lands over the threshold: the session runs maintenance on
		// its own, exactly as it would after a real reply.
		const heavy: AssistantMessage = {
			...assistantMessage(model, "Done."),
			usage: usage(190_000, 1000),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: heavy });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [heavy] });

		await compactionDone;
		await session.waitForIdle();

		const branch = sessionManager.getBranch();
		const compaction = branch.find(entry => entry.type === "compaction");
		expect(compaction).toBeDefined();
		const images = imagesOnBranch(branch);
		expect(images).not.toContain(KEPT_IMAGE);
		// The dead-end rescue strips the WHOLE branch, so a run where it fired
		// would pass the line above for the wrong reason. The summarized-away
		// picture surviving is what proves the scoped pass did this.
		expect(images).toContain(OLD_IMAGE);
	});
});
