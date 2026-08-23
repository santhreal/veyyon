import { describe, expect, it } from "bun:test";
import { classify, Flag, is, isProviderRetryableError } from "@veyyon/ai/error";
import { isCopilotTransientModelError } from "@veyyon/ai/error/flags";
import { callWithCopilotModelRetry } from "@veyyon/ai/utils/retry";

type ErrorShape = {
	status: number;
	code?: string;
	error?: { code?: string; message?: string };
	message: string;
	headers?: Record<string, string>;
};

function copilotError({ status, code, error, message, headers }: ErrorShape): Error & ErrorShape {
	return Object.assign(new Error(message), { status, code, error, headers });
}

describe("isCopilotTransientModelError", () => {
	it("matches 400 with top-level code=model_not_supported", () => {
		const err = copilotError({
			status: 400,
			code: "model_not_supported",
			message: "400 The requested model is not supported.",
		});
		expect(isCopilotTransientModelError(err)).toBe(true);
	});

	it("matches 400 with nested error.code=model_not_supported (OpenAI SDK shape)", () => {
		const err = copilotError({
			status: 400,
			error: { code: "model_not_supported", message: "The requested model is not supported." },
			message: "400 The requested model is not supported.",
		});
		expect(isCopilotTransientModelError(err)).toBe(true);
	});

	it("does not match other 400 codes", () => {
		const err = copilotError({
			status: 400,
			code: "invalid_request_body",
			message: "Unsupported value: 'minimal'",
		});
		expect(isCopilotTransientModelError(err)).toBe(false);
	});

	it("does not match 401/403/500 regardless of code", () => {
		for (const status of [401, 403, 500]) {
			const err = copilotError({
				status,
				code: "model_not_supported",
				message: `${status} error`,
			});
			expect(isCopilotTransientModelError(err)).toBe(false);
		}
	});

	it("does not match errors without a status", () => {
		expect(isCopilotTransientModelError(new Error("oops"))).toBe(false);
		expect(isCopilotTransientModelError("not an object")).toBe(false);
		expect(isCopilotTransientModelError(null)).toBe(false);
	});
});

describe("callWithCopilotModelRetry", () => {
	it("is a no-op for non-github-copilot providers", async () => {
		let calls = 0;
		const err = copilotError({ status: 400, code: "model_not_supported", message: "nope" });
		await expect(
			callWithCopilotModelRetry(
				async () => {
					calls += 1;
					throw err;
				},
				{ provider: "openai" },
			),
		).rejects.toBe(err);
		expect(calls).toBe(1);
	});

	it("retries up to 3 attempts for Copilot transient errors and eventually throws the last error", async () => {
		let calls = 0;
		const err = copilotError({ status: 400, code: "model_not_supported", message: "transient" });
		await expect(
			callWithCopilotModelRetry(
				async () => {
					calls += 1;
					throw err;
				},
				{ provider: "github-copilot", retryBaseDelayMs: 0 },
			),
		).rejects.toBe(err);
		expect(calls).toBe(3);
	});

	it("succeeds on the second attempt when the first is transient", async () => {
		let calls = 0;
		const result = await callWithCopilotModelRetry(
			async () => {
				calls += 1;
				if (calls === 1) {
					throw copilotError({ status: 400, code: "model_not_supported", message: "transient" });
				}
				return "ok" as const;
			},
			{ provider: "github-copilot", retryBaseDelayMs: 0 },
		);
		expect(result).toBe("ok");
		expect(calls).toBe(2);
	});

	it("does not retry non-transient Copilot errors", async () => {
		let calls = 0;
		const err = copilotError({ status: 401, code: "unauthorized", message: "auth failed" });
		await expect(
			callWithCopilotModelRetry(
				async () => {
					calls += 1;
					throw err;
				},
				{ provider: "github-copilot" },
			),
		).rejects.toBe(err);
		expect(calls).toBe(1);
	});

	it("does not blind-retry a 429 that carries no Retry-After guidance", async () => {
		let calls = 0;
		const err = copilotError({ status: 429, message: "rate limited" });
		await expect(
			callWithCopilotModelRetry(
				async () => {
					calls += 1;
					throw err;
				},
				{ provider: "github-copilot", retryBaseDelayMs: 0 },
			),
		).rejects.toBe(err);
		expect(calls).toBe(1);
	});

	it("honors Retry-After on a 429 and retries", async () => {
		let calls = 0;
		const result = await callWithCopilotModelRetry(
			async () => {
				calls += 1;
				if (calls === 1) {
					const err = copilotError({ status: 429, message: "rate limited" });
					err.headers = { "retry-after": "0.01" };
					throw err;
				}
				return "ok" as const;
			},
			{ provider: "github-copilot", retryBaseDelayMs: 0 },
		);
		expect(result).toBe("ok");
		expect(calls).toBe(2);
	});

	/**
	 * A zero Retry-After value is valid server guidance to retry immediately;
	 * dropping it used to misclassify a guided 429 as an unguided terminal rate limit.
	 */
	it("accepts Retry-After zero as explicit retry guidance", async () => {
		const events: string[] = [];
		const result = await callWithCopilotModelRetry(
			async () => {
				events.push(`attempt:${events.length + 1}`);
				if (events.length === 1) {
					throw copilotError({ status: 429, message: "rate limited", headers: { "retry-after": "0" } });
				}
				return "ok" as const;
			},
			{ provider: "github-copilot", retryBaseDelayMs: 0 },
		);

		expect(result).toBe("ok");
		expect(events).toEqual(["attempt:1", "attempt:2"]);
	});

	/**
	 * Copilot 5xx responses are transient even when they omit Retry-After;
	 * requiring that header suppressed the classifier's normal backoff retry.
	 */
	it("retries a transient 5xx without Retry-After guidance", async () => {
		const attempts: number[] = [];
		const result = await callWithCopilotModelRetry(
			async () => {
				attempts.push(attempts.length + 1);
				if (attempts.length === 1) throw copilotError({ status: 503, message: "service unavailable" });
				return "ok" as const;
			},
			{ provider: "github-copilot", retryBaseDelayMs: 0 },
		);

		expect(result).toBe("ok");
		expect(attempts).toEqual([1, 2]);
	});

	it("still retries status-less transport blips with the linear backoff", async () => {
		let calls = 0;
		const result = await callWithCopilotModelRetry(
			async () => {
				calls += 1;
				if (calls === 1) {
					throw new Error(
						'HTTP2StreamReset fetching "https://api.example.com/x". For more information, pass `verbose: true` in the second argument to fetch()',
					);
				}
				return "ok" as const;
			},
			{ provider: "github-copilot", retryBaseDelayMs: 0 },
		);
		expect(result).toBe("ok");
		expect(calls).toBe(2);
	});

	/**
	 * A signal latched before dispatch must prevent the physical request entirely
	 * and preserve the caller's exact cancellation reason.
	 */
	it("does not dispatch an attempt for a pre-aborted Copilot request", async () => {
		const controller = new AbortController();
		const reason = new Error("caller cancelled before dispatch");
		controller.abort(reason);
		const events: string[] = [];

		await expect(
			callWithCopilotModelRetry(
				async () => {
					events.push("attempt");
					throw copilotError({ status: 400, code: "model_not_supported", message: "transient" });
				},
				{ provider: "github-copilot", signal: controller.signal, retryBaseDelayMs: 0 },
			),
		).rejects.toBe(reason);
		expect(events).toEqual([]);
	});

	/**
	 * Cancellation that lands after a retryable failure but during backoff must
	 * beat the timer's synthetic AbortError and prevent a second physical attempt.
	 */
	it("preserves caller cancellation that lands during backoff", async () => {
		const controller = new AbortController();
		const reason = new Error("caller cancelled during backoff");
		const events: string[] = [];

		await expect(
			callWithCopilotModelRetry(
				async () => {
					events.push("attempt:1");
					queueMicrotask(() => {
						events.push("abort");
						controller.abort(reason);
					});
					throw copilotError({ status: 400, code: "model_not_supported", message: "transient" });
				},
				{ provider: "github-copilot", signal: controller.signal, retryBaseDelayMs: 60_000 },
			),
		).rejects.toBe(reason);
		expect(events).toEqual(["attempt:1", "abort"]);
	});
});

describe("the one retry predicate on transport failures", () => {
	it("retries Bun socket closure errors", () => {
		expect(
			isProviderRetryableError(
				new Error(
					"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
				),
			),
		).toBe(true);
	});
	it("retries Bun HTTP/2 stream reset errors", () => {
		// Bun's fetch surfaces `@errorName` from its h2 client verbatim in the
		// message — see oven-sh/bun src/http/h2_client/dispatch.zig (HTTP2StreamReset,
		// HTTP2RefusedStream) and FetchTasklet.zig's "{s} fetching \"...\"" template.
		expect(
			isProviderRetryableError(
				new Error(
					'HTTP2StreamReset fetching "https://chatgpt.com/backend-api/codex/responses". For more information, pass `verbose: true` in the second argument to fetch()',
				),
			),
		).toBe(true);
		expect(
			isProviderRetryableError(
				new Error(
					'HTTP2RefusedStream fetching "https://api.example.com/x". For more information, pass `verbose: true` in the second argument to fetch()',
				),
			),
		).toBe(true);
	});
});

describe("the Copilot routing flap is one rule with two readers", () => {
	/**
	 * WHAT THIS BLOCK NOW DEFENDS. `isProviderRetryableError` refuses every 4xx that is not 408 or
	 * 429, the flap included, and that veto is deliberate: a provider-level ladder is a seconds-scale
	 * backoff against the same credential and a 400 is a wall to everything except the one loop that
	 * knows what this particular 400 means. So the flap is answered by `isCopilotTransientModelError`,
	 * which `callWithCopilotModelRetry` calls, and the two predicates differ on purpose.
	 *
	 * WHAT WAS BROKEN. The rule had two homes reading different evidence. The accessor read `code` and
	 * the SDK's nested `error.code`; the classifier read the body text. A 400 whose message was `x`
	 * and whose code said `model_not_supported` was therefore retried by the ladder while carrying no
	 * flag at all, so every flag reader — the session's retry banner, a diagnostic, anything asking
	 * `classify` — saw an unclassified 400. `Signal.code` carries the field into the rules, the rule
	 * lives once in the network family, and both readers now agree about what the failure IS while
	 * still disagreeing about who retries it.
	 */
	it.each([
		["a top-level code", copilotError({ status: 400, code: "model_not_supported", message: "x" })],
		["the SDK's nested code", copilotError({ status: 400, error: { code: "model_not_supported" }, message: "x" })],
		["the body text", copilotError({ status: 400, message: "400 model_not_supported: pick another" })],
	])("classifies the flap stated as %s", (_label, err) => {
		expect(isCopilotTransientModelError(err)).toBe(true);
		expect(is(classify(err), Flag.Transient)).toBe(true);
	});

	/** And the provider-level ladder still refuses it, because a 400 is not its business. */
	it.each([
		["a top-level code", copilotError({ status: 400, code: "model_not_supported", message: "x" })],
		["the SDK's nested code", copilotError({ status: 400, error: { code: "model_not_supported" }, message: "x" })],
		["the body text", copilotError({ status: 400, message: "400 model_not_supported: pick another" })],
	])("leaves the flap stated as %s to the Copilot ladder", (_label, err) => {
		expect(isProviderRetryableError(err)).toBe(false);
	});

	/** A 400 that names something else is still a wall, so the rule is narrow. */
	it("keeps every other 400 a wall", () => {
		const err = copilotError({ status: 400, code: "invalid_request_error", message: "bad tool schema" });

		expect(isProviderRetryableError(err)).toBe(false);
		expect(isCopilotTransientModelError(err)).toBe(false);
	});

	/**
	 * The accessor must not widen into "any transient 400". A 400 whose body reads like a gateway page
	 * classifies transient through the transport vocabulary, and treating that as the routing flap
	 * would skip the ladder's retry-after handling.
	 */
	it("does not read a transient-sounding 400 as the routing flap", () => {
		const err = copilotError({ status: 400, message: "400 upstream server error, please retry" });

		expect(isCopilotTransientModelError(err)).toBe(false);
	});
});
