import { describe, expect, it } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import * as AIError from "@veyyon/ai/error";
import { cursorStreamFailure } from "@veyyon/ai/providers/cursor";
import { streamDevin } from "@veyyon/ai/providers/devin";
import type { Context, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { GetUserJwtResponseSchema } from "@veyyon/catalog/discovery/devin-gen/exa/auth_pb/auth_pb";

/**
 * WHY THIS SUITE EXISTS, AND WHICH CLASS IT CLOSES.
 *
 * A provider failure the operator can read is the difference between "the gateway
 * in front of Devin returned 500 with no envelope" and a message that stops at a
 * colon. Every site that interpolates a provider body goes through
 * `boundProviderErrorDetail`, which capped a long body and passed an empty one
 * through unchanged, so a body-less failure rendered as
 * `Devin API error 500 Internal Server Error: ` and named no reason at all.
 *
 * The class is "an interpolated provider body reaches `Error.message` unexamined",
 * and it has two members: absent (a dangling colon) and enormous (a proxy's HTML
 * page). One function answers both for every call site, which is why these rows
 * assert the owner directly AND drive two real provider paths through it.
 *
 * Anthropic's `status code (no body)` is deliberately NOT the generic wording, and
 * that is pinned here too: the overflow classifier reads those exact bytes to spot
 * an overlong prompt Anthropic rejects with no envelope, so a well-meaning
 * unification of the wording would silently retire auto-compaction for that case.
 *
 * WHAT THIS DOES NOT CATCH: a NEW call site that formats a provider body by hand
 * instead of calling the bound. Nothing here can see that, and a source scan for it
 * would assert how the code looks rather than what it does.
 */

const devinModel: Model<"devin-agent"> = buildModel({
	id: "devin-test",
	name: "Devin Test",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));

describe("a provider failure names its reason", () => {
	it("names an absent detail instead of ending at a colon", () => {
		for (const body of ["", " ", "\n", "\t \r\n "]) {
			expect(AIError.boundProviderErrorDetail(body)).toBe(AIError.NO_PROVIDER_ERROR_DETAIL);
		}
		expect(AIError.NO_PROVIDER_ERROR_DETAIL).toBe("(no detail)");
	});

	it("keeps a real detail verbatim, minus surrounding whitespace", () => {
		expect(AIError.boundProviderErrorDetail('{"error":{"message":"upstream timeout"}}')).toBe(
			'{"error":{"message":"upstream timeout"}}',
		);
		expect(AIError.boundProviderErrorDetail("\n  502 Bad Gateway  \n")).toBe("502 Bad Gateway");
	});

	it("caps a proxy page and says how much it dropped", () => {
		const page = `<html>${"x".repeat(20_000)}</html>`;
		const bounded = AIError.boundProviderErrorDetail(page);
		expect(bounded.length).toBeLessThan(page.length);
		expect(bounded).toContain(`[truncated, ${page.length} chars total]`);
		expect(bounded.startsWith("<html>xxx")).toBe(true);
	});
});

describe("anthropic keeps the no-body spelling the overflow classifier reads", () => {
	it("reports a body-less 400 as an overflow, not as a generic empty detail", async () => {
		const error = await AIError.AnthropicApiError.fromResponse(new Response(null, { status: 400 }));
		expect(error.message).toBe("400 status code (no body)");
		expect(AIError.is(AIError.classify(error), AIError.Flag.ContextOverflow)).toBe(true);
	});

	it("reports a body-less 413 the same way", async () => {
		const error = await AIError.AnthropicApiError.fromResponse(new Response("   ", { status: 413 }));
		expect(error.message).toBe("413 status code (no body)");
		expect(AIError.is(AIError.classify(error), AIError.Flag.ContextOverflow)).toBe(true);
	});

	it("does not read a body-less 500 as an overflow", async () => {
		const error = await AIError.AnthropicApiError.fromResponse(new Response(null, { status: 500 }));
		expect(error.message).toBe("500 status code (no body)");
		expect(AIError.is(AIError.classify(error), AIError.Flag.ContextOverflow)).toBe(false);
		expect(AIError.is(AIError.classify(error), AIError.Flag.Transient)).toBe(true);
	});

	it("still caps a body it does have", async () => {
		const page = `<html>${"y".repeat(9_000)}</html>`;
		const error = await AIError.AnthropicApiError.fromResponse(new Response(page, { status: 502 }));
		expect(error.message).toContain(`[truncated, ${page.length} chars total]`);
		expect(error.message.length).toBeLessThan(page.length);
	});
});

describe("devin puts every interpolated body through the bound", () => {
	it("names an absent API error body rather than trailing off", async () => {
		// 400 on purpose: a body-less 500 is transient and would sit in the provider
		// backoff, and the question here is what the message SAYS.
		const fetchImpl = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("GetUserJwt")) return new Response(authPayload);
			return new Response("", { status: 400, statusText: "Bad Request" });
		}) as typeof fetch;

		const result = await streamDevin(devinModel, context, { apiKey: "token", fetch: fetchImpl }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Devin API error 400 Bad Request: (no detail)");
		expect(result.errorMessage?.trimEnd().endsWith(":")).toBe(false);
	});

	it("caps an auth failure body, which used to be interpolated whole", async () => {
		// 401 on purpose: an auth failure is terminal, so this is one attempt.
		const page = `<html><title>Corporate proxy</title>${"z".repeat(30_000)}</html>`;
		const fetchImpl = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("GetUserJwt")) return new Response(page, { status: 401, statusText: "Unauthorized" });
			return new Response("", { status: 500 });
		}) as typeof fetch;

		const result = await streamDevin(devinModel, context, { apiKey: "token", fetch: fetchImpl }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Devin auth error 401 Unauthorized:");
		expect(result.errorMessage).toContain(`[truncated, ${page.length} chars total]`);
		expect(result.errorMessage?.length).toBeLessThan(page.length);
	});
});

describe("cursor trailers name their reason", () => {
	it("names an absent trailer message", () => {
		const failure = cursorStreamFailure("14", "", "gRPC error");
		expect(failure.message).toBe("gRPC error 14: (no detail)");
		// The verdict still comes from the code, not from the placeholder text.
		expect(AIError.status(failure)).toBe(503);
		expect(AIError.isProviderRetryableError(failure)).toBe(true);
	});

	it("keeps a trailer message the server did send", () => {
		const failure = cursorStreamFailure("unavailable", "backend restarting", "Connect error");
		expect(failure.message).toBe("Connect error unavailable: backend restarting");
	});
});
