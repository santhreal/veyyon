import { describe, expect, it } from "bun:test";
import {
	convertMessages,
	elidedSignatureBytes,
	firstRetainedAssistantIndex,
	sendsSignature,
	signaturePolicy,
} from "@veyyon/ai/providers/google-shared";
import type { AssistantMessage, Message, Model, ToolCall } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

/**
 * Regression suite for thought-signature retention.
 *
 * WHY THIS SUITE EXISTS. Gemini attaches an opaque `thoughtSignature` to every
 * function call, and `convertMessages` used to re-upload every historical one on
 * every request with no age bound. Measured over nine live sessions those blobs
 * were 40.2% of the entire conversation body, more than the tool results, the
 * tool arguments, the thinking, and the model's own text combined: 1,295
 * signatures averaging 2,239 characters, the largest 71,636 on its own. A
 * signature written on turn 3 was still being paid for on turn 60.
 *
 * Retention bounds that. The last N assistant turns send their signature
 * verbatim; older calls send Google's `skip_thought_signature_validator`
 * sentinel, which is what the API accepts for a call that has no signature.
 *
 * Two things must never regress, and both are asserted here. The default must
 * stay "send everything", because trimming reasoning context is a behaviour
 * change no caller opted into. And the sentinel must only be substituted where
 * the provider accepts it: on a pre-Gemini-3 model the part carries no
 * `thoughtSignature` key at all, exactly as it does for a call that never had
 * one.
 */

const SKIP = "skip_thought_signature_validator";

/** A real signature is base64 and long. `resolveThoughtSignature` rejects anything else, so fixtures must be valid. */
function signature(seed: string, quads: number): string {
	return seed.padEnd(4, "A").slice(0, 4).repeat(quads);
}

const gemini3: Model<"google-generative-ai"> = buildModel({
	id: "gemini-3-pro-preview",
	name: "Gemini 3 Pro Preview",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const gemini2: Model<"google-generative-ai"> = buildModel({
	...gemini3,
	id: "gemini-2.5-pro",
	name: "Gemini 2.5 Pro",
});

function toolCall(id: string, sig: string | undefined): ToolCall {
	return {
		type: "toolCall",
		id,
		name: "read",
		arguments: { path: `${id}.ts` },
		...(sig && { thoughtSignature: sig }),
	};
}

function assistant(model: Model<"google-generative-ai">, ...content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		stopReason: "toolUse",
	} as AssistantMessage;
}

/** One assistant turn plus its tool result, which is the unit a retention window counts. */
function turn(model: Model<"google-generative-ai">, id: string, sig: string): Message[] {
	return [
		assistant(model, toolCall(id, sig)),
		{ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "ok" }] } as Message,
	];
}

/** Every `functionCall` part's signature, in wire order, `undefined` when the key is absent. */
function emittedSignatures(
	model: Model<"google-generative-ai">,
	messages: Message[],
	retention: number | undefined,
): (string | undefined)[] {
	return convertMessages(model, { messages, thoughtSignatureRetention: retention })
		.flatMap(content => content.parts ?? [])
		.filter(part => part.functionCall)
		.map(part => part.thoughtSignature);
}

describe("firstRetainedAssistantIndex", () => {
	const messages = [
		{ role: "user", content: "go" },
		assistant(gemini3, toolCall("a", signature("aaaa", 4))),
		{ role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "ok" }] },
		assistant(gemini3, toolCall("b", signature("bbbb", 4))),
		{ role: "toolResult", toolCallId: "b", toolName: "read", content: [{ type: "text", text: "ok" }] },
		assistant(gemini3, toolCall("c", signature("cccc", 4))),
	] as Message[];

	/**
	 * The unset case is the one that must never drift: an undefined window is how
	 * every caller that has not opted in reaches this code, and it has to mean
	 * "change nothing".
	 */
	it("retains everything when no window is configured", () => {
		expect(firstRetainedAssistantIndex(messages, undefined)).toBe(0);
	});

	/** `-1` is the setting's "Keep All" sentinel, so it must resolve the same as unset. */
	it("treats a negative window as retain-everything", () => {
		expect(firstRetainedAssistantIndex(messages, -1)).toBe(0);
		expect(firstRetainedAssistantIndex(messages, -100)).toBe(0);
	});

	/** A NaN or Infinity window must not silently trim the transcript. */
	it("treats a non-finite window as retain-everything", () => {
		expect(firstRetainedAssistantIndex(messages, Number.NaN)).toBe(0);
		expect(firstRetainedAssistantIndex(messages, Number.POSITIVE_INFINITY)).toBe(0);
	});

	/**
	 * The boundary is counted in assistant messages, not in array slots: only
	 * assistants decrement the window. The returned index sits just past the
	 * oldest message that must NOT be retained, so with assistants at 1, 3 and 5 a
	 * window of 1 returns 4: index 5 keeps its signature, indices 3 and 1 do not.
	 */
	it("counts assistant messages and ignores everything between them", () => {
		expect(firstRetainedAssistantIndex(messages, 1)).toBe(4);
		expect(firstRetainedAssistantIndex(messages, 2)).toBe(2);
		expect(firstRetainedAssistantIndex(messages, 3)).toBe(0);
	});

	/** Zero means the current turn is not special either: nothing in the transcript keeps its signature. */
	it("retains nothing at a window of zero", () => {
		expect(firstRetainedAssistantIndex(messages, 0)).toBe(messages.length);
	});

	/** Early in a session the window exceeds the transcript, and that must retain rather than trim. */
	it("retains everything when the window is larger than the transcript", () => {
		expect(firstRetainedAssistantIndex(messages, 9)).toBe(0);
		expect(firstRetainedAssistantIndex([], 4)).toBe(0);
	});

	/** A fractional window comes from a hand-edited config; it must floor, not throw or trim unexpectedly. */
	it("floors a fractional window", () => {
		expect(firstRetainedAssistantIndex(messages, 1.9)).toBe(4);
	});
});

describe("Gemini thought-signature retention on the wire", () => {
	const sigA = signature("aaaa", 8);
	const sigB = signature("bbbb", 8);
	const sigC = signature("cccc", 8);
	const transcript = (model: Model<"google-generative-ai">): Message[] => [
		{ role: "user", content: "go" } as Message,
		...turn(model, "a", sigA),
		...turn(model, "b", sigB),
		...turn(model, "c", sigC),
	];

	/**
	 * The pre-change behaviour, pinned. If this ever starts trimming without an
	 * explicit window, every existing caller silently loses reasoning context.
	 */
	it("sends every signature verbatim when no window is set", () => {
		expect(emittedSignatures(gemini3, transcript(gemini3), undefined)).toEqual([sigA, sigB, sigC]);
	});

	/** Same guarantee through the setting's "Keep All" sentinel rather than through an absent field. */
	it("sends every signature verbatim at the Keep All sentinel", () => {
		expect(emittedSignatures(gemini3, transcript(gemini3), -1)).toEqual([sigA, sigB, sigC]);
	});

	/** The saving case: the newest turn keeps its reasoning, everything older collapses to the sentinel. */
	it("keeps the most recent turn and sentinels the rest", () => {
		expect(emittedSignatures(gemini3, transcript(gemini3), 1)).toEqual([SKIP, SKIP, sigC]);
	});

	/** A wider window keeps proportionally more, which is what the arm sweep varies. */
	it("keeps exactly as many recent turns as the window says", () => {
		expect(emittedSignatures(gemini3, transcript(gemini3), 2)).toEqual([SKIP, sigB, sigC]);
		expect(emittedSignatures(gemini3, transcript(gemini3), 3)).toEqual([sigA, sigB, sigC]);
	});

	/** Zero is a real configuration, not an off switch, and must sentinel the current turn too. */
	it("sentinels every call at a window of zero", () => {
		expect(emittedSignatures(gemini3, transcript(gemini3), 0)).toEqual([SKIP, SKIP, SKIP]);
	});

	/**
	 * The sentinel is a Gemini 3 affordance. On an older model a signature-less
	 * call omits the key entirely, and a trimmed call has to look identical to it,
	 * or the request carries a string the API was never told to expect.
	 */
	it("omits the key instead of sentinelling on a pre-Gemini-3 model", () => {
		expect(emittedSignatures(gemini2, transcript(gemini2), 1)).toEqual([undefined, undefined, sigC]);
	});

	/**
	 * Retention narrows what is sent; it must never widen it. A signature minted
	 * by a different model is dropped today because it cannot be replayed, and a
	 * generous window must not resurrect it.
	 */
	it("still drops a foreign model's signature at the widest window", () => {
		const foreign = assistant(gemini3, toolCall("x", sigA));
		const messages: Message[] = [
			{ role: "user", content: "go" } as Message,
			{ ...foreign, model: "gemini-2.5-flash" } as Message,
			{ role: "toolResult", toolCallId: "x", toolName: "read", content: [{ type: "text", text: "ok" }] } as Message,
		];
		expect(emittedSignatures(gemini3, messages, -1)).toEqual([SKIP]);
		expect(emittedSignatures(gemini3, messages, 0)).toEqual([SKIP]);
	});

	/**
	 * Scope check. Thinking blocks carry their own signature and losing it demotes
	 * the block to plain text, which keeps the same bytes in context while changing
	 * what the model sees. Retention deliberately touches tool calls only, so a
	 * trimmed transcript must still emit the thinking part with `thought: true`.
	 */
	it("leaves thinking-block signatures alone", () => {
		const messages: Message[] = [
			{ role: "user", content: "go" } as Message,
			assistant(
				gemini3,
				{ type: "thinking", thinking: "weighing it up", thinkingSignature: sigA },
				toolCall("a", sigB),
			),
			{ role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "ok" }] } as Message,
			...turn(gemini3, "b", sigC),
		];
		const parts = convertMessages(gemini3, { messages, thoughtSignatureRetention: 1 }).flatMap(c => c.parts ?? []);
		const thinking = parts.find(part => part.thought === true);
		expect(thinking).toBeDefined();
		expect(thinking?.thoughtSignature).toBe(sigA);
		expect(thinking?.text).toBe("weighing it up");
		expect(parts.filter(part => part.functionCall).map(part => part.thoughtSignature)).toEqual([SKIP, sigC]);
	});

	/**
	 * The point of the change, measured rather than asserted by shape. A window of
	 * 1 over a transcript of realistically sized signatures has to remove the bulk
	 * of the payload, not shave a few bytes.
	 */
	it("removes the great majority of the payload on a long transcript", () => {
		const big = signature("Zm9v", 560); // 2,240 characters, the measured mean
		const messages: Message[] = [{ role: "user", content: "go" } as Message];
		for (let index = 0; index < 30; index++) messages.push(...turn(gemini3, `t${index}`, big));

		const full = JSON.stringify(convertMessages(gemini3, { messages, thoughtSignatureRetention: -1 })).length;
		const trimmed = JSON.stringify(convertMessages(gemini3, { messages, thoughtSignatureRetention: 1 })).length;

		expect(full - trimmed).toBe(29 * (big.length - SKIP.length));
		expect(trimmed / full).toBeLessThan(0.2);
	});
});

describe("elidedSignatureBytes", () => {
	const sig = signature("Zm9v", 100); // 400 characters
	const sameModel = () => true;
	const transcript: Message[] = [
		{ role: "user", content: "go" } as Message,
		...turn(gemini3, "a", sig),
		...turn(gemini3, "b", sig),
		...turn(gemini3, "c", sig),
	];
	/** Spelled once so every case below states only the rule it is exercising. */
	const elided = (
		messages: Message[],
		policy: { thoughtSignatureRetention?: number; thoughtSignatureMaxLength?: number },
		same: (m: AssistantMessage) => boolean = sameModel,
	) => elidedSignatureBytes(messages, signaturePolicy(messages, policy), same);

	/**
	 * The counter exists so the operator can see the setting working. When it is
	 * off it must read zero rather than some plausible-looking number, or a
	 * disabled mechanism looks active.
	 */
	it("reports nothing when the window retains everything", () => {
		expect(elided(transcript, {})).toBe(0);
		expect(elided(transcript, { thoughtSignatureRetention: -1 })).toBe(0);
		expect(elided(transcript, { thoughtSignatureRetention: 3 })).toBe(0);
	});

	/**
	 * The figure has to be what was actually removed, signature length minus the
	 * sentinel that replaced it, not the raw signature length. Counting the raw
	 * length would overstate the saving by 33 characters per call.
	 */
	it("counts the signature minus the sentinel that replaced it", () => {
		expect(elided(transcript, { thoughtSignatureRetention: 1 })).toBe(2 * (sig.length - SKIP.length));
		expect(elided(transcript, { thoughtSignatureRetention: 2 })).toBe(sig.length - SKIP.length);
		expect(elided(transcript, { thoughtSignatureRetention: 0 })).toBe(3 * (sig.length - SKIP.length));
	});

	/**
	 * The number must agree with the wire. If the counter and `convertMessages`
	 * ever disagree about what the window elides, the reported saving is fiction,
	 * so this pins them to each other rather than to a hand-computed constant.
	 */
	it("agrees with the payload the converter actually emits", () => {
		const full = JSON.stringify(convertMessages(gemini3, { messages: transcript, thoughtSignatureRetention: -1 }));
		const trimmed = JSON.stringify(convertMessages(gemini3, { messages: transcript, thoughtSignatureRetention: 1 }));
		expect(full.length - trimmed.length).toBe(elided(transcript, { thoughtSignatureRetention: 1 }));
	});

	/**
	 * A signature from another model is already dropped before the window is
	 * consulted, so the window did not save those bytes and must not claim them.
	 */
	it("does not claim bytes that were never going to be sent", () => {
		expect(elided(transcript, { thoughtSignatureRetention: 0 }, () => false)).toBe(0);
	});

	/**
	 * A malformed signature is rejected by `resolveThoughtSignature` and never
	 * reaches the wire, so trimming it saves nothing.
	 */
	it("ignores a signature that is not valid base64", () => {
		const messages: Message[] = [
			{ role: "user", content: "go" } as Message,
			...turn(gemini3, "a", "not base64!!"),
			...turn(gemini3, "b", sig),
		];
		expect(elided(messages, { thoughtSignatureRetention: 1 })).toBe(0);
	});
});

/**
 * The size rule, which is a different lever from the recency window and not a
 * variation on it.
 *
 * WHY IT EXISTS. Signature bytes are extremely lopsided. Across twenty measured
 * DeepSWE sessions, 2,297 signatures averaged 2,606 characters against a median of
 * 660, with a maximum of 91,960, and the largest tenth of them carried 62.1% of
 * all signature bytes. A recency window sheds nearly all of the mass by shedding
 * nearly all of the chain. A length cap sheds most of the mass while leaving the
 * great majority of the chain intact, so if replaying older reasoning turns out to
 * matter, the cap degrades gently where the window does not.
 *
 * Because they are independent settings they can be measured as separate arms,
 * which is the only way to attribute a reward change to one of them. These tests
 * pin that independence: each rule works alone, and together they intersect rather
 * than override.
 */
describe("Gemini thought-signature size limit on the wire", () => {
	const small = signature("aaaa", 10); // 40 characters
	const large = signature("bbbb", 500); // 2000 characters
	const transcript: Message[] = [
		{ role: "user", content: "go" } as Message,
		...turn(gemini3, "a", large),
		...turn(gemini3, "b", small),
		...turn(gemini3, "c", large),
	];
	const emitted = (context: { thoughtSignatureRetention?: number; thoughtSignatureMaxLength?: number }) =>
		convertMessages(gemini3, { messages: transcript, ...context })
			.flatMap(content => content.parts ?? [])
			.filter(part => part.functionCall)
			.map(part => part.thoughtSignature);

	/**
	 * The default must stay "send everything". A size limit that engaged without
	 * being asked for would be a silent behaviour change for every existing caller,
	 * which is the same standard the recency window is held to.
	 */
	it("sends every signature when no limit is set", () => {
		expect(emitted({})).toEqual([large, small, large]);
		expect(emitted({ thoughtSignatureMaxLength: -1 })).toEqual([large, small, large]);
		expect(emitted({ thoughtSignatureMaxLength: 0 })).toEqual([large, small, large]);
	});

	/**
	 * THE POINT OF THE LEVER, and the behaviour that distinguishes it from the
	 * recency window: the oversized signatures collapse to the sentinel at ANY age,
	 * including the newest turn, while the small one survives untouched. A window
	 * would have kept the newest large signature and dropped the older small one,
	 * which is the opposite selection.
	 */
	it("drops oversized signatures at any age and keeps small ones", () => {
		expect(emitted({ thoughtSignatureMaxLength: 100 })).toEqual([SKIP, small, SKIP]);
	});

	/**
	 * The boundary is inclusive: a signature exactly at the limit is still worth
	 * sending. An off-by-one here would silently shed a whole extra bucket of
	 * signatures, and the setting's options are round numbers chosen against a
	 * measured distribution, so the edge is a real case rather than a pedantic one.
	 */
	it("keeps a signature exactly at the limit and drops one character longer", () => {
		expect(emitted({ thoughtSignatureMaxLength: large.length })).toEqual([large, small, large]);
		expect(emitted({ thoughtSignatureMaxLength: large.length - 1 })).toEqual([SKIP, small, SKIP]);
	});

	/**
	 * The two rules INTERSECT rather than override. A signature is sent only if it
	 * is both recent enough and small enough, so combining a window of 1 with a
	 * tight cap leaves nothing: the newest signature is large and the small one is
	 * too old. If either rule silently won outright, one of the two arms would
	 * measure the wrong thing.
	 */
	it("composes with the recency window instead of overriding it", () => {
		expect(emitted({ thoughtSignatureRetention: 1 })).toEqual([SKIP, SKIP, large]);
		expect(emitted({ thoughtSignatureMaxLength: 100 })).toEqual([SKIP, small, SKIP]);
		expect(emitted({ thoughtSignatureRetention: 1, thoughtSignatureMaxLength: 100 })).toEqual([SKIP, SKIP, SKIP]);
	});

	/**
	 * A fractional limit comes from a hand-edited config and must floor rather than
	 * throw or compare against a fraction. 40.5 floors to 40, and the 40-character
	 * signature is at the limit, so it survives.
	 */
	it("floors a fractional limit", () => {
		expect(emitted({ thoughtSignatureMaxLength: 40.9 })).toEqual([SKIP, small, SKIP]);
		expect(emitted({ thoughtSignatureMaxLength: 39.9 })).toEqual([SKIP, SKIP, SKIP]);
	});

	/**
	 * THE MOST DANGEROUS DEFAULT. Settings store unset numeric knobs as -1, and a
	 * literal reading of that as a length would strip every signature in the
	 * conversation the moment the setting shipped. Non-positive means no limit, and
	 * that is asserted at the policy level as well as on the wire because this is
	 * the failure that would be attributed to the model rather than to the config.
	 */
	it("reads a non-positive limit as no limit, never as elide-everything", () => {
		expect(signaturePolicy(transcript, { thoughtSignatureMaxLength: -1 }).maxLength).toBeUndefined();
		expect(signaturePolicy(transcript, { thoughtSignatureMaxLength: 0 }).maxLength).toBeUndefined();
		expect(signaturePolicy(transcript, { thoughtSignatureMaxLength: Number.NaN }).maxLength).toBeUndefined();
		expect(signaturePolicy(transcript, {}).maxLength).toBeUndefined();
	});

	/**
	 * The byte counter has to know about BOTH rules or it reports a saving the
	 * request did not make. This pins it against the wire rather than against a
	 * hand-computed constant, which is the same standard the window's counter is
	 * held to, because a counter that agrees with arithmetic but not with the
	 * payload is the quiet kind of wrong.
	 */
	it("accounts for size-elided bytes and agrees with the payload", () => {
		const full = JSON.stringify(convertMessages(gemini3, { messages: transcript }));
		const capped = JSON.stringify(convertMessages(gemini3, { messages: transcript, thoughtSignatureMaxLength: 100 }));
		const counted = elidedSignatureBytes(
			transcript,
			signaturePolicy(transcript, { thoughtSignatureMaxLength: 100 }),
			() => true,
		);
		expect(counted).toBe(2 * (large.length - SKIP.length));
		expect(full.length - capped.length).toBe(counted);
	});
});

describe("sendsSignature — the one place both rules are applied", () => {
	const policy = (retainFrom: number, maxLength: number | undefined) => ({ retainFrom, maxLength });

	/** With no rules in force, every signature is sent whatever its index or size. */
	it("sends everything when neither rule is set", () => {
		expect(sendsSignature(policy(0, undefined), 0, "x".repeat(100_000))).toBe(true);
	});

	/** The recency rule alone, at its boundary: the retained index is kept, one earlier is not. */
	it("applies the recency boundary inclusively at retainFrom", () => {
		expect(sendsSignature(policy(4, undefined), 4, "x")).toBe(true);
		expect(sendsSignature(policy(4, undefined), 3, "x")).toBe(false);
	});

	/** The size rule alone, at its boundary: equal to the limit is kept, one over is not. */
	it("applies the size boundary inclusively at maxLength", () => {
		expect(sendsSignature(policy(0, 10), 0, "x".repeat(10))).toBe(true);
		expect(sendsSignature(policy(0, 10), 0, "x".repeat(11))).toBe(false);
	});

	/**
	 * Either rule alone is enough to elide. This is the AND that keeps the two arms
	 * independent, and asserting all four combinations is what stops a refactor from
	 * turning it into an OR without failing anything.
	 */
	it("elides when either rule rejects, and sends only when both accept", () => {
		expect(sendsSignature(policy(4, 10), 4, "x".repeat(10))).toBe(true);
		expect(sendsSignature(policy(4, 10), 3, "x".repeat(10))).toBe(false);
		expect(sendsSignature(policy(4, 10), 4, "x".repeat(11))).toBe(false);
		expect(sendsSignature(policy(4, 10), 3, "x".repeat(11))).toBe(false);
	});
});

describe("Gemini thinking retention on the wire", () => {
	const sig = signature("Zm9v", 8);

	/** An assistant turn whose thinking block is unsigned, which is every real one. */
	function unsignedThinkingTurn(id: string, thought: string): Message[] {
		return [
			assistant(gemini3, { type: "thinking", thinking: thought }, toolCall(id, sig)),
			{ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "ok" }] } as Message,
		];
	}

	const transcript: Message[] = [
		{ role: "user", content: "go" } as Message,
		...unsignedThinkingTurn("a", "first thought"),
		...unsignedThinkingTurn("b", "second thought"),
		...unsignedThinkingTurn("c", "third thought"),
	];

	/** Every non-thought text part on the wire, which is where a demoted thinking block lands. */
	function emittedTexts(messages: Message[], thinkingRetention: number | undefined): string[] {
		return convertMessages(gemini3, { messages, thinkingRetention })
			.flatMap(content => content.parts ?? [])
			.filter(part => typeof part.text === "string" && !part.functionCall)
			.map(part => part.text as string);
	}

	/**
	 * The default. Nobody opted into losing their own reasoning from the
	 * transcript, so an unset window has to send all three thoughts exactly as it
	 * did before this existed.
	 */
	it("sends every thinking block when no window is set", () => {
		const texts = emittedTexts(transcript, undefined).join("\n");
		expect(texts).toContain("first thought");
		expect(texts).toContain("second thought");
		expect(texts).toContain("third thought");
	});

	/** The saving case: the newest turn keeps its reasoning, older summaries are dropped outright. */
	it("drops unsigned thinking older than the window", () => {
		const texts = emittedTexts(transcript, 1).join("\n");
		expect(texts).not.toContain("first thought");
		expect(texts).not.toContain("second thought");
		expect(texts).toContain("third thought");
	});

	/** A wider window keeps proportionally more, which is what the sweep varies. */
	it("keeps exactly as many recent turns as the window says", () => {
		const texts = emittedTexts(transcript, 2).join("\n");
		expect(texts).not.toContain("first thought");
		expect(texts).toContain("second thought");
		expect(texts).toContain("third thought");
	});

	/** Zero drops every unsigned summary, including the current turn's. */
	it("drops every unsigned thinking block at a window of zero", () => {
		const texts = emittedTexts(transcript, 0).join("\n");
		for (const thought of ["first thought", "second thought", "third thought"]) {
			expect(texts).not.toContain(thought);
		}
	});

	/**
	 * The safety rule, and the one that must never regress. A SIGNED thinking
	 * block carries reasoning the provider can actually replay, so dropping it
	 * would discard something of value rather than transcript text. The window
	 * governs unsigned blocks only.
	 */
	it("never drops a signed thinking block, whatever the window says", () => {
		const messages: Message[] = [
			{ role: "user", content: "go" } as Message,
			assistant(
				gemini3,
				{ type: "thinking", thinking: "signed reasoning", thinkingSignature: sig },
				toolCall("a", sig),
			),
			{ role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "ok" }] } as Message,
			...unsignedThinkingTurn("b", "unsigned reasoning"),
		];
		const parts = convertMessages(gemini3, { messages, thinkingRetention: 0 }).flatMap(c => c.parts ?? []);
		const thought = parts.find(part => part.thought === true);
		expect(thought?.text).toBe("signed reasoning");
		expect(thought?.thoughtSignature).toBe(sig);
		expect(parts.map(part => part.text ?? "").join("\n")).not.toContain("unsigned reasoning");
	});

	/**
	 * The two windows are separate independent variables and must not be wired to
	 * each other, or a sweep of one silently moves the other and neither result
	 * means anything.
	 */
	it("is independent of the thought-signature window", () => {
		const signaturesOnly = convertMessages(gemini3, { messages: transcript, thoughtSignatureRetention: 1 })
			.flatMap(content => content.parts ?? [])
			.map(part => part.text ?? "")
			.join("\n");
		expect(signaturesOnly).toContain("first thought");

		const thinkingOnly = emittedSignatures(gemini3, transcript, undefined);
		expect(thinkingOnly).toEqual([sig, sig, sig]);
	});

	/** The point of the change, measured: dropping old summaries has to remove most of the payload. */
	it("removes the dropped summaries from the payload", () => {
		const long = "reasoning ".repeat(400);
		const messages: Message[] = [{ role: "user", content: "go" } as Message];
		for (let index = 0; index < 10; index++) messages.push(...unsignedThinkingTurn(`t${index}`, long));

		const full = JSON.stringify(convertMessages(gemini3, { messages, thinkingRetention: -1 })).length;
		const trimmed = JSON.stringify(convertMessages(gemini3, { messages, thinkingRetention: 1 })).length;
		expect(full - trimmed).toBeGreaterThan(9 * long.length);
	});
});
