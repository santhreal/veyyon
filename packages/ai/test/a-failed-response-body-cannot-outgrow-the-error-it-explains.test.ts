/**
 * A failed response's body is a stranger's bytes, and it was read whole.
 *
 * WHY THIS SUITE EXISTS. Every non-2xx path in this package called
 * `await response.text()`, which decodes the entire body before anything caps it. The
 * caps that existed capped the MESSAGE. So a 100 MB error page — a captive portal, a
 * misrouted gateway, a proxy dumping the request back, a hostile endpoint — was
 * allocated in full, and whatever survived the message cap then went to `Error.message`,
 * the assistant turn, the session file, and the TUI, where it is re-rendered on every
 * later read of that turn. Two things travel in such a body that must not travel
 * further: terminal control sequences, because the message is printed to a terminal, and
 * the request's own `Authorization` header, because a proxy echo puts the operator's key
 * in a log file they then attach to an issue.
 *
 * THE CLASS IT CLOSES. "A provider error body reaches an operator through an unbounded
 * read or unsanitized bytes." The invariant is asserted at the choke point every
 * transport now goes through — `readProviderErrorBody` — because one test at the
 * boundary beats one test per call site, and the call sites are where the long tail
 * lives. The transports are then swept through their own real non-2xx paths, so a
 * provider that goes back to reading the body itself fails here rather than in a
 * customer's log. The redaction families are enumerated from the exported list at run
 * time and pinned by exact equality, so adding a family without a sample that proves it
 * redacts turns this red.
 *
 * WHAT IT DOES NOT CATCH. It does not claim to be a secret scanner: a credential with no
 * label, no vendor prefix and no JWT shape passes through, and a body that IS the
 * secret (a token endpoint answering 200) is not this path at all. It pins the ceiling's
 * effect, not the number — a future ceiling change is a decision, not a regression. And
 * it says nothing about the auth broker's own client, which is a first-party local
 * process whose error body callers parse structurally.
 */
import { describe, expect, it } from "bun:test";
import {
	AnthropicApiError,
	MAX_PROVIDER_ERROR_BODY_BYTES,
	MAX_PROVIDER_ERROR_DETAIL_CHARS,
	NO_PROVIDER_ERROR_DETAIL,
	PROVIDER_SECRET_FAMILIES,
	readProviderErrorBody,
	redactProviderSecrets,
} from "@veyyon/ai/error";
import { parseCodexError } from "@veyyon/ai/providers/openai-codex/response-handler";
import {
	validateApiKeyAgainstModelsEndpoint,
	validateOpenAICompatibleApiKey,
} from "@veyyon/ai/registry/api-key-validation";

/** A stolen-looking token used as the sentinel throughout: JWT-shaped, so it is findable. */
const SENTINEL_TOKEN =
	"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJvcGVyYXRvciIsImlhdCI6MTUxNjIzOTAyMn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

/** A response whose body is a plain string, with optional headers. */
function bodyResponse(body: string, init?: { status?: number; headers?: Record<string, string> }): Response {
	return new Response(body, { status: init?.status ?? 500, headers: init?.headers });
}

interface EndlessBody {
	response: (status?: number, headers?: Record<string, string>) => Response;
	/** Chunks the reader pulled — the bound on what was allocated. */
	pulls: () => number;
	cancelled: () => boolean;
}

/**
 * A response that never ends, which is the shape of the body this whole lane is about.
 *
 * The counters are what make "bounded" observable: an unbounded read pulls forever, and
 * a read that stops without cancelling leaves the connection open.
 */
function endlessBody(chunkBytes = 4096): EndlessBody {
	let pulls = 0;
	let cancelled = false;
	const chunk = new Uint8Array(chunkBytes).fill(0x61);
	return {
		response: (status = 502, headers) =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						pulls += 1;
						controller.enqueue(chunk.slice());
					},
					cancel() {
						cancelled = true;
					},
				}),
				{ status, headers },
			),
		pulls: () => pulls,
		cancelled: () => cancelled,
	};
}

describe("a failed response body cannot outgrow the error it explains", () => {
	it("stops reading at the ceiling and cancels the rest", async () => {
		const endless = endlessBody(1024);
		const body = await readProviderErrorBody(endless.response(), { maxBytes: 4096 });

		expect(body.bytesRead).toBe(4096);
		expect(body.truncated).toBe(true);
		expect(endless.cancelled()).toBe(true);
		// Four chunks fill the ceiling; the fifth is the probe that distinguishes a body
		// which happened to end there. Anything beyond that is a read that did not stop.
		expect(endless.pulls()).toBeLessThanOrEqual(5);
		expect(body.text.length).toBe(4096);
	});

	it("a body exactly at the ceiling is not called truncated", async () => {
		// The off-by-one that would otherwise report every full-cap body as cut short.
		const body = await readProviderErrorBody(bodyResponse("x".repeat(64)), { maxBytes: 64 });

		expect(body.bytesRead).toBe(64);
		expect(body.truncated).toBe(false);
		expect(body.detail).toBe("x".repeat(64));
	});

	/**
	 * A body that fits under the byte ceiling and still exceeds what a message may
	 * carry: the read is complete, so the note is the character cap's own, and it
	 * names the whole body because in this case the whole body is what was read.
	 */
	it("caps a complete body that is still too long for a message", async () => {
		const body = await readProviderErrorBody(bodyResponse("y".repeat(5000)));

		expect(body.truncated).toBe(false);
		expect(body.text).toHaveLength(5000);
		expect(body.detail).toBe(`${"y".repeat(4096)} [truncated, 5000 chars total]`);
	});

	it("names the unread byte count when the server declared a length", async () => {
		const endless = endlessBody(512);
		const body = await readProviderErrorBody(endless.response(502, { "content-length": "1048576" }), {
			maxBytes: 1024,
		});

		expect(body.declaredBytes).toBe(1_048_576);
		expect(body.detail).toContain("[truncated, 1047552 of 1048576 bytes not read]");
	});

	it("names where the read stopped when the server declared no length", async () => {
		const endless = endlessBody(512);
		const body = await readProviderErrorBody(endless.response(), { maxBytes: 1024 });

		expect(body.declaredBytes).toBeUndefined();
		expect(body.detail).toContain("[truncated, read stopped at 1024 bytes]");
	});

	/**
	 * Both cuts in one bracket. Reported separately they produced two adjacent
	 * `[truncated, …]` notes whose numbers contradicted each other: the character note
	 * called the 64 KiB that was read the whole body, when 200 KB more was on the wire.
	 */
	it("states the character cut and the read cut in a single note", async () => {
		const endless = endlessBody(1024);
		const body = await readProviderErrorBody(endless.response(502, { "content-length": "40000" }), {
			maxBytes: 20_480,
		});

		expect(body.text).toHaveLength(20_480);
		expect(body.detail).toHaveLength(
			4096 + 1 + "[truncated, showing 4096 of 20480 chars read, 19520 of 40000 bytes not read]".length,
		);
		expect(body.detail.endsWith("[truncated, showing 4096 of 20480 chars read, 19520 of 40000 bytes not read]")).toBe(
			true,
		);
		expect(body.detail.split("[truncated").length - 1).toBe(1);
	});

	it("drops a character the ceiling split instead of corrupting it", async () => {
		// Every character is two bytes, and the ceiling lands inside one of them. The
		// alternative — the decoder's replacement character — reads as corruption the
		// provider did not send, in the middle of a message an operator is trying to use.
		const body = await readProviderErrorBody(bodyResponse("é".repeat(64)), { maxBytes: 33 });

		expect(body.truncated).toBe(true);
		expect(body.text).not.toContain("\ufffd");
		expect(body.text).toBe("é".repeat(16));
	});

	it("strips what a terminal would obey and keeps what a reader needs", async () => {
		const hostile = "line one\n\tindented\u001b[2J\u001b[1;1H\u0007\u0000done";
		const body = await readProviderErrorBody(bodyResponse(hostile));

		// The sequences are removed, not replaced: nothing is substituted in their place, so
		// the surrounding words close up. Newline and tab are the two controls a reader
		// needs and the only two kept.
		expect(body.detail).toBe("line one\n\tindenteddone");
		expect(body.detail).not.toContain("\u001b");
		expect(body.detail).not.toContain("\u0007");
		expect(body.detail).not.toContain("\u0000");
	});

	it("redacts every credential family it declares", async () => {
		// Enumerated from the exported list at run time. A family added without a sample
		// below fails the lookup, and a family removed fails the equality — either way the
		// decision is recorded here rather than discovered later.
		const samples: Record<string, { body: string; secret: string }> = {
			"labelled-credential": {
				body: `<pre>GET /v1/messages\nAuthorization: ${SENTINEL_TOKEN}\nHost: api</pre>`,
				secret: SENTINEL_TOKEN,
			},
			"labelled-key": {
				body: `{"echo":{"x-api-key":"sk-live-abcdefghijklmnop"}}`,
				secret: "sk-live-abcdefghijklmnop",
			},
			"bearer-token": { body: `proxy rejected "Bearer ${SENTINEL_TOKEN}"`, secret: SENTINEL_TOKEN },
			jwt: { body: `token ${SENTINEL_TOKEN} was refused`, secret: SENTINEL_TOKEN },
			"prefixed-key": {
				body: "credential sk-ant-api03-AAAAAAAAAAAAAAAAAAAA was revoked",
				secret: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAA",
			},
		};

		expect(PROVIDER_SECRET_FAMILIES.map(family => family.name)).toEqual([
			"labelled-credential",
			"labelled-key",
			"bearer-token",
			"jwt",
			"prefixed-key",
		]);

		for (const family of PROVIDER_SECRET_FAMILIES) {
			const sample = samples[family.name];
			expect(sample, `no sample proves the ${family.name} family redacts`).toBeDefined();
			if (!sample) continue;
			const redacted = redactProviderSecrets(sample.body);
			expect(redacted, family.name).not.toContain(sample.secret);
			expect(redacted, family.name).toContain("<redacted ");
		}
	});

	it("keeps a real provider envelope intact apart from a redaction", async () => {
		// The bound must not cost the diagnosis. A small JSON error is what a provider
		// actually sends, and it has to arrive parseable, with its own message and code.
		const envelope = JSON.stringify({ error: { message: "model not found", code: "model_not_found" } });
		const body = await readProviderErrorBody(bodyResponse(envelope, { status: 404 }));

		expect(body.text).toBe(envelope);
		expect(body.truncated).toBe(false);
		expect(JSON.parse(body.text)).toEqual({ error: { message: "model not found", code: "model_not_found" } });
	});

	it("keeps what arrived when the stream fails mid-read, and never throws", async () => {
		// The STATUS is the diagnosis. A read error replacing it would report a transport
		// fault for what is really a 500 the server explained. The chunk is delivered from a
		// pull, not enqueued beside the error, because a stream that errors in `start`
		// discards its queue and would prove only the empty case.
		let pulls = 0;
		const failing = new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					pulls += 1;
					if (pulls === 1) {
						controller.enqueue(new TextEncoder().encode("upstream said: "));
						return;
					}
					controller.error(new Error("connection reset"));
				},
			}),
			{ status: 500 },
		);

		const body = await readProviderErrorBody(failing);

		expect(body.text).toBe("upstream said: ");
		expect(body.detail).toBe("upstream said:");
		expect(body.truncated).toBe(false);
	});

	it("reads an absent body as an absent detail", async () => {
		const body = await readProviderErrorBody(bodyResponse("   \n\t "));

		expect(body.detail).toBe(NO_PROVIDER_ERROR_DETAIL);
		expect(body.truncated).toBe(false);
	});

	/**
	 * Each transport's own non-2xx path, driven for real.
	 *
	 * `message` returns what the operator would see. A transport that goes back to
	 * reading the body itself fails the sweep below, which is the point: the ceiling is
	 * shared, and a per-provider read is how it stopped being shared last time.
	 */
	const transports: ReadonlyArray<{ name: string; message: (respond: () => Response) => Promise<string> }> = [
		{
			name: "anthropic",
			message: async respond => (await AnthropicApiError.fromResponse(respond())).message,
		},
		{
			name: "openai-codex",
			message: async respond => (await parseCodexError(respond())).message,
		},
		{
			name: "openai-compatible-key-validation",
			message: async respond => {
				try {
					await validateOpenAICompatibleApiKey({
						provider: "test",
						apiKey: "key",
						baseUrl: "https://provider.invalid/v1",
						model: "m",
						fetch: async () => respond(),
					});
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
				throw new Error("validation resolved on a non-2xx response");
			},
		},
		{
			name: "models-endpoint-key-validation",
			message: async respond => {
				try {
					await validateApiKeyAgainstModelsEndpoint({
						provider: "test",
						apiKey: "key",
						modelsUrl: "https://provider.invalid/models",
						fetch: async () => respond(),
					});
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
				throw new Error("validation resolved on a non-2xx response");
			},
		},
	];

	for (const transport of transports) {
		it(`${transport.name} bounds and sanitizes what it puts in an error`, async () => {
			const endless = endlessBody(8192);
			const message = await transport.message(() => endless.response(500, { "content-length": "104857600" }));

			// The whole message, not just the body slice: an operator-visible string built
			// from a 100 MB body must still be a string a terminal can print.
			expect(message.length).toBeLessThan(MAX_PROVIDER_ERROR_DETAIL_CHARS + 512);
			expect(endless.cancelled()).toBe(true);
			// The reader stops at its own ceiling however large the body claims to be.
			expect(endless.pulls()).toBeLessThanOrEqual(MAX_PROVIDER_ERROR_BODY_BYTES / 8192 + 2);
		});

		it(`${transport.name} never puts a credential the server echoed into an error`, async () => {
			const echo = `502 Bad Gateway\n\nGET /v1 HTTP/1.1\nAuthorization: Bearer ${SENTINEL_TOKEN}\n`;
			const message = await transport.message(() => bodyResponse(echo, { status: 502 }));

			expect(message).not.toContain(SENTINEL_TOKEN);
			expect(message).toContain("<redacted ");
		});
	}

	it("a provider's structured error survives the shared reader", async () => {
		// The transports above prove the bound; this proves it did not cost the envelope.
		// Codex classification depends on `code`, and the rate-limit wording depends on it
		// reaching the friendly message.
		const info = await parseCodexError(
			new Response(
				JSON.stringify({ error: { message: "quota gone", code: "usage_limit_reached", plan_type: "Plus" } }),
				{
					status: 429,
				},
			),
		);

		expect(info.code).toBe("usage_limit_reached");
		expect(info.status).toBe(429);
		expect(info.message).toBe("quota gone");
		expect(info.friendlyMessage).toContain("ChatGPT usage limit");
	});
});
