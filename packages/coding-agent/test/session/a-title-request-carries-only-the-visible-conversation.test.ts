/**
 * WHY THIS SUITE EXISTS. `ReplanTitleRefresh` asks a model for a new session title from the latest turns.
 * It used to copy each assistant turn's reasoning blocks into that request, wrapped in tags. A provider
 * rejects a request that hands one model's hidden reasoning to another, so every replan refresh on such a
 * provider ended in a title-generator response error and the title never changed.
 *
 * THE CLASS. Every kind of assistant content block, and every kind of user content block, reaching the
 * title request. Each kind is listed in a record keyed by its `type`, so a block kind added to the message
 * contract fails the type check until it is classified here as visible or not. Only text is visible.
 *
 * WHAT IT DOES NOT CATCH. Reasoning the user pasted into their own message as text, which is the user's
 * visible words. Other side requests (compaction, handoff) have their own suites.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, UserMessage } from "@veyyon/ai";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { ReplanTitleRefresh, type ReplanTitleStore } from "@veyyon/coding-agent/session/runtime/replan-title-refresh";
import * as titleGenerator from "@veyyon/coding-agent/utils/title-generator";

const HIDDEN = "HIDDEN-SENTINEL";
const VISIBLE = "rename the parser diagnostics";

type AssistantBlock = AssistantMessage["content"][number];
type UserBlock = Exclude<UserMessage["content"], string>[number];

/** Samples of every assistant block kind. A kind missing here is a type error. */
const ASSISTANT_BLOCKS: { [K in AssistantBlock["type"]]: Array<Extract<AssistantBlock, { type: K }>> } = {
	text: [{ type: "text", text: VISIBLE }],
	thinking: [
		{ type: "thinking", thinking: `${HIDDEN} unsigned` },
		{ type: "thinking", thinking: `${HIDDEN} signed`, thinkingSignature: "sig-1" },
	],
	redactedThinking: [{ type: "redactedThinking", data: HIDDEN }],
	fallback: [{ type: "fallback", from: { model: HIDDEN }, to: { model: HIDDEN } }],
	toolCall: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: HIDDEN } }],
};

/** Samples of every user block kind. A kind missing here is a type error. */
const USER_BLOCKS: { [K in UserBlock["type"]]: Array<Extract<UserBlock, { type: K }>> } = {
	text: [{ type: "text", text: VISIBLE }],
	image: [{ type: "image", data: HIDDEN, mimeType: "image/png" }],
};

function assistant(content: AssistantBlock[]): AgentMessage {
	return { role: "assistant", content, stopReason: "stop", timestamp: 2 } as unknown as AgentMessage;
}

function user(content: UserBlock[]): AgentMessage {
	return { role: "user", content, timestamp: 1 } as unknown as AgentMessage;
}

const store: ReplanTitleStore = {
	titleSource: "auto",
	getSessionId: () => "session-a",
	setSessionName: async () => true,
};

/** The context string the title generator receives for `messages`, or undefined when no request is made. */
async function titleRequestFor(messages: AgentMessage[]): Promise<string | undefined> {
	const requests: string[] = [];
	vi.spyOn(titleGenerator, "generateSessionTitle").mockImplementation(async context => {
		requests.push(context);
		return null;
	});
	const settings = Settings.isolated();
	settings.set("title.refreshOnReplan", true);
	const refresh = new ReplanTitleRefresh(
		{
			agent: { state: { messages }, metadataForProvider: () => undefined },
			sessionStore: store,
			settings,
			modelRegistry: {} as ModelRegistry,
			sideComplete: () => {
				throw new Error("the generator is replaced; no side request is made");
			},
			model: () => undefined,
			thinkingLevel: () => undefined,
			obfuscateProviderText: text => text,
		},
		undefined,
	);
	refresh.schedule();
	for (let tick = 0; tick < 20; tick++) await Promise.resolve();
	vi.restoreAllMocks();
	expect(requests.length).toBeLessThanOrEqual(1);
	return requests[0];
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a title request carries only the visible conversation", () => {
	for (const [kind, samples] of Object.entries(ASSISTANT_BLOCKS)) {
		samples.forEach((block, index) => {
			it(`an assistant ${kind} block (sample ${index}) beside visible text`, async () => {
				const request = await titleRequestFor([
					user([{ type: "text", text: "start" }]),
					assistant([block, { type: "text", text: "visible reply" }]),
				]);
				expect(request).toBe(
					kind === "text"
						? `<chat>\n<user>\nstart\n</user>\n\n<assistant>\n${VISIBLE}\n\nvisible reply\n</assistant>\n</chat>`
						: "<chat>\n<user>\nstart\n</user>\n\n<assistant>\nvisible reply\n</assistant>\n</chat>",
				);
			});

			it(`an assistant turn holding only a ${kind} block (sample ${index})`, async () => {
				const request = await titleRequestFor([user([{ type: "text", text: "start" }]), assistant([block])]);
				expect(request).toBe(
					kind === "text"
						? `<chat>\n<user>\nstart\n</user>\n\n<assistant>\n${VISIBLE}\n</assistant>\n</chat>`
						: "<chat>\n<user>\nstart\n</user>\n</chat>",
				);
			});
		});
	}

	for (const [kind, samples] of Object.entries(USER_BLOCKS)) {
		samples.forEach((block, index) => {
			it(`a user ${kind} block (sample ${index})`, async () => {
				const request = await titleRequestFor([user([block, { type: "text", text: "and this" }])]);
				expect(request).toBe(
					kind === "text"
						? `<chat>\n<user>\n${VISIBLE}\n\nand this\n</user>\n</chat>`
						: "<chat>\n<user>\nand this\n</user>\n</chat>",
				);
			});
		});
	}

	it("makes no request when no turn has visible text", async () => {
		const hiddenOnly = [...ASSISTANT_BLOCKS.thinking, ...ASSISTANT_BLOCKS.redactedThinking];
		expect(await titleRequestFor([assistant(hiddenOnly)])).toBeUndefined();
	});
});
