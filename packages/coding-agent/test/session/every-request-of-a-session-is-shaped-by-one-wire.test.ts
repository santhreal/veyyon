/**
 * WHY THIS SUITE EXISTS. `ProviderWire` is the transform every request of a session runs: the main
 * turn, side requests, compaction and advisors each call `transform` with their own model. Its state is
 * the session's: one tool-call id map, the root paths render under, and the settings read per request.
 * A caller that shaped through a wire of its own would serialize an earlier tool call under a different
 * handle than the main turn sent it with, and the provider's cached prefix would stop matching.
 *
 * THE CLASS. State that must be shared by every caller of the session wire: the id handles, the active
 * root and its rollback, and the settings, which are read on each request rather than at construction.
 * The last step is pinned as well: the caller's transform replaces secret obfuscation, it does not run
 * beside it.
 *
 * WHAT IT DOES NOT CATCH. The canonicalizer's own rendering (`provider-context-canonicalizer.test.ts`),
 * the signature policy and the image policy are their suites' contracts; this suite checks that the wire
 * applies them per request, not what they produce.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, Message, ToolResultMessage, UserMessage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { SecretRuntimeLease } from "@veyyon/coding-agent/session/agent-session-types";
import {
	ProviderWire,
	type ProviderWireOptions,
	type ProviderWireSecrets,
} from "@veyyon/coding-agent/session/runtime/provider-wire";

const CWD = "/srv/checkout/alpha";
const OTHER_CWD = "/srv/checkout/beta";
const TIMESTAMP = 1_756_080_000;

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected the bundled anthropic model to exist");

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: TIMESTAMP };
}

function toolCall(id: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "bash", arguments: { command: "ls" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: TIMESTAMP,
	};
}

function toolResult(id: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: TIMESTAMP,
	};
}

function context(messages: Message[]): Context {
	return { systemPrompt: ["test"], messages, tools: [] };
}

/** Secret obfuscation that records each context it was handed. */
function recordingSecrets(): ProviderWireSecrets & { readonly seen: Context[] } {
	const seen: Context[] = [];
	return {
		seen,
		obfuscateContext(shaped: Context, _runtime: SecretRuntimeLease | undefined): Context {
			seen.push(shaped);
			return shaped;
		},
	};
}

function wire(overrides: Partial<ProviderWireOptions> = {}): ProviderWire {
	return new ProviderWire({
		settings: Settings.isolated(),
		cwd: CWD,
		upstream: undefined,
		secrets: recordingSecrets(),
		...overrides,
	});
}

async function shape(target: ProviderWire, messages: Message[]): Promise<Message[]> {
	return (await target.transform(context(messages), model)).messages;
}

function toolCallIdsOf(messages: readonly Message[]): string[] {
	const ids: string[] = [];
	for (const message of messages) {
		if (message.role === "toolResult") ids.push(message.toolCallId);
		if (message.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "toolCall") ids.push(block.id);
	}
	return ids;
}

function textOf(message: Message | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

describe("every request of a session is shaped by one wire", () => {
	it("gives a tool call the same handle whichever caller sends it", async () => {
		const sessionWire = wire();
		const history: Message[] = [user("list it"), toolCall("call_provider_a"), toolResult("call_provider_a", "ok")];

		// The main turn sends the history, then a side request built from fresh copies sends it again.
		const mainTurn = await shape(sessionWire, history);
		const sideRequest = await shape(sessionWire, structuredClone(history));

		expect(toolCallIdsOf(mainTurn)).toEqual(["tc_1", "tc_1"]);
		expect(toolCallIdsOf(sideRequest)).toEqual(["tc_1", "tc_1"]);

		// A call the session has not seen takes the next handle rather than reusing one.
		const extended = await shape(sessionWire, [
			...history,
			toolCall("call_provider_b"),
			toolResult("call_provider_b", "ok"),
		]);
		expect(toolCallIdsOf(extended)).toEqual(["tc_1", "tc_1", "tc_2", "tc_2"]);
	});

	it("renders paths under the active root, and under the restored root after a failed move", async () => {
		const sessionWire = wire();
		const before = sessionWire.roots;

		const atAlpha = await shape(sessionWire, [user(`read ${CWD}/src/main.ts`)]);
		expect(textOf(atAlpha[0])).not.toContain(CWD);
		expect(sessionWire.pathBytesSaved).toBeGreaterThan(0);

		sessionWire.rootAt(OTHER_CWD);
		const atBeta = await shape(sessionWire, [user(`read ${CWD}/src/next.ts`)]);
		expect(textOf(atBeta[0])).toContain(`${CWD}/src/next.ts`);

		sessionWire.restoreRoots(before);
		const restored = await shape(sessionWire, [user(`read ${CWD}/src/last.ts`)]);
		expect(textOf(restored[0])).not.toContain(CWD);
	});

	it("reads the retention settings on each request, not when the session started", async () => {
		const settings = Settings.isolated();
		const sessionWire = wire({ settings });

		const first = await sessionWire.transform(context([user("one")]), model);
		expect(first.thinkingRetention).toBe(-1);

		settings.set("context.thinkingRetention", 4);
		settings.set("context.thoughtSignatureRetention", 2);
		const second = await sessionWire.transform(context([user("one")]), model);
		expect(second.thinkingRetention).toBe(4);
		expect(second.thoughtSignatureRetention).toBe(2);
	});

	it("hands the shaped request to secret obfuscation when no caller transform is configured", async () => {
		const secrets = recordingSecrets();
		const sessionWire = wire({ secrets });

		await sessionWire.transform(context([toolCall("call_provider_a"), toolResult("call_provider_a", "ok")]), model);

		expect(secrets.seen).toHaveLength(1);
		expect(toolCallIdsOf(secrets.seen[0]?.messages ?? [])).toEqual(["tc_1", "tc_1"]);
	});

	it("runs the caller's transform last, in place of secret obfuscation", async () => {
		const secrets = recordingSecrets();
		const upstreamSaw: Context[] = [];
		const sessionWire = wire({
			secrets,
			upstream: shaped => {
				upstreamSaw.push(shaped);
				return { ...shaped, systemPrompt: ["from the caller"] };
			},
		});

		const sent = await sessionWire.transform(
			context([toolCall("call_provider_a"), toolResult("call_provider_a", "ok")]),
			model,
		);

		expect(secrets.seen).toEqual([]);
		expect(upstreamSaw).toHaveLength(1);
		expect(toolCallIdsOf(upstreamSaw[0]?.messages ?? [])).toEqual(["tc_1", "tc_1"]);
		expect(sent.systemPrompt).toEqual(["from the caller"]);
	});
});
