/**
 * Which historical Gemini thought signatures a request re-uploads, and how many characters the rest
 * would have cost: the retention window, the length cap and the byte accounting the session reports.
 * `./google-shared` applies the policy when it converts messages, and the session reads the accounting
 * without loading the Google request converter.
 */
import type { AssistantMessage, Message } from "../types";

// Thought signatures must be base64 for Google APIs (TYPE_BYTES).
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

export function isValidThoughtSignature(signature: string | undefined): signature is string {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

/**
 * Index of the first message whose tool-call thought signatures are sent verbatim.
 *
 * WHY THIS EXISTS. A `thoughtSignature` is an opaque blob Gemini attaches to
 * every function call, and until this was added every historical one was
 * re-uploaded on every request forever. Measured over nine live sessions they
 * were the single largest thing in the context: 40.2% of the conversation body,
 * 1,295 signatures averaging 2,239 characters, the largest one 71,636 (about
 * 18k tokens on its own). They cost more than the tool results, the tool
 * arguments, the thinking, and the model's own text combined.
 *
 * The signature exists to replay reasoning context, so the recent ones are the
 * ones worth paying for. `retention` is how many trailing assistant messages
 * keep theirs; everything older sends {@link SKIP_THOUGHT_SIGNATURE} instead,
 * which is Google's sentinel for "this part has no signature, do not fail
 * validation" and costs 33 characters.
 *
 * `undefined` means retain everything, which is the behaviour before this
 * existed. Any caller that does not opt in is unaffected.
 */
export function firstRetainedAssistantIndex(messages: readonly Message[], retention: number | undefined): number {
	if (retention === undefined || !Number.isFinite(retention) || retention < 0) return 0;
	let remaining = Math.floor(retention);
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role !== "assistant") continue;
		if (remaining === 0) return index + 1;
		remaining--;
	}
	// Fewer assistant messages than the retention window: every one is recent.
	return 0;
}

/**
 * Characters this request does not send because of the retention window.
 *
 * The saving has to be observable or nobody can tell the setting is doing
 * anything: the request just silently gets smaller, and "silently" is how a
 * mechanism ends up disabled for a year without anyone noticing. The session
 * accumulates this across requests and exposes it the same way it exposes the
 * bytes elided by wire path relativization.
 *
 * It counts the same thing `convertMessages` in `./google-shared` elides, and only that: a
 * tool-call signature that is currently sent and would not be under this
 * window, minus the {@link SKIP_THOUGHT_SIGNATURE} that replaces it. Signatures
 * already dropped for another reason, such as a foreign model's, are not
 * counted, because this window did not save them.
 *
 * The figure is per request and cumulative over a session, so it grows faster
 * than linearly: the same historical signature is elided again on every
 * subsequent turn, which is precisely the cost the window exists to avoid.
 */
export function elidedSignatureBytes(
	messages: readonly Message[],
	policy: SignaturePolicy,
	sameProviderAndModel: (message: AssistantMessage) => boolean,
): number {
	let elided = 0;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message?.role !== "assistant" || !sameProviderAndModel(message)) continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			if (!isValidThoughtSignature(block.thoughtSignature)) continue;
			if (sendsSignature(policy, index, block.thoughtSignature)) continue;
			elided += block.thoughtSignature.length - SKIP_THOUGHT_SIGNATURE.length;
		}
	}
	return elided;
}

/**
 * The two independent rules that decide whether a historical thought signature is
 * re-uploaded, resolved once so nothing can apply one without the other.
 *
 * They exist as one type because they are trivially easy to drift apart: the
 * request builder and the byte accounting both have to answer the same question,
 * and if the accounting knows about recency but not length, the context panel
 * reports a saving that does not match the request that was sent. That is the
 * quiet kind of wrong, so both callers take this and neither reimplements it.
 */
export interface SignaturePolicy {
	/**
	 * The first message index that keeps its signatures. 0 keeps everything, which
	 * is the behaviour before any of this existed.
	 */
	readonly retainFrom: number;
	/**
	 * Longest signature that is still worth re-uploading, in characters, or
	 * undefined for no limit.
	 */
	readonly maxLength: number | undefined;
}

/**
 * Resolve both signature rules from a request's context.
 *
 * A non-positive `thoughtSignatureMaxLength` means "no limit" rather than "elide
 * everything". Settings default numeric knobs to -1 to mean unset, and a literal
 * reading of that would silently strip every signature in the conversation the
 * moment the setting existed, which is the most damaging possible interpretation
 * of a default.
 */
export function signaturePolicy(
	messages: readonly Message[],
	context: { thoughtSignatureRetention?: number; thoughtSignatureMaxLength?: number },
): SignaturePolicy {
	const max = context.thoughtSignatureMaxLength;
	return {
		retainFrom: firstRetainedAssistantIndex(messages, context.thoughtSignatureRetention),
		maxLength: max !== undefined && Number.isFinite(max) && max > 0 ? Math.floor(max) : undefined,
	};
}

/**
 * Whether one historical signature is sent, under both rules at once.
 *
 * THE SIZE RULE IS THE INTERESTING ONE, and it is not a variation on recency.
 * Signature bytes are extremely concentrated: measured over twenty DeepSWE
 * sessions, 2,297 signatures averaged 2,606 characters with a median of 660 and a
 * maximum of 91,960, and the largest tenth of them held 62.1% of all signature
 * bytes. So a length cap removes most of the mass while leaving the great
 * majority of the reasoning chain intact, whereas the recency window removes
 * nearly all of the mass and nearly all of the chain.
 *
 * That difference is the point. If replaying older reasoning turns out to matter,
 * a length cap degrades gently where a recency window does not, and the two can be
 * compared as separate arms because they are independent settings. They compose
 * when both are set: a signature is sent only if it is recent enough AND small
 * enough.
 */
export function sendsSignature(policy: SignaturePolicy, messageIndex: number, signature: string): boolean {
	if (messageIndex < policy.retainFrom) return false;
	if (policy.maxLength !== undefined && signature.length > policy.maxLength) return false;
	return true;
}
