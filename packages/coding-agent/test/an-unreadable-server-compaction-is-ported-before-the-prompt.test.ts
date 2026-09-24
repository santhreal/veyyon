/**
 * WHY: a server-side compaction stores a window only its minting provider can
 * decrypt. A session that moved to another provider (a model switch, a resume, or
 * a compaction started on the old model that landed after the switch) sent its
 * next prompt with that window dropped, and a rebuild re-expanded every message
 * the window stood in for: on a long session, a request of millions of tokens.
 *
 * The contract: before the prompt is built, and before any automatic compaction
 * measures the context, the minting provider summarizes its own window once, the
 * summary is appended as a local compaction with the same keep marker, and the
 * prompt carries that summary instead of the raw span. When the minting provider
 * has no credential nothing is sent to it, and the rebuild fallback stands. A
 * session on the minting provider replays the window and never pays for a port.
 *
 * The ordering is the class this suite closes: a compaction check that runs
 * first (the pre-prompt check of the last assistant turn, the idle pass) sees the
 * re-expanded span over its threshold and summarizes it on the active provider,
 * which on a long session is hundreds of staged requests, and the port that would
 * have cost one request never runs because the newest compaction is then local.
 *
 * Not caught here: the wire shape the minting provider receives for the window
 * (covered by build-context-remote-compaction.test.ts), ports of a window
 * minted by a provider absent from the model registry, and the post-turn and
 * mid-run checks, which only see an unported window when the port failed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type StreamFn } from "@veyyon/agent-core";
import { REMOTE_COMPACTION_PRESERVE_KEY, type RemoteCompactionPreserveData } from "@veyyon/agent-core/compaction";
import type { Context, Message, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { getLatestCompactionEntry } from "@veyyon/kernel/session/session-context";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import type { AgentSessionEvent } from "../src/session/agent-session-types";
import { convertToLlm } from "../src/session/messages";

const ENCRYPTED_BLOB = "gAAAAABpM0Yj-port-fixture";
const PORTED_SUMMARY = "Ported summary of the compacted span.";
const MINTING = { provider: "openai", id: "gpt-5.1" } as const;
const FOREIGN = { provider: "azure", id: "gpt-4-32k" } as const;

function usage() {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function streamReplying(model: Model, text: string): AssistantMessageEventStream {
	const message = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(),
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

function textOf(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

function bundled(ref: { provider: string; id: string }): Model {
	const model = getBundledModel(ref.provider, ref.id);
	if (!model) throw new Error(`Expected bundled ${ref.provider}/${ref.id}`);
	return model;
}

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	remoteKeptEntryId: string;
	sideCalls: Array<{ model: Model; context: Context }>;
	mainContexts: Context[];
	events: AgentSessionEvent[];
}

describe("a server-side compaction the active provider cannot read", () => {
	let tempDir: TempDir;
	const cleanups: Array<() => Promise<void>> = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-compaction-port-");
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	async function harness(
		active: { provider: string; id: string },
		mintingHasCredential: boolean,
		options: { overThreshold?: boolean } = {},
	): Promise<Harness> {
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `auth-${cleanups.length}.db`));
		authStorage.setRuntimeApiKey(active.provider, "test-key");
		if (mintingHasCredential) authStorage.setRuntimeApiKey(MINTING.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${cleanups.length}.yml`));
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const activeModel = bundled(active);
		// Over threshold: the span the window hid, re-expanded, alone outgrows the
		// active model's window, as a long session's does.
		const contextWindow = activeModel.contextWindow;
		if (!contextWindow) throw new Error(`Expected a context window on ${active.provider}/${active.id}`);
		const padding = options.overThreshold ? " filler".repeat(contextWindow) : "";

		const minting = bundled(MINTING);
		for (let i = 0; i < 4; i++) {
			sessionManager.appendMessage({
				role: "user",
				content: `discarded turn ${i}${padding}`,
				timestamp: Date.now(),
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `discarded reply ${i}` }],
				api: minting.api,
				provider: minting.provider,
				model: minting.id,
				usage: usage(),
				stopReason: "stop",
				timestamp: Date.now(),
			});
		}
		const remoteKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: "kept turn",
			timestamp: Date.now(),
		});
		const window: RemoteCompactionPreserveData = {
			version: 1,
			provider: minting.provider,
			api: minting.api,
			model: minting.id,
			window: [{ id: "cmp_001", type: "compaction", encrypted_content: ENCRYPTED_BLOB }],
			compactedAt: "2025-01-01T00:02:00Z",
		};
		sessionManager.appendCompaction("", undefined, remoteKeptEntryId, 200_000, undefined, false, {
			[REMOTE_COMPACTION_PRESERVE_KEY]: window,
		});
		sessionManager.appendModelChange(`${active.provider}/${active.id}`);

		const sideCalls: Harness["sideCalls"] = [];
		const mainContexts: Context[] = [];
		const sideStreamFn: StreamFn = (model, context) => {
			sideCalls.push({ model, context });
			return streamReplying(model, PORTED_SUMMARY);
		};
		let session: AgentSession | undefined;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: activeModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: sessionManager.buildSessionContext().messages,
			},
			convertToLlm,
			getToolChoice: () => session?.nextToolChoiceDirective(),
			streamFn: (model, context) => {
				mainContexts.push(context);
				return streamReplying(model, "answer");
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": options.overThreshold === true,
				"todo.enabled": false,
				"todo.reminders": false,
			}),
			modelRegistry,
			sideStreamFn,
		});
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => {
			events.push(event);
		});
		const owned = session;
		cleanups.push(async () => {
			await owned.dispose();
			authStorage.close();
		});
		return { session, sessionManager, remoteKeptEntryId, sideCalls, mainContexts, events };
	}

	it("is summarized once by the minting provider and the prompt carries that summary", async () => {
		const h = await harness(FOREIGN, true);
		await h.session.prompt("next question");
		await h.session.waitForIdle();

		expect(h.sideCalls.map(call => `${call.model.provider}/${call.model.id}`)).toEqual([
			`${MINTING.provider}/${MINTING.id}`,
		]);
		// The minting provider received its own window, not a blank divider.
		expect(JSON.stringify(h.sideCalls[0].context.messages)).toContain(ENCRYPTED_BLOB);

		const ported = getLatestCompactionEntry(h.sessionManager.getBranch());
		expect(ported?.summary).toBe(PORTED_SUMMARY);
		expect(ported?.firstKeptEntryId).toBe(h.remoteKeptEntryId);
		expect(ported?.preserveData?.[REMOTE_COMPACTION_PRESERVE_KEY]).toBeUndefined();

		expect(h.mainContexts).toHaveLength(1);
		const sent = h.mainContexts[0].messages.map(textOf);
		expect(sent[0]).toContain(PORTED_SUMMARY);
		expect(sent.some(text => text.includes("discarded turn"))).toBe(false);
		expect(sent).toContain("kept turn");
		expect(sent.at(-1)).toBe("next question");

		const starts = h.events.filter(event => event.type === "auto_compaction_start");
		expect(starts.map(event => event.reason)).toEqual(["provider_switch"]);
		const end = h.events.find(event => event.type === "auto_compaction_end");
		expect(end?.type === "auto_compaction_end" && end.result?.summary).toBe(PORTED_SUMMARY);
	});

	it("is ported before the pre-prompt check measures the re-expanded span", async () => {
		const h = await harness(FOREIGN, true, { overThreshold: true });
		await h.session.prompt("next question");
		await h.session.waitForIdle();

		// One request, to the minting provider; nothing summarized the raw span on
		// the active provider.
		expect(h.sideCalls.map(call => `${call.model.provider}/${call.model.id}`)).toEqual([
			`${MINTING.provider}/${MINTING.id}`,
		]);
		expect(h.events.filter(event => event.type === "auto_compaction_start").map(event => event.reason)).toEqual([
			"provider_switch",
		]);
		const compactions = h.sessionManager.getBranch().filter(entry => entry.type === "compaction");
		expect(compactions.map(entry => entry.type === "compaction" && entry.summary)).toEqual(["", PORTED_SUMMARY]);
		expect(h.mainContexts).toHaveLength(1);
		expect(h.mainContexts[0].messages.map(textOf).some(text => text.includes("discarded turn"))).toBe(false);
	});

	it("is ported, and not compacted again, by the idle pass", async () => {
		const h = await harness(FOREIGN, true, { overThreshold: true });
		await h.session.runIdleCompaction();

		expect(h.sideCalls.map(call => `${call.model.provider}/${call.model.id}`)).toEqual([
			`${MINTING.provider}/${MINTING.id}`,
		]);
		const compactions = h.sessionManager.getBranch().filter(entry => entry.type === "compaction");
		expect(compactions.map(entry => entry.type === "compaction" && entry.summary)).toEqual(["", PORTED_SUMMARY]);
		expect(
			h.session.messages.map(message => JSON.stringify(message)).some(text => text.includes("discarded turn")),
		).toBe(false);
	});

	it("is left in place, with no request to the minting provider, when it has no credential", async () => {
		const h = await harness(FOREIGN, false);
		await h.session.prompt("next question");
		await h.session.waitForIdle();

		expect(h.sideCalls).toEqual([]);
		const compactions = h.sessionManager.getBranch().filter(entry => entry.type === "compaction");
		expect(compactions.map(entry => entry.type === "compaction" && entry.summary)).toEqual([""]);
		expect(h.events.some(event => event.type === "auto_compaction_start")).toBe(false);
	});

	it("is replayed, not ported, by a session on the minting provider", async () => {
		const h = await harness(MINTING, true);
		await h.session.prompt("next question");
		await h.session.waitForIdle();

		expect(h.sideCalls).toEqual([]);
		expect(getLatestCompactionEntry(h.sessionManager.getBranch())?.summary).toBe("");
		expect(h.events.some(event => event.type === "auto_compaction_start")).toBe(false);
	});
});
