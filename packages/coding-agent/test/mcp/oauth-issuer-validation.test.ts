/**
 * OAuth discovery: an issuer that cannot be verified must be refused, not waved through.
 *
 * WHY THIS SUITE EXISTS. RFC 8414 §3.3 says the `issuer` in an authorization-server metadata
 * document has to match where the document was found. It matters here because a single MCP host can
 * serve TWO metadata documents at different well-known paths (a root issuer and a path-scoped one),
 * and accepting the wrong one routes the grant to the wrong `/authorize` endpoint, which comes back
 * as an opaque `server_error` redirect with nothing pointing at the cause.
 *
 * The check normalized both URLs and compared them, and when either failed to normalize it returned
 * TRUE, accepting the document. That inverts the control exactly where it is needed: a document
 * carrying a junk `issuer` was trusted, while a document carrying a valid but MISMATCHING issuer was
 * rejected. The stricter the server, the more it was checked; a malformed value skipped the check
 * altogether.
 *
 * An unverifiable issuer is now refused. Refusing costs little: discovery simply moves on to the next
 * well-known path, which is what it already does for a mismatch, and reports that it could not
 * determine the auth type if nothing usable turns up. That is the whole point of the fix, so this
 * suite drives the real `discoverOAuthEndpoints` with a stub fetch rather than the private helper:
 * what has to hold is which endpoints come back, not how the comparison is spelled.
 */

import { describe, expect, it } from "bun:test";
import { discoverOAuthEndpoints } from "@veyyon/coding-agent/mcp/oauth-discovery";

/** The endpoints a document has to carry before discovery will accept it at all. */
const ENDPOINTS = {
	authorization_endpoint: "https://auth.example.com/authorize",
	token_endpoint: "https://auth.example.com/token",
};

/** A second, distinct pair, so a test can tell WHICH document was accepted. */
const OTHER_ENDPOINTS = {
	authorization_endpoint: "https://auth.example.com/tenant/authorize",
	token_endpoint: "https://auth.example.com/tenant/token",
};

/**
 * A fetch that answers only the absolute URLs named in `documents` and 404s everything else.
 *
 * Keyed on the FULL url, host included, because discovery probes the same well-known paths on the
 * authorization server AND on the MCP server itself, and the issuer check applies only to the former.
 * A stub keyed on the path alone would serve the refused document again from the fallback host, where
 * it is legitimately accepted, and every refusal test would pass for the wrong reason.
 */
function stubFetch(documents: Record<string, unknown>): {
	fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
	requested: string[];
} {
	const requested: string[] = [];
	return {
		requested,
		fetch: async (url: string | URL | Request) => {
			const href = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			requested.push(href);
			const body = documents[href] ?? documents[href.replace(/\/$/, "")];
			if (body === undefined) return new Response("not found", { status: 404 });
			return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
		},
	};
}

/** The authorization server every test points discovery at. */
const AUTH = "https://auth.example.com";
/** The MCP server, whose own well-known paths are the non-issuer fallback. */
const MCP = "https://mcp.example.com";

describe("an authorization-server document whose issuer matches", () => {
	/** The ordinary accept: same origin, same path, endpoints returned unchanged. */
	it("is used", async () => {
		const stub = stubFetch({
			[`${AUTH}/.well-known/oauth-authorization-server`]: { issuer: "https://auth.example.com", ...ENDPOINTS },
		});

		const found = await discoverOAuthEndpoints(MCP, AUTH, undefined, {
			fetch: stub.fetch,
		});

		expect(found?.authorizationUrl).toBe(ENDPOINTS.authorization_endpoint);
		expect(found?.tokenUrl).toBe(ENDPOINTS.token_endpoint);
	});

	/** A trailing slash is not a mismatch: RFC 8414 comparison normalizes it away. */
	it("is used when the only difference is a trailing slash", async () => {
		const stub = stubFetch({
			[`${AUTH}/.well-known/oauth-authorization-server`]: { issuer: "https://auth.example.com/", ...ENDPOINTS },
		});

		const found = await discoverOAuthEndpoints(MCP, AUTH, undefined, {
			fetch: stub.fetch,
		});

		expect(found?.authorizationUrl).toBe(ENDPOINTS.authorization_endpoint);
	});

	/** A document with no issuer at all keeps today's permissive behaviour, for legacy servers. */
	it("is used when the document carries no issuer", async () => {
		const stub = stubFetch({ [`${AUTH}/.well-known/oauth-authorization-server`]: { ...ENDPOINTS } });

		const found = await discoverOAuthEndpoints(MCP, AUTH, undefined, {
			fetch: stub.fetch,
		});

		expect(found?.authorizationUrl).toBe(ENDPOINTS.authorization_endpoint);
	});
});

describe("an authorization-server document whose issuer does not match", () => {
	/**
	 * The case the check was written for: the document is skipped and discovery keeps probing, so the
	 * endpoints that come back are the ones from a path where the issuer was not required.
	 */
	it("is skipped in favour of a later probe", async () => {
		const stub = stubFetch({
			[`${AUTH}/.well-known/oauth-authorization-server`]: { issuer: "https://elsewhere.example.com", ...ENDPOINTS },
			[`${MCP}/oauth/metadata`]: { ...OTHER_ENDPOINTS },
		});

		const found = await discoverOAuthEndpoints(MCP, AUTH, undefined, {
			fetch: stub.fetch,
		});

		expect(found?.authorizationUrl).toBe(OTHER_ENDPOINTS.authorization_endpoint);
	});

	/** With nothing else on offer, discovery returns null rather than the mismatched document. */
	it("leaves discovery with nothing rather than the wrong endpoints", async () => {
		const stub = stubFetch({
			[`${AUTH}/.well-known/oauth-authorization-server`]: { issuer: "https://elsewhere.example.com", ...ENDPOINTS },
		});

		expect(
			await discoverOAuthEndpoints(MCP, AUTH, undefined, {
				fetch: stub.fetch,
			}),
		).toBeNull();
	});
});

describe("an authorization-server document whose issuer cannot be parsed", () => {
	/**
	 * The regression this suite exists for. `issuer: "not a url"` used to make the comparison return
	 * true, so the document was accepted with LESS scrutiny than a well-formed mismatching one. It must
	 * now be refused exactly like a mismatch, and the later probe's endpoints must be what comes back.
	 */
	it("is skipped, not accepted", async () => {
		const stub = stubFetch({
			[`${AUTH}/.well-known/oauth-authorization-server`]: { issuer: "not a url", ...ENDPOINTS },
			[`${MCP}/oauth/metadata`]: { ...OTHER_ENDPOINTS },
		});

		const found = await discoverOAuthEndpoints(MCP, AUTH, undefined, {
			fetch: stub.fetch,
		});

		expect(found?.authorizationUrl).toBe(OTHER_ENDPOINTS.authorization_endpoint);
		expect(found?.authorizationUrl).not.toBe(ENDPOINTS.authorization_endpoint);
	});

	/**
	 * And with nothing else on offer it yields null. Compare with the "no issuer" case above: an ABSENT
	 * issuer is still permitted, a PRESENT unparseable one is not, which is the distinction the old code
	 * could not draw.
	 */
	it("leaves discovery with nothing when it is the only document", async () => {
		const stub = stubFetch({
			[`${AUTH}/.well-known/oauth-authorization-server`]: { issuer: "not a url", ...ENDPOINTS },
		});

		expect(
			await discoverOAuthEndpoints(MCP, AUTH, undefined, {
				fetch: stub.fetch,
			}),
		).toBeNull();
	});

	/**
	 * A few shapes that look like URLs and are not, each of which used to buy the document a free pass.
	 * They are listed individually because every one of them is something a real gateway has emitted:
	 * an empty-ish value, a bare host with no scheme, and a template that was never substituted.
	 */
	it.each([["issuer.example.com"], ["${ISSUER_URL}"], ["https://"], ["/relative/issuer"]])(
		"refuses the unverifiable issuer %p",
		async issuer => {
			const stub = stubFetch({
				[`${AUTH}/.well-known/oauth-authorization-server`]: { issuer, ...ENDPOINTS },
			});

			const found = await discoverOAuthEndpoints(MCP, AUTH, undefined, {
				fetch: stub.fetch,
			});

			expect(found?.authorizationUrl).not.toBe(ENDPOINTS.authorization_endpoint);
		},
	);
});

describe("the resource-server fallback", () => {
	/**
	 * The issuer check applies only to the two paths that are issuer candidates. A document found on the
	 * MCP server itself is a fallback probe and may legitimately name a cross-host issuer, so it must
	 * still be accepted; otherwise this fix would break every gateway that uses that shape.
	 */
	it("still accepts a cross-host issuer from a non-issuer path", async () => {
		const stub = stubFetch({ [`${MCP}/oauth/metadata`]: { issuer: "https://elsewhere.example.com", ...ENDPOINTS } });

		const found = await discoverOAuthEndpoints(MCP, undefined, undefined, {
			fetch: stub.fetch,
		});

		expect(found?.authorizationUrl).toBe(ENDPOINTS.authorization_endpoint);
	});
});
