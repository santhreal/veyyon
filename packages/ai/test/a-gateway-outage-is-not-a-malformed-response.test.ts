/**
 * Contract: a failed HTTP response is reported by its status, not by the shape of the body it
 * could not deliver.
 *
 * WHY THIS EXISTS. Every Nous Portal call parses the response body before it looks at
 * `response.ok`, because a Portal error arrives as a JSON `error` field on a 4xx and the code
 * wants that field. A gateway in front of the Portal does not play along: a 502, 503 or 504 from
 * Cloudflare or nginx answers with an HTML page, `response.json()` rejects on the first `<`, and
 * the operator was told the Portal "returned invalid JSON" -- kind `validation`, no status, cause
 * a JSON syntax error. That describes a malformed reply from a service that was never reached, and
 * it sends the reader to look at their own request. The Portal being down is what happened.
 *
 * THE CLASS, not the incident: the sweep runs every gateway status over every unparseable body
 * shape an intermediary actually returns -- an HTML error page, a bare proxy line, an empty body --
 * and requires the status in all of them. Fixing only the 502-with-HTML case would leave the 503
 * with an empty body reported as a validation failure.
 *
 * WHAT IT DOES NOT CATCH: a 200 carrying HTML, which is a real malformed reply and is still
 * reported as one. That case is pinned below so the fix cannot be read as "stop reporting parse
 * failures".
 */

import { describe, expect, it } from "bun:test";
import * as AIError from "@veyyon/ai/error";
import { refreshNousResearchToken } from "@veyyon/ai/registry/oauth/nous-research";

/** Bodies an intermediary returns instead of the Portal's JSON. */
const UNPARSEABLE_BODIES: ReadonlyArray<readonly [string, string]> = [
	["cloudflare html", "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head></html>"],
	["nginx html", "<html><body><center><h1>504 Gateway Time-out</h1></center></body></html>"],
	["bare proxy line", "upstream connect error or disconnect/reset before headers"],
	["empty body", ""],
];

/** Statuses an intermediary answers with when the Portal is unreachable. */
const GATEWAY_STATUSES = [500, 502, 503, 504] as const;

const CREDENTIALS = {
	type: "oauth",
	access: "access-token",
	refresh: "refresh-token",
	expires: Date.now() + 60_000,
} as const;

function respondingWith(status: number, body: string, statusText = ""): typeof fetch {
	return (async () => new Response(body, { status, statusText })) as unknown as typeof fetch;
}

describe("a refresh that never reached the Portal reports the gateway", () => {
	const cases: Array<[string, string, number]> = UNPARSEABLE_BODIES.flatMap(([label, body]) =>
		GATEWAY_STATUSES.map((status): [string, string, number] => [`${label} @ ${status}`, body, status]),
	);

	it.each(cases)("reports %s by its status", async (_label, body, status) => {
		const failure = await refreshNousResearchToken(CREDENTIALS, respondingWith(status, body)).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(AIError.OAuthError);
		const oauth = failure as AIError.OAuthError;
		expect(oauth.status).toBe(status);
		expect(oauth.kind).toBe("http");
		expect(oauth.message).toContain(String(status));
		expect(oauth.message).not.toContain("invalid JSON");
	});

	it("keeps the parse failure as the cause rather than discarding it", () => {
		// The status is what happened; the parse failure is still how it was noticed, and a
		// reader chasing a body that looked like JSON needs it.
		return refreshNousResearchToken(CREDENTIALS, respondingWith(502, "<html></html>")).then(
			() => {
				throw new Error("expected a rejection");
			},
			(error: unknown) => {
				expect((error as AIError.OAuthError).cause).toBeDefined();
			},
		);
	});

	it("names the reason phrase when the intermediary sent one", async () => {
		const failure = await refreshNousResearchToken(
			CREDENTIALS,
			respondingWith(503, "<html></html>", "Service Unavailable"),
		).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect((failure as AIError.OAuthError).message).toContain("Service Unavailable");
	});
});

describe("a malformed reply from a reachable Portal is still malformed", () => {
	it("reports a 200 carrying HTML as a validation failure", async () => {
		// Non-vacuity, and the boundary the fix must not cross. The Portal answered; what it
		// said is unusable. That is the operator's request or the Portal's contract, and it
		// stays kind `validation`.
		const failure = await refreshNousResearchToken(CREDENTIALS, respondingWith(200, "<html>not json</html>")).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(AIError.OAuthError);
		const oauth = failure as AIError.OAuthError;
		expect(oauth.kind).toBe("validation");
		expect(oauth.message).toContain("invalid JSON");
	});

	it("reports a Portal error that DID arrive as JSON by its own detail", async () => {
		// The path the parse-before-ok ordering exists to serve, unchanged.
		const body = JSON.stringify({ error: "invalid_grant", error_description: "refresh token expired" });
		const failure = await refreshNousResearchToken(CREDENTIALS, respondingWith(400, body)).then(
			() => undefined,
			(error: unknown) => error,
		);

		const oauth = failure as AIError.OAuthError;
		expect(oauth.message).toContain("400");
		expect(oauth.message).toContain("invalid_grant");
	});
});
