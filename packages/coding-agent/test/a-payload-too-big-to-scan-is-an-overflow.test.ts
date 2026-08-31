/**
 * WHY: a turn that outgrew the confidentiality scan limits dead-ended the session.
 *
 * The secret scan runs on the outbound payload BEFORE the request is sent, so an
 * oversized turn is refused locally and no provider ever answers it. The refusal
 * arrived as a plain confidentiality error, which classifies as nothing in
 * particular, so the retry ladder had no recovery for it and the compaction rescue
 * — the one mechanism that shrinks a turn — was never reached. The session showed
 * "the provider request exceeds the confidentiality scan byte limit" on every
 * attempt and could not get out of it by retrying, compacting, or rewinding the
 * tree, because none of those paths were told the failure was a size problem.
 *
 * The class this closes: EVERY size-attributed refusal from the outbound scan is a
 * context overflow, not just the byte limit the report happened to hit. The
 * boundary states which codes those are, and the flag rides the error itself, so
 * `classify` latches it off the chain and every reader of the id agrees without a
 * second predicate of its own.
 *
 * What it does NOT catch: whether the reduction that follows the overflow is large
 * enough to get under the scan limit. That is the compaction rescue's contract and
 * is proven in `a-turn-too-large-to-summarize-is-truncated-not-parked.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import * as AIError from "@veyyon/ai/error";
import { isProviderPayloadOversize, ProviderTransformError } from "@veyyon/coding-agent/provider-boundary";
import { MAX_JSON_TRANSFORM_STRING_BYTES, SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { obfuscateProviderPayload } from "@veyyon/coding-agent/session/agent-session";

const SECRET = "PROVIDER_PAYLOAD_OVERFLOW_SECRET";

function obfuscator(): SecretObfuscator {
	return new SecretObfuscator([{ type: "plain", origin: "config", content: SECRET }]);
}

function refusalFrom(payload: unknown): unknown {
	try {
		obfuscateProviderPayload(payload, obfuscator());
	} catch (error) {
		return error;
	}
	throw new Error("the boundary accepted a payload the test expected it to refuse");
}

describe("a payload too big to scan is an overflow", () => {
	it("classifies a byte-limit refusal as a context overflow the session can act on", () => {
		// One string over the cumulative input limit: the shape the report hit, where a
		// single turn's text alone exceeds what the scan will walk.
		const error = refusalFrom({ turn: "x".repeat(MAX_JSON_TRANSFORM_STRING_BYTES + 1) });

		expect(error).toBeInstanceOf(ProviderTransformError);
		expect(AIError.is(AIError.classify(error), AIError.Flag.ContextOverflow)).toBe(true);
	});

	it("reaches the overflow recovery through a wrapper, because the flag rides the error", () => {
		// The refusal is thrown inside the provider's payload hook and surfaces wrapped.
		// Classification walks the cause chain, so the recovery must survive the wrapping
		// rather than depending on the boundary being the outermost link.
		const wrapped = new Error("request failed", {
			cause: refusalFrom({ turn: "y".repeat(MAX_JSON_TRANSFORM_STRING_BYTES + 1) }),
		});

		expect(AIError.is(AIError.classify(wrapped), AIError.Flag.ContextOverflow)).toBe(true);
	});

	it("still refuses without naming any payload text", () => {
		const error = refusalFrom({ turn: `${SECRET}${"z".repeat(MAX_JSON_TRANSFORM_STRING_BYTES + 1)}` });

		expect(error).toBeInstanceOf(ProviderTransformError);
		expect((error as Error).message).not.toContain(SECRET);
		expect((error as Error).message).not.toContain("zzz");
	});

	it("leaves a refusal no smaller payload would fix classified as something else", () => {
		// A cycle is not a size problem. Calling it an overflow would send the session
		// into an unbounded compact-and-retry loop against a payload that never shrinks
		// into acceptance, which is the failure mode this fix must not introduce.
		const cyclic: Record<string, unknown> = { value: SECRET };
		cyclic.self = cyclic;
		const error = refusalFrom(cyclic);

		expect(error).toBeInstanceOf(ProviderTransformError);
		expect(isProviderPayloadOversize(error)).toBe(false);
		expect(AIError.is(AIError.classify(error), AIError.Flag.ContextOverflow)).toBe(false);
	});

	it("answers the size question per code, not per message wording", () => {
		// The boundary owns the answer, so a caller never re-derives it from the text.
		expect(isProviderPayloadOversize(new ProviderTransformError("b", "input-bytes"))).toBe(true);
		expect(isProviderPayloadOversize(new ProviderTransformError("b", "output-bytes"))).toBe(true);
		expect(isProviderPayloadOversize(new ProviderTransformError("b", "nodes"))).toBe(true);
		expect(isProviderPayloadOversize(new ProviderTransformError("b", "keys"))).toBe(true);
		expect(isProviderPayloadOversize(new ProviderTransformError("b", "array-items"))).toBe(true);
		expect(isProviderPayloadOversize(new ProviderTransformError("b", "depth"))).toBe(true);

		expect(isProviderPayloadOversize(new ProviderTransformError("b", "cycle"))).toBe(false);
		expect(isProviderPayloadOversize(new ProviderTransformError("b", "key-collision"))).toBe(false);
		expect(isProviderPayloadOversize(new ProviderTransformError("b", "transform-threw"))).toBe(false);
		expect(isProviderPayloadOversize(new Error("input-bytes"))).toBe(false);
	});
});
