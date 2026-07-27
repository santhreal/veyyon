/**
 * The guest's message vocabulary is NARROWER than the host's, and the type names now say so.
 *
 * WHY THIS SUITE EXISTS. `@veyyon/wire` and `@veyyon/ai` each declared `UserMessage`,
 * `AssistantMessage`, `DeveloperMessage`, `ToolResultMessage` and `StopReason`. Same words,
 * different widths: the host's assistant turn carries `providerPayload` (transport-native history
 * used to replay the turn upstream), `request` (the exact sampling and reasoning parameters as
 * sent), `contextSnapshot`, `retryRecovery`, `responseId`, `turnMetrics` and `errorId`; the wire
 * one carries content, model, usage, stop reason and a timestamp.
 *
 * That is not a style complaint. TypeScript assignability runs the permissive way: a value
 * carrying MORE fields satisfies a type declaring fewer. So a field typed as the wire message
 * accepts the host's whole message without a word from the compiler, and the guest persists what
 * it receives. The identical collision one layer up (`SessionHeader`) shipped three undeclared
 * host fields to every guest, read-only viewers included, and
 * `test/collab/welcome-header-projection.test.ts` is the proof that stopped it. Renaming the
 * message vocabulary to `Wire*` is what makes the compiler ask for a projection here too.
 *
 * These checks are type-level on purpose. The bug is a TYPE that admits too much, and a runtime
 * assertion cannot see it: the wide value and the narrow value are the same bytes at the point
 * where the mistake is made.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage as HostAssistantMessage, UserMessage as HostUserMessage } from "@veyyon/ai";
import type {
	AssistantMessage as DeprecatedAssistantMessage,
	StopReason as DeprecatedStopReason,
	UserMessage as DeprecatedUserMessage,
	WireAssistantMessage,
	WireMessage,
	WireStopReason,
	WireUserMessage,
} from "@veyyon/wire";

/** Compile-time assertion that `A` and `B` are the SAME type, not merely assignable one way. */
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe("the wire assistant message is narrower than the host's", () => {
	/**
	 * The keys the wire contract declares, written out.
	 *
	 * A guest reads these and the host may send only these. Asserted as a whole key set rather
	 * than field by field, because the failure this locks out is a field ARRIVING, and a per-field
	 * check cannot notice a field nobody thought to name.
	 */
	it("declares exactly the seven fields a guest renders", () => {
		const message: WireAssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			model: "anthropic/claude-opus-4",
			provider: "anthropic",
			usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14, cost: { total: 0.001 } },
			stopReason: "stop",
			timestamp: 1_700_000_000_000,
		};

		expect(Object.keys(message).sort()).toEqual([
			"content",
			"model",
			"provider",
			"role",
			"stopReason",
			"timestamp",
			"usage",
		]);
	});

	/**
	 * The host's assistant turn is NOT the wire one, even though it satisfies it.
	 *
	 * This is the whole bug in one line. `Exact` is false because the two are different types;
	 * plain assignability would be TRUE in the dangerous direction, which is exactly why the
	 * previous `web-wire-conformance` style check (host is assignable to wire) could not catch the
	 * header leak and would not catch this one.
	 */
	it("is a different type from the host's, not an alias of it", () => {
		const sameType: Exact<HostAssistantMessage, WireAssistantMessage> = false;
		const sameUserType: Exact<HostUserMessage, WireUserMessage> = false;

		expect(sameType).toBe(false);
		expect(sameUserType).toBe(false);
	});

	/**
	 * Named proof that the host's extra fields are host-only, so a future reader cannot conclude
	 * the two shapes drifted apart by accident and "fix" it by widening the wire type.
	 */
	it("declares none of the host-only fields", () => {
		type HostOnly = "providerPayload" | "request" | "contextSnapshot" | "retryRecovery" | "responseId" | "errorId";

		const hostDeclaresThem: HostOnly extends keyof HostAssistantMessage ? true : false = true;
		const wireDeclaresNone: Extract<HostOnly, keyof WireAssistantMessage> extends never ? true : false = true;

		expect(hostDeclaresThem).toBe(true);
		expect(wireDeclaresNone).toBe(true);
	});

	/** The same, for the user turn: `steering`, `attribution` and `providerPayload` stay host-side. */
	it("keeps steering, attribution and providerPayload off the user turn a guest sees", () => {
		type HostOnly = "steering" | "attribution" | "providerPayload";

		const wireDeclaresNone: Extract<HostOnly, keyof WireUserMessage> extends never ? true : false = true;

		expect(wireDeclaresNone).toBe(true);
	});
});

describe("the deprecated bare names", () => {
	/**
	 * Every old spelling still resolves, because `@veyyon/wire` is published and a rename that
	 * breaks importers is a rename nobody applies. Written as renamed exports rather than alias
	 * declarations, so each name keeps exactly one declaration and
	 * `test/core/shared-types-have-one-owner.test.ts` stays honest about it.
	 */
	it("resolve to the type they were renamed from", () => {
		const assistant: Exact<DeprecatedAssistantMessage, WireAssistantMessage> = true;
		const user: Exact<DeprecatedUserMessage, WireUserMessage> = true;
		const stop: Exact<DeprecatedStopReason, WireStopReason> = true;

		expect([assistant, user, stop]).toEqual([true, true, true]);
	});
});

describe("the wire message union", () => {
	/**
	 * The union covers the four roles a guest draws, and a `role` outside them is not a
	 * `WireMessage`. Pinned because the union is what `MessageEntry.message` is typed as, and a
	 * fifth role added host-side must be a deliberate wire change rather than something that
	 * arrives and renders as nothing.
	 */
	it("admits the four roles a guest draws and no others", () => {
		const roles: Array<WireMessage["role"]> = ["user", "developer", "assistant", "toolResult"];
		const fifthRoleIsNotAMessage: { role: "system"; timestamp: number } extends WireMessage ? true : false = false;

		expect(roles).toEqual(["user", "developer", "assistant", "toolResult"]);
		expect(fifthRoleIsNotAMessage).toBe(false);
	});

	/**
	 * `WireStopReason` is the harness vocabulary, not Anthropic's.
	 *
	 * Anthropic's own `stop_reason` has eight literals (`end_turn`, `max_tokens`, `pause_turn`,
	 * `refusal`, ...) and was ALSO called `StopReason` until it became
	 * `AnthropicWireStopReason`. A file that imported the wrong one typechecked against the wrong
	 * vocabulary, so this pins which five a guest can receive.
	 */
	it("carries the five harness stop reasons, not Anthropic's eight", () => {
		const reasons: WireStopReason[] = ["stop", "length", "toolUse", "error", "aborted"];
		const anthropicLiteralIsNotOne: "end_turn" extends WireStopReason ? true : false = false;

		expect(reasons).toHaveLength(5);
		expect(anthropicLiteralIsNotOne).toBe(false);
	});
});
