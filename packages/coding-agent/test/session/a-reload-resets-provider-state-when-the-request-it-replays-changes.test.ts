/**
 * WHY THIS SUITE EXISTS:
 *
 * A same-file reload (`AgentSession.reload`) closes the live provider sessions — a Responses chain,
 * a websocket, a cached prefix key — only when the restored conversation differs from the one it
 * replaced. `didSessionMessagesChange` makes that call by projecting each message to the fields a
 * provider replays. A field the projection omits is a reload that keeps a provider chain whose
 * history no longer matches the transcript: the next turn continues from a conversation the
 * operator can no longer see.
 *
 * The existing reload tests append a message, which the length check catches before any projection
 * runs, so no test pinned which fields the projection reads. This suite states the invariant against
 * the request itself: for every role and every field of a sample of that role, a change that alters
 * what `convertToLlm` sends must be reported as a change. Fields that change nothing on the wire
 * (a timestamp, usage) must not be.
 *
 * FAIL BY DEFAULT. `SAMPLES` is a `Record<AgentMessage["role"], …>`, so a new role fails the type
 * check until it has a sample, and every field of every sample is mutated, so a field added to a
 * sample is swept without being listed. Changes the wire carries but the projection deliberately
 * ignores are pinned by exact equality in `REPLAY_EXEMPT`.
 *
 * WHAT IT DOES NOT CATCH: a field a real message carries that its sample here does not. The sweep
 * covers the fields written below; a new field on a role reaches it only when a sample includes it.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { ProviderPayload } from "@veyyon/ai";
import { registerAgentMessageKinds } from "@veyyon/kernel/session/message-kinds";
import { convertToLlm } from "../../src/session/messages";
import { didSessionMessagesChange } from "../../src/session/provider-replay-projection";
import { shellDomain } from "../../src/tools/shell/manifest";

registerAgentMessageKinds(shellDomain.messageKinds);

const USAGE = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0 } };

const PAYLOAD: ProviderPayload = {
	type: "openaiResponsesHistory",
	provider: "openai",
	items: [{ type: "message", id: "msg_1" }],
};

const SAMPLES: Record<AgentMessage["role"], AgentMessage> = {
	user: {
		role: "user",
		content: [
			{ type: "text", text: "read the parser" },
			{ type: "image", data: "AAAA", mimeType: "image/png", detail: "high" },
		],
		synthetic: false,
		steering: false,
		attribution: "user",
		providerPayload: PAYLOAD,
		demotedReasoningSource: { provider: "anthropic", model: "claude-sonnet-4-5" },
		timestamp: 1,
	} as AgentMessage,
	developer: {
		role: "developer",
		content: "prefer small diffs",
		attribution: "agent",
		providerPayload: PAYLOAD,
		demotedReasoningSource: { provider: "anthropic", model: "claude-sonnet-4-5" },
		timestamp: 1,
	} as AgentMessage,
	assistant: {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "look at the tokenizer first", thinkingSignature: "rs_1" },
			{ type: "text", text: "Reading it now.", textSignature: "msg_1" },
			{
				type: "toolCall",
				id: "call-1",
				name: "read",
				arguments: { path: "src/parser.ts" },
				thoughtSignature: "sig",
				customWireName: "read_file",
			},
		],
		api: "openai-completions",
		provider: "local",
		model: "qwen2.5-1.5b",
		usage: USAGE,
		stopReason: "toolUse",
		errorMessage: "none",
		providerPayload: PAYLOAD,
		timestamp: 1,
	} as AgentMessage,
	toolResult: {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "export function parse() {}" }],
		isError: false,
		timestamp: 1,
	},
	custom: { role: "custom", customType: "note", content: "a note", display: true, timestamp: 1 },
	hookMessage: { role: "hookMessage", customType: "note", content: "a hook note", display: true, timestamp: 1 },
	branchSummary: { role: "branchSummary", summary: "tried the lexer", fromId: "entry-1", timestamp: 1 },
	compactionSummary: {
		role: "compactionSummary",
		summary: "earlier work",
		tokensBefore: 10_000,
		providerPayload: PAYLOAD,
		timestamp: 1,
	} as AgentMessage,
	bashExecution: {
		role: "bashExecution",
		command: "ls src",
		output: "parser.ts",
		exitCode: 137,
		signal: 9,
		cancelled: false,
		truncated: true,
		meta: {
			truncation: {
				direction: "tail",
				truncatedBy: "lines",
				totalLines: 900,
				totalBytes: 9000,
				outputLines: 100,
				outputBytes: 1000,
				artifactId: "7",
			},
			source: { type: "path", value: "out.txt" },
			diagnostics: { summary: "1 error", messages: ["parser.ts:1 unexpected token"] },
			limits: { matchLimit: { reached: 100, suggestion: 200 } },
		},
		excludeFromContext: false,
		timestamp: 1,
	},
	pythonExecution: {
		role: "pythonExecution",
		code: "print(1)",
		output: "1",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		meta: { source: { type: "path", value: "out.txt" }, limits: { headLimit: { reached: 10, suggestion: 20 } } },
		excludeFromContext: false,
		timestamp: 1,
	},
	fileMention: {
		role: "fileMention",
		files: [{ path: "notes.md", content: "todo", image: { type: "image", data: "AAAA", mimeType: "image/png" } }],
		timestamp: 1,
	} as AgentMessage,
};

/** The assistant of the Responses family, whose reasoning the provider replays from its own state. */
const RESPONSES_ASSISTANT = { ...SAMPLES.assistant, api: "openai-responses" } as AgentMessage;

/**
 * Wire changes the projection does not report, by `<role>.<path>`. Every entry is one decision: a
 * Responses-family assistant turn is replayed from the provider's own item chain, and loading a
 * session sanitizes the item metadata that chain minted (reasoning, signatures, the custom-tool wire
 * name, the history payload). A reload that compared that metadata would reset the live chain on
 * every load that sanitized a stale copy, which the startup-sanitization reload test forbids.
 */
const REPLAY_EXEMPT = [
	"assistant(openai-responses).content.0.thinking",
	"assistant(openai-responses).content.0.thinkingSignature",
	"assistant(openai-responses).content.2.thoughtSignature",
	"assistant(openai-responses).content.2.customWireName",
	"assistant(openai-responses).providerPayload.type",
	"assistant(openai-responses).providerPayload.provider",
	"assistant(openai-responses).providerPayload.items.0.type",
	"assistant(openai-responses).providerPayload.items.0.id",
];

type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };

/** Every leaf path of `value`, skipping `role` (which selects the sample, not a field of it). */
function leafPaths(value: Json, prefix: string[] = []): string[][] {
	if (Array.isArray(value)) return value.flatMap((item, i) => leafPaths(item, [...prefix, String(i)]));
	if (value !== null && typeof value === "object") {
		return Object.entries(value).flatMap(([key, item]) =>
			prefix.length === 0 && key === "role" ? [] : leafPaths(item, [...prefix, key]),
		);
	}
	return [prefix];
}

function withLeafChanged(message: AgentMessage, leaf: string[]): AgentMessage {
	const copy = structuredClone(message) as unknown as Record<string, Json>;
	let parent = copy as Json;
	for (const key of leaf.slice(0, -1)) parent = (parent as Record<string, Json>)[key];
	const last = leaf[leaf.length - 1]!;
	const holder = parent as Record<string, Json>;
	const current = holder[last];
	holder[last] =
		typeof current === "string"
			? `${current} (edited)`
			: typeof current === "number"
				? current + 1
				: typeof current === "boolean"
					? !current
					: "edited";
	return copy as unknown as AgentMessage;
}

/**
 * The request `message` produces, minus the bookkeeping `Message` declares beside its payload: the
 * timestamp, the usage an assistant turn reports, and the rewrite and prune marks, which order
 * messages against each other and are derived from timestamps.
 */
function wire(message: AgentMessage): unknown {
	return convertToLlm([message]).map(sent => ({
		...sent,
		timestamp: undefined,
		usage: undefined,
		historyRewriteAt: undefined,
		prunedAt: undefined,
	}));
}

function sweep(label: string, message: AgentMessage): { unreported: string[]; reportedWithoutWireChange: string[] } {
	const unreported: string[] = [];
	const reportedWithoutWireChange: string[] = [];
	for (const leaf of leafPaths(message as unknown as Json)) {
		const edited = withLeafChanged(message, leaf);
		const wireChanged = !Bun.deepEquals(wire(message), wire(edited));
		const reported = didSessionMessagesChange([message], [edited]);
		const name = `${label}.${leaf.join(".")}`;
		if (wireChanged && !reported) unreported.push(name);
		if (!wireChanged && reported && leaf[0] === "timestamp") reportedWithoutWireChange.push(name);
	}
	return { unreported, reportedWithoutWireChange };
}

describe("a reload resets provider state when the request it replays changes", () => {
	const cases: Array<[string, AgentMessage]> = [
		...(Object.entries(SAMPLES) as Array<[string, AgentMessage]>),
		["assistant(openai-responses)", RESPONSES_ASSISTANT],
	];

	it("reports every field edit that changes the request, except the pinned exemptions", () => {
		const unreported = cases.flatMap(([label, message]) => sweep(label, message).unreported);
		expect(unreported).toEqual(REPLAY_EXEMPT);
	});

	it("does not report a timestamp-only edit on any role", () => {
		const spurious = cases.flatMap(([label, message]) => sweep(label, message).reportedWithoutWireChange);
		expect(spurious).toEqual([]);
		for (const [, message] of cases) {
			const later = { ...message, timestamp: message.timestamp + 10_000 } as AgentMessage;
			expect(didSessionMessagesChange([message], [later])).toBe(false);
		}
	});

	it("does not report usage on an assistant turn", () => {
		const recounted = { ...SAMPLES.assistant, usage: { ...USAGE, output: 99 } } as AgentMessage;
		expect(didSessionMessagesChange([SAMPLES.assistant], [recounted])).toBe(false);
	});

	it("reports a list that gained or lost a message", () => {
		expect(didSessionMessagesChange([SAMPLES.user], [SAMPLES.user, SAMPLES.developer])).toBe(true);
		expect(didSessionMessagesChange([SAMPLES.user, SAMPLES.developer], [SAMPLES.user])).toBe(true);
	});

	it("compares reparsed copies by content, not identity", () => {
		const all = Object.values(SAMPLES);
		expect(didSessionMessagesChange(all, structuredClone(all))).toBe(false);
	});
});
