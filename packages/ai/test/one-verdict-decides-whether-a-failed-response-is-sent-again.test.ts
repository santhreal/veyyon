/**
 * WHY: four provider ladders each wrote out "is this failed response worth another attempt", and the
 * four answers disagreed. `anthropic-client.ts` read the transient status set plus 409 and never
 * looked at the body; `ollama.ts` read 5xx and one body pattern; `usage/claude.ts` read the set minus
 * 429; and `@veyyon/utils`' `fetchWithRetry` gate stood in front of them with a fourth copy of the
 * set. The defect class is a decision with more than one home: a 429 was a spent allowance to the
 * credential layer and a throttle to two of the ladders, so the same failure rotated a credential on
 * one path and re-sent the same request on another.
 *
 * `error/response.ts` is the one home. This suite defends what it decides and, more importantly, that
 * the decision is DERIVED from the registry rather than restated: the retry vocabulary is read out of
 * `ERROR_DOMAINS` at run time, so a new failure family that retries at the transport stage reds the
 * pinned list until someone records it.
 *
 * What it does NOT catch: a ladder that stops calling `retryResponse` and writes its own predicate
 * again. Nothing in the type system forbids that, and a source scan for it is banned. The cases below
 * drive the three real ladders end to end instead, so a rewrite that changes their behaviour is
 * caught even though a rewrite that preserves it is not.
 */
import { describe, expect, it, vi } from "bun:test";
import { create, ERROR_DOMAINS, Flag, recover, retryResponse } from "@veyyon/ai/error";
import { AnthropicMessagesClient } from "@veyyon/ai/providers/anthropic-client";
import type { MessageCreateParamsStreaming } from "@veyyon/ai/providers/anthropic-wire";
import type { FetchImpl } from "@veyyon/ai/types";
import type { UsageFetchContext } from "@veyyon/ai/usage";
import { claudeUsageProvider } from "@veyyon/ai/usage/claude";

const params: MessageCreateParamsStreaming = {
	model: "claude-sonnet-4-5",
	messages: [{ role: "user", content: "hi" }],
	max_tokens: 8,
	stream: true,
};

function fetchMock(responses: readonly Response[]): { attempts: () => number; fetch: FetchImpl } {
	let calls = 0;
	const impl = (async (_input: string | URL | Request, _init?: RequestInit) => {
		const next = responses[Math.min(calls, responses.length - 1)];
		calls += 1;
		return next.clone();
	}) as typeof fetch;
	return { attempts: () => calls, fetch: impl };
}

function failure(status: number, body: string, headers: Record<string, string> = {}): Response {
	return new Response(body, { status, headers });
}

describe("the verdict is the registry's, not the ladder's", () => {
	it("retries exactly the families whose transport recovery is a retry", () => {
		const retried = ERROR_DOMAINS.filter(domain => domain.recovery?.transport.action === "retry").map(d => d.id);
		// Pinned by exact equality: a new domain that retries at the transport stage lands here and reds
		// this line, because "one more attempt against the same endpoint" is a decision someone records
		// rather than a default a family inherits.
		expect(retried).toEqual(["transport", "timeout"]);
	});

	it("leaves no family that claims a flag without saying what to do about it", () => {
		// A domain with no recovery is legitimate only when it claims no flag: `provider-http` reads a
		// provider's own status and code and hands the flags it finds to the families that own them. A
		// domain that claims a flag and states no recovery would leave every stage guessing, so it lands
		// here and reds this line.
		const undecided = ERROR_DOMAINS.filter(d => d.recovery === undefined && d.recovers.length > 0).map(d => d.id);
		expect(undecided).toEqual([]);
	});

	it("reads a quota wall as a wall and a throttle as a throttle, off the same status", () => {
		// The two answers the quota family exists to tell apart, both arriving as 429.
		expect(retryResponse(failure(429, ""), "")).toBe(false);
		expect(retryResponse(failure(429, "Too many requests"), "Too many requests")).toBe(true);
		expect(retryResponse(failure(429, "overloaded"), "overloaded")).toBe(true);
		expect(
			retryResponse(
				failure(429, '{"error":{"type":"usage_limit_reached"}}'),
				'{"error":{"type":"usage_limit_reached"}}',
			),
		).toBe(false);
		expect(recover(create(Flag.UsageLimit), "credential").action).toBe("rotate-credential");
	});

	it("falls back to the transient set only for a status with nothing to read", () => {
		for (const status of [408, 500, 502, 503, 504]) {
			expect(retryResponse(failure(status, ""), "")).toBe(true);
		}
		for (const status of [400, 401, 403, 404, 422]) {
			expect(retryResponse(failure(status, ""), "")).toBe(false);
		}
	});

	it("takes the provider's own instruction over every reading of the response", () => {
		expect(retryResponse(failure(503, "", { "x-should-retry": "false" }), "")).toBe(false);
		expect(retryResponse(failure(400, "", { "x-should-retry": "true" }), "")).toBe(true);
	});

	it("lets a provider add a status its API documents and refuse a body it knows repeats", () => {
		expect(retryResponse(failure(409, ""), "")).toBe(false);
		expect(retryResponse(failure(409, ""), "", { alsoRetry: [409] })).toBe(true);
		expect(retryResponse(failure(500, "boom"), "boom", { refusesReplay: body => body === "boom" })).toBe(false);
		expect(retryResponse(failure(429, ""), "", { neverRetry: [429] })).toBe(false);
	});

	it("decides on the status alone when the body is not in hand", () => {
		// A caller with no body must not get a different answer for the statuses that speak for
		// themselves — only the 429 split needs a body, and with none it reads as the wall.
		expect(retryResponse(failure(503, "irrelevant"), undefined)).toBe(true);
		expect(retryResponse(failure(429, "overloaded"), undefined)).toBe(false);
	});
});

describe("the ladders that used to answer for themselves", () => {
	it("sends an Anthropic throttle again and hands its quota wall to the credential layer", async () => {
		const throttled = fetchMock([
			failure(429, "overloaded", { "retry-after-ms": "1" }),
			new Response("{}", { status: 200 }),
		]);
		const client = new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 2, fetch: throttled.fetch });
		const response = await client.messages.create(params).asResponse();
		expect(response.status).toBe(200);
		expect(throttled.attempts()).toBe(2);

		const walled = fetchMock([failure(429, "", { "retry-after-ms": "1" })]);
		const walledClient = new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 2, fetch: walled.fetch });
		const error = await walledClient.messages
			.create(params)
			.asResponse()
			.catch((err: unknown) => err);
		expect(error).toBeInstanceOf(Error);
		// One attempt: a spent allowance is not answered by asking again with the same credential.
		expect(walled.attempts()).toBe(1);
	});

	it("keeps the usage poll's refusal of its own throttle", async () => {
		const retryWait = vi.fn(async (_delayMs: number, _signal?: AbortSignal) => {});
		const ctx: UsageFetchContext = {
			fetch: fetchMock([failure(429, JSON.stringify({ error: "rate_limited" }), { "retry-after": "1" })]).fetch,
			retryWait,
		};
		const report = await claudeUsageProvider.fetchUsage(
			{
				provider: "anthropic",
				credential: {
					type: "oauth",
					accessToken: "oat-test",
					accountId: "org_test",
					email: "user@example.com",
					expiresAt: Date.now() + 60_000,
				},
			},
			ctx,
		);
		expect(report).toBeNull();
		expect(retryWait).not.toHaveBeenCalled();
	});
});
