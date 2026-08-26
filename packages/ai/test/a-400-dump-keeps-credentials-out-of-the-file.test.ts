/**
 * WHY: a rejected 400/413 request is persisted to `logs/http-400-requests/<n>.json` so the
 * operator can attach it to a bug report. The header redaction on that path matched header names
 * against a private exact-match list that had no `x-goog-api-key` entry, so a Google Generative AI
 * or Vertex request — both send the key in exactly that header — wrote the operator's plaintext
 * API key into a file whose whole purpose is to be shared.
 *
 * The class is wider than the one header: this package has two dump paths, and each carried its
 * own idea of what a credential header is called. The sibling path's predicate already matched by
 * substring and already covered `x-goog-api-key`; this one had drifted. Any provider-specific
 * spelling either path failed to anticipate is the same defect again.
 *
 * The contract these tests defend:
 *   - the two dump paths agree, name for name, on what counts as a credential header, so one
 *     cannot be fixed while the other keeps leaking;
 *   - a credential value never survives anywhere in the serialized payload, not only in the field
 *     it was read from;
 *   - ordinary protocol headers and the body still land verbatim, so the dump is still a dump.
 *
 * What it does not catch: a credential the caller puts in the request *body* rather than a header,
 * and a provider that invents a spelling neither path's predicate matches (`x-goog-api-key` was
 * caught by a substring, not by being anticipated).
 */

import { describe, expect, it } from "bun:test";
import { buildHttp400DumpPayload, type RawHttpRequestDump } from "@veyyon/ai/utils/http-inspector";
import { isCredentialHeaderName } from "@veyyon/ai/utils/request-debug";

const SECRET = "AIzaSyD-0123456789abcdefghijklmnopqrstuv";

/**
 * Header spellings shipped providers actually send, plus the ordinary protocol headers that must
 * survive. The expected outcome for each is not written down here: it is read from the sibling
 * path's predicate, so a private list re-forked into the 400 dump path goes red on the first
 * spelling the two disagree about.
 */
const HEADER_SPELLINGS: readonly string[] = [
	"x-goog-api-key",
	"x-api-key",
	"api-key",
	"authorization",
	"Authorization",
	"proxy-authorization",
	"openai-api-key",
	"x-veyyon-auth-token",
	"x-access-token",
	"anthropic-secret",
	"cookie",
	"set-cookie",
	"www-authenticate",
	"content-type",
	"user-agent",
	"anthropic-version",
	"x-request-id",
];

function payloadFor(headers: Record<string, string>): RawHttpRequestDump & { errorResponse: unknown } {
	const dump: RawHttpRequestDump = {
		provider: "google",
		api: "google-genai",
		model: "gemini-2.5-pro",
		method: "POST",
		url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent",
		headers,
		body: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
	};
	return buildHttp400DumpPayload(dump, new Error("bad request"), "400 status code");
}

describe("a persisted 400 dump", () => {
	it("redacts the Google key header that the exact-match list missed", () => {
		const payload = payloadFor({ "x-goog-api-key": SECRET });

		expect(payload.headers?.["x-goog-api-key"]).toBe("[redacted]");
	});

	it("agrees with the sibling dump path on every header spelling", () => {
		const headers: Record<string, string> = {};
		for (const name of HEADER_SPELLINGS) {
			headers[name] = SECRET;
		}

		const payload = payloadFor(headers);

		const disagreed: string[] = [];
		for (const name of HEADER_SPELLINGS) {
			const redactedHere = payload.headers?.[name] === "[redacted]";
			if (redactedHere !== isCredentialHeaderName(name)) {
				disagreed.push(name);
			}
		}
		expect(disagreed).toEqual([]);
	});

	it("leaves the key nowhere in the serialized file, not only in the header it came from", () => {
		const payload = payloadFor({ "x-goog-api-key": SECRET, authorization: `Bearer ${SECRET}` });

		expect(JSON.stringify(payload)).not.toContain(SECRET);
	});

	it("still records the protocol headers and the body verbatim", () => {
		const payload = payloadFor({ "x-goog-api-key": SECRET, "content-type": "application/json" });

		expect(payload.headers?.["content-type"]).toBe("application/json");
		expect(payload.body).toEqual({ contents: [{ role: "user", parts: [{ text: "hello" }] }] });
		expect(payload.provider).toBe("google");
	});

	it("keeps a request that carries no headers at all dumpable", () => {
		const payload = payloadFor({});

		expect(payload.headers).toEqual({});
		expect(payload.model).toBe("gemini-2.5-pro");
	});
});
