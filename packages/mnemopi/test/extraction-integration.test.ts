import { afterEach, describe, expect, it } from "bun:test";
import type { FetchImpl } from "@veyyon/ai";
import { extractFacts } from "@veyyon/mnemopi/core/extraction";
import { type ChatMessage, ExtractionClient } from "@veyyon/mnemopi/core/extraction/client";
import { getExtractionStats, resetExtractionStats } from "@veyyon/mnemopi/core/extraction/diagnostics";
import { CallableLlmBackend, resetHostLlmBackendForTests, setHostLlmBackend } from "@veyyon/mnemopi/core/llm-backends";

const OLD_ENV = { ...process.env };

function restoreEnv(): void {
	for (const key in process.env) {
		if (!(key in OLD_ENV)) delete process.env[key];
	}
	for (const key in OLD_ENV) {
		const value = OLD_ENV[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

afterEach(() => {
	restoreEnv();
	resetHostLlmBackendForTests();
	resetExtractionStats();
});

describe("extraction integration", () => {
	it("uses a fake OpenAI-compatible remote endpoint for extractFacts", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_LLM_BASE_URL = "http://fake-remote/v1";
		let payloadJson = "";
		const fetchMock: FetchImpl = async (_input, init) => {
			payloadJson = String(init?.body);
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: '{"facts":["Ada prefers deterministic tests"]}' } }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const facts = await extractFacts("I prefer deterministic tests.", { fetch: fetchMock });
		expect(facts).toEqual(["Ada prefers deterministic tests"]);
		const payload = JSON.parse(payloadJson) as {
			temperature?: number;
			messages?: Array<{ content: string }>;
		};
		expect(payload.temperature).toBe(0);
		const firstMessage = payload.messages?.[0];
		if (firstMessage === undefined) throw new Error("expected first request message");
		expect(firstMessage.content).toContain("I prefer deterministic tests");
		expect(getExtractionStats().by_tier.remote.successes).toBe(1);
	});

	it("parses structured fact objects through ExtractionClient with fake HTTP", async () => {
		let requestedUrl = "";
		const fetchMock: FetchImpl = async input => {
			requestedUrl = String(input);
			return new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content:
									'[{"subject":"Ada","predicate":"prefers","object":"deterministic tests","timestamp":"","source":0,"confidence":0.95}]',
							},
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const client = new ExtractionClient({
			apiKey: "sk-test",
			baseUrl: "http://openrouter.test/api/v1",
			fetch: fetchMock,
		});
		const facts = await client.extractFacts([{ role: "user", content: "Ada prefers deterministic tests." }]);
		expect(requestedUrl).toBe("http://openrouter.test/api/v1/chat/completions");
		expect(facts).toHaveLength(1);
		const fact = facts[0];
		if (fact === undefined) throw new Error("expected one extracted fact");
		expect(fact.subject).toBe("Ada");
		expect(getExtractionStats().totals.successes).toBe(1);
		expect(getExtractionStats().by_tier.cloud.successes).toBe(1);
	});

	it("records malformed cloud JSON as a diagnostic failure", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(JSON.stringify({ choices: [{ message: { content: "Here: [oops, not json]" } }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		const client = new ExtractionClient({
			apiKey: "sk-test",
			baseUrl: "http://openrouter.test/api/v1",
			fetch: fetchMock,
		});
		expect(await client.extractFacts([{ role: "user", content: "Ada prefers tea." }])).toEqual([]);
		const cloud = getExtractionStats().by_tier.cloud;
		expect(cloud.failures).toBe(1);
		expect(cloud.error_samples.some(sample => sample.reason === "json_parse_failed")).toBe(true);
	});

	// Regression: a host LLM backend that THROWS must be recorded as a real host
	// FAILURE (host_adapter_raised), never as no_output. Before the callHostLlm
	// silent swallow was removed, the throw was caught deep in callHostLlm and
	// returned as null, so extraction saw "host produced nothing" and its
	// host_adapter_raised branch was dead. The operator could not tell a crashed
	// backend from a backend that legitimately found no facts (Law 10).
	it("records a throwing host backend as a host failure, not no_output", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_HOST_LLM_ENABLED = "true";
		setHostLlmBackend(
			new CallableLlmBackend("boom", () => {
				throw new Error("host adapter crashed");
			}),
		);

		expect(await extractFacts("Ada prefers deterministic tests.")).toEqual([]);
		const host = getExtractionStats().by_tier.host;
		expect(host.failures).toBe(1);
		expect(host.no_output).toBe(0);
		expect(host.error_samples.some(sample => sample.reason === "host_adapter_raised")).toBe(true);
		expect(host.error_samples.some(sample => sample.msg.includes("host adapter crashed"))).toBe(true);
	});

	// Regression twin for the remote transport: a network throw (or non-2xx) must
	// be recorded as remote_call_raised, not no_output. callRemoteLlm used to
	// swallow the throw to null, making this failure invisible and the
	// remote_call_raised branch dead (Law 10).
	it("records a throwing remote transport as a remote failure, not no_output", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_LLM_BASE_URL = "http://fake-remote/v1";
		const fetchThrow: FetchImpl = async () => {
			throw new Error("connection reset by peer");
		};

		expect(await extractFacts("Ada prefers deterministic tests.", { fetch: fetchThrow })).toEqual([]);
		const remote = getExtractionStats().by_tier.remote;
		expect(remote.failures).toBe(1);
		expect(remote.no_output).toBe(0);
		expect(remote.error_samples.some(sample => sample.reason === "remote_call_raised")).toBe(true);
		expect(remote.error_samples.some(sample => sample.msg.includes("connection reset by peer"))).toBe(true);
	});

	it("uses millisecond-scale rate-limit and fallback backoff delays", async () => {
		const originalSleep = Bun.sleep;
		const delays: number[] = [];
		Bun.sleep = ((ms: number | Date) => {
			delays.push(Number(ms));
			return Promise.resolve();
		}) as typeof Bun.sleep;

		class RateLimitedClient extends ExtractionClient {
			override callApi(
				_model: string,
				_messages: readonly ChatMessage[],
				_temperature: number,
				_maxTokens: number,
			): Promise<string> {
				return Promise.reject(new Error("429 rate limited"));
			}
		}

		try {
			const client = new RateLimitedClient({ model: "primary", apiKey: "sk-test", baseUrl: "http://remote.test" });
			expect(await client.chat([{ role: "user", content: "Ada prefers deterministic tests." }])).toBe("");
		} finally {
			Bun.sleep = originalSleep;
		}

		expect(delays.slice(0, 3)).toEqual([1000, 2000, 4000]);
		expect(delays.every(delay => delay >= 1000)).toBe(true);
	});

	// Regression: the extraction user prompt is built by substituting the raw
	// conversation into EXTRACTION_USER_TEMPLATE. `String.prototype.replace` with a
	// STRING replacement interprets `$$`, `$&`, `` $` ``, `$'`, and `$n` as special
	// patterns, so conversation content containing `$` (shell snippets, regex,
	// prices) was spliced or duplicated inside the prompt. The fix passes a
	// replacement FUNCTION, which inserts the text verbatim. These assert the exact
	// dangerous sequences reach the user message unchanged.
	describe("prompt template substitutes conversation text verbatim", () => {
		async function capturePrompt(content: string): Promise<string> {
			let userContent = "";
			const fetchMock: FetchImpl = async (_input, init) => {
				const payload = JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content: string }> };
				userContent = payload.messages?.find(m => m.role === "user")?.content ?? "";
				return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			};
			const client = new ExtractionClient({
				apiKey: "sk-test",
				baseUrl: "http://openrouter.test/api/v1",
				fetch: fetchMock,
			});
			await client.extractFacts([{ role: "user", content }]);
			return userContent;
		}

		it("preserves every `$`-replacement pattern without interpreting it", async () => {
			// Each of these would corrupt the prompt under a string replacement:
			// `$&` inserts the matched placeholder, `` $` `` the template prefix,
			// `$'` the suffix, `$1` an empty group, `$$` a literal single `$`.
			const content = "regex $& and $` and $' and group $1 and literal $$ and price $5";
			const prompt = await capturePrompt(content);
			expect(prompt).toContain(`[0] [user]: ${content}`);
			// The placeholder token must be gone: substitution happened exactly once.
			expect(prompt).not.toContain("{conversation_text}");
			// `$&` must NOT have expanded to the placeholder literal.
			expect(prompt).not.toContain("regex {conversation_text} and");
		});

		it("keeps a code snippet with `$'` from duplicating the template body", async () => {
			// `` $` `` and `$'` splice the pre-/post-match text; a template that put
			// instructions before the placeholder would otherwise repeat them here.
			const content = "const s = `a${x}b`; // trailing $' quote";
			const prompt = await capturePrompt(content);
			expect(prompt).toContain(`[0] [user]: ${content}`);
			// The instruction sentence appears once, not duplicated by a `` $` `` splice.
			expect(prompt.split("Extract all structured facts").length).toBe(2);
		});
	});
});
