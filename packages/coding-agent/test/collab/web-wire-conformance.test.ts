/**
 * The rich session types the host SENDS are assignable to the wire shapes the guest PARSES.
 *
 * WHY THIS SUITE EXISTS. `@veyyon/wire` is a dependency-free package holding the JSON skeleton of the
 * collab protocol, so a browser or test client can read a live session without depending on the
 * coding-agent runtime. Its module header has always claimed "conformance is asserted type-only in
 * `packages/coding-agent/test/collab/web-wire.types.ts`". That file did not exist. Nothing checked the
 * claim, and nothing checked the conformance.
 *
 * The gap is not theoretical, because the two sides are wired in only ONE direction. `protocol.ts`
 * imports wire's frame grammar, so a change to a FRAME is caught by the compiler. What travels inside
 * a frame does not go through wire at all: the host serializes its own rich `SessionEntry` and
 * `SessionHeader` from `src/session/session-entries.ts`, and the guest casts the JSON to wire's
 * narrower versions of the same names. Rename a field on the host's `CompactionEntry` and the compiler
 * is satisfied on both sides while the guest silently reads `undefined` — a transcript that renders
 * with a piece missing and no error anywhere.
 *
 * So the assertions here are per VARIANT, in the direction that matters: for each entry wire models,
 * the host's entry of the same `type` must be assignable TO the wire type. Whole-union assignability is
 * deliberately not asserted and would be wrong to assert — wire models six entry variants of the
 * host's twenty-odd, on purpose, and its header says consumers keep a tolerant `default:` branch for
 * the rest. Extra fields on the host side are fine; a missing or retyped field is not, and that is
 * exactly what an assignability check catches.
 *
 * These are compile-time assertions, so this file failing looks like `bun run check:ts` failing rather
 * than a red test. The runtime tests at the bottom are the part `bun test` can see: they prove the
 * assertions are actually reachable code and pin the two constants both sides share.
 */

import { describe, expect, it } from "bun:test";
import type { AssistantMessage, DeveloperMessage, ToolResultMessage, UserMessage } from "@veyyon/ai";
import { COLLAB_PROMPT_MESSAGE_TYPE, COLLAB_PROTO } from "@veyyon/coding-agent/collab/protocol";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomMessageEntry,
	ModelChangeEntry,
	SessionHeader,
	SessionMessageEntry,
	ThinkingLevelChangeEntry,
} from "@veyyon/coding-agent/session/session-entries";
import type {
	AssistantMessage as WireAssistantMessage,
	BranchSummaryEntry as WireBranchSummaryEntry,
	CompactionEntry as WireCompactionEntry,
	CustomMessageEntry as WireCustomMessageEntry,
	DeveloperMessage as WireDeveloperMessage,
	MessageEntry as WireMessageEntry,
	ModelChangeEntry as WireModelChangeEntry,
	SessionHeader as WireSessionHeader,
	ThinkingLevelChangeEntry as WireThinkingLevelChangeEntry,
	ToolResultMessage as WireToolResultMessage,
	UserMessage as WireUserMessage,
} from "@veyyon/wire";
import { COLLAB_PROMPT_MESSAGE_TYPE as WIRE_PROMPT_TYPE, COLLAB_PROTO as WIRE_PROTO } from "@veyyon/wire";

/**
 * Compile-time assertion that `Host` can be sent where `Wire` is expected.
 *
 * Written as a conditional type rather than a plain assignment so the failure message names the pair:
 * an assignment would report a mismatch on an anonymous value, while this reports which entry type
 * stopped conforming.
 */
type SendsAs<Host extends Wire, Wire> = Host;

// One line per entry variant `@veyyon/wire` models. A host-side rename, a widened field type, or a
// required field going missing turns the corresponding line into a type error.
type HeaderConforms = SendsAs<SessionHeader, WireSessionHeader>;
// `message` is checked per ROLE below, not here. The host's `AgentMessage` includes seven custom
// roles wire does not model (`bashExecution`, `pythonExecution`, `custom`, `hookMessage`,
// `branchSummary`, `compactionSummary`, `fileMention`, contributed by declaration merging in
// `src/session/messages.ts`), which is deliberate for the same reason wire models six entry variants
// of the host's twenty-odd. Asserting the whole union would demand wire grow a case for every custom
// message role a future extension adds, which is the opposite of what a dependency-free client wants.
type MessageEntryEnvelopeConforms = SendsAs<Omit<SessionMessageEntry, "message">, Omit<WireMessageEntry, "message">>;

// The four roles wire DOES model. A host-side rename or retype on any of these is a field the guest
// silently reads as `undefined`, which is precisely the drift this file exists to catch.
type UserMessageConforms = SendsAs<UserMessage, WireUserMessage>;
type DeveloperMessageConforms = SendsAs<DeveloperMessage, WireDeveloperMessage>;
type AssistantMessageConforms = SendsAs<AssistantMessage, WireAssistantMessage>;
type ToolResultMessageConforms = SendsAs<ToolResultMessage, WireToolResultMessage>;
type CustomMessageConforms = SendsAs<CustomMessageEntry, WireCustomMessageEntry>;
type CompactionConforms = SendsAs<CompactionEntry, WireCompactionEntry>;
type BranchSummaryConforms = SendsAs<BranchSummaryEntry, WireBranchSummaryEntry>;
type ModelChangeConforms = SendsAs<ModelChangeEntry, WireModelChangeEntry>;
type ThinkingLevelConforms = SendsAs<ThinkingLevelChangeEntry, WireThinkingLevelChangeEntry>;

/**
 * Values of each conforming type, so the aliases above are USED.
 *
 * A type alias nothing references is checked but easy to delete by accident, and an unused-symbol
 * cleanup would take the whole contract with it. Naming them in real values ties them to code.
 */
const conformingHeader: HeaderConforms = {
	type: "session",
	id: "s1",
	timestamp: "2026-07-25T00:00:00.000Z",
	cwd: "/tmp/project",
};

const conformingMessageEnvelope: MessageEntryEnvelopeConforms = {
	type: "message",
	id: "e1",
	parentId: null,
	timestamp: "2026-07-25T00:00:00.000Z",
};

const conformingUserMessage: UserMessageConforms = { role: "user", content: "hello", timestamp: 0 };

const conformingDeveloperMessage: DeveloperMessageConforms = {
	role: "developer",
	content: "system note",
	timestamp: 0,
};

const conformingAssistantMessage: AssistantMessageConforms = {
	role: "assistant",
	content: [{ type: "text", text: "hi" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-fable-5",
	stopReason: "stop",
	timestamp: 0,
	usage: {
		input: 10,
		output: 20,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 30,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

const conformingToolResultMessage: ToolResultMessageConforms = {
	role: "toolResult",
	toolCallId: "call-1",
	toolName: "read",
	content: [{ type: "text", text: "file body" }],
	isError: false,
	timestamp: 0,
};

const conformingMessage = { ...conformingMessageEnvelope, message: conformingUserMessage };

const conformingCustomMessage: CustomMessageConforms = {
	type: "custom_message",
	id: "e2",
	parentId: "e1",
	timestamp: "2026-07-25T00:00:00.000Z",
	customType: COLLAB_PROMPT_MESSAGE_TYPE,
	content: "from a guest",
	display: true,
};

const conformingCompaction: CompactionConforms = {
	type: "compaction",
	id: "e3",
	parentId: "e2",
	timestamp: "2026-07-25T00:00:00.000Z",
	summary: "long summary",
	firstKeptEntryId: "e2",
	tokensBefore: 12_345,
};

const conformingBranchSummary: BranchSummaryConforms = {
	type: "branch_summary",
	id: "e4",
	parentId: "e3",
	timestamp: "2026-07-25T00:00:00.000Z",
	fromId: "e2",
	summary: "branch summary",
};

const conformingModelChange: ModelChangeConforms = {
	type: "model_change",
	id: "e5",
	parentId: "e4",
	timestamp: "2026-07-25T00:00:00.000Z",
	model: "anthropic/claude-fable-5",
};

const conformingThinkingLevel: ThinkingLevelConforms = {
	type: "thinking_level_change",
	id: "e6",
	parentId: "e5",
	timestamp: "2026-07-25T00:00:00.000Z",
	thinkingLevel: "high",
};

describe("host session entries as the guest reads them", () => {
	it("carries every field the wire type requires, for each modelled variant", () => {
		// The runtime half. The compile-time assertions above are the contract; this proves the
		// values satisfying them are real objects with the fields a guest reads, so the file
		// cannot pass by being unreachable or by declaring types nothing constructs.
		const wireMessage: WireMessageEntry = { ...conformingMessageEnvelope, message: conformingUserMessage };
		expect(wireMessage.message.role).toBe("user");

		const wireHeader: WireSessionHeader = conformingHeader;
		expect(wireHeader.type).toBe("session");
		expect(wireHeader.cwd).toBe("/tmp/project");

		const entries = [
			conformingMessage,
			conformingCustomMessage,
			conformingCompaction,
			conformingBranchSummary,
			conformingModelChange,
			conformingThinkingLevel,
		];
		expect(entries.map(entry => entry.type)).toEqual([
			"message",
			"custom_message",
			"compaction",
			"branch_summary",
			"model_change",
			"thinking_level_change",
		]);
		// Every entry a guest renders is placed in the transcript tree by these three fields, so
		// their presence is the minimum the cast at the JSON boundary depends on.
		for (const entry of entries) {
			expect(typeof entry.id).toBe("string");
			expect(typeof entry.timestamp).toBe("string");
			expect(entry).toHaveProperty("parentId");
		}
	});

	it("keeps the required fields of the two entries with the most host-side extras", () => {
		// `CompactionEntry` and `CustomMessageEntry` carry the most host-only fields (`details`,
		// `preserveData`, `fromExtension`, `attribution`), which is where a host-side edit is most
		// likely to disturb a field the guest needs.
		const compaction: WireCompactionEntry = conformingCompaction;
		expect(compaction.summary).toBe("long summary");
		expect(compaction.firstKeptEntryId).toBe("e2");
		expect(compaction.tokensBefore).toBe(12_345);

		const custom: WireCustomMessageEntry = conformingCustomMessage;
		expect(custom.customType).toBe("collab-prompt");
		expect(custom.display).toBe(true);
	});
});

describe("the four message roles the guest renders", () => {
	it("accepts each host message where the wire role is expected", async () => {
		// One assignment per role, so a break names the role rather than "the union". The
		// assistant case is the one with history: an Anthropic fallback marker
		// (`{ type: "fallback" }`) reaches guests on turns that opted into provider fallbacks, and
		// wire's `AssistantContent` did not admit it until this file was written.
		const user: WireUserMessage = conformingUserMessage;
		const developer: WireDeveloperMessage = conformingDeveloperMessage;
		const assistant: WireAssistantMessage = conformingAssistantMessage;
		const toolResult: WireToolResultMessage = conformingToolResultMessage;

		expect([user.role, developer.role, assistant.role, toolResult.role]).toEqual([
			"user",
			"developer",
			"assistant",
			"toolResult",
		]);
		expect(assistant.model).toBe("claude-fable-5");
		expect(toolResult.toolName).toBe("read");
	});

	it("accepts an assistant turn carrying the provider-fallback marker", async () => {
		// The regression the conformance check found. The block was already on the wire; the type
		// denied it, so a client with an exhaustive switch had no case for it and a client written
		// from the type had no idea it could arrive.
		const withFallback: WireAssistantMessage = {
			...conformingAssistantMessage,
			content: [
				{ type: "text", text: "starting" },
				{ type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-5" } },
				{ type: "text", text: "continuing" },
			],
		};

		expect(withFallback.content.map(block => block.type)).toEqual(["text", "fallback", "text"]);
	});
});

describe("the constants both sides read", () => {
	it("re-exports the wire protocol version rather than declaring a second one", () => {
		// `protocol.ts` re-exports these from wire, so they cannot drift today. Pinned anyway,
		// because a future edit that redeclares either one locally would be invisible: both sides
		// would still compile and a guest on the old number would be refused with no clue why.
		expect(COLLAB_PROTO).toBe(WIRE_PROTO);
		expect(COLLAB_PROMPT_MESSAGE_TYPE).toBe(WIRE_PROMPT_TYPE);
	});

	it("names the protocol version the guest client expects", () => {
		expect(COLLAB_PROTO).toBe(3);
		expect(COLLAB_PROMPT_MESSAGE_TYPE).toBe("collab-prompt");
	});
});
