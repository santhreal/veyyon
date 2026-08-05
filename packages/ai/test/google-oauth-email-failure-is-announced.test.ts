/**
 * Locks out the bare `catch {}` in `getUserEmail`
 * (`registry/oauth/google-oauth-shared.ts`), whose comment read "Ignore errors,
 * email is optional".
 *
 * The email is optional to the login and is NOT optional to the operator: it is
 * how the account picker names the credential that was just stored. Discarding
 * the failure produced an unlabelled Google account with no recorded reason, and
 * a second sign-in produced a second unlabelled account indistinguishable from
 * the first. A refused userinfo call (an expired scope, a blocked host, a proxy)
 * left nothing behind to explain it.
 *
 * The login must still succeed without an email, so the fix is a warning and not
 * a throw. If this regresses, unlabelled accounts come back with no diagnosis.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { GoogleOAuthFlow } from "@veyyon/ai/registry/oauth/google-oauth-shared";
import type { OAuthController } from "@veyyon/ai/registry/oauth/types";
import * as logger from "@veyyon/utils/logger";

const TOKEN_URL = "https://oauth.test.invalid/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo";

let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

function makeFlow(): GoogleOAuthFlow {
	return new GoogleOAuthFlow({ onProgress: () => {} } as unknown as OAuthController, {
		clientId: "client",
		clientSecret: "secret",
		authUrl: "https://oauth.test.invalid/auth",
		tokenUrl: TOKEN_URL,
		scopes: ["email"],
		callbackPort: 0,
		callbackPath: "/callback",
		discoverProject: async () => "project-1",
	});
}

/**
 * Answer the token endpoint with a usable credential and hand the userinfo call
 * to `userinfo`, which is what each test varies.
 */
function stubFetch(userinfo: (url: string) => Promise<Response>): void {
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | { url: string }) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.startsWith(TOKEN_URL)) {
			return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
		}
		if (url.startsWith(USERINFO_URL)) return await userinfo(url);
		throw new Error(`unexpected fetch: ${url}`);
	}) as typeof fetch);
}

beforeEach(() => {
	warnings = [];
	vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
		warnings.push({ message, fields: fields ?? {} });
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("A Google account email lookup that fails is reported", () => {
	test("warns with the reason when the userinfo request throws", async () => {
		stubFetch(async () => {
			throw new Error("getaddrinfo ENOTFOUND www.googleapis.com");
		});

		const credentials = await makeFlow().exchangeToken("code", "state", "https://localhost/callback");

		// The login still completes, which is why this must not become a throw.
		expect(credentials.refresh).toBe("rt");
		expect(credentials.email).toBeUndefined();
		const reported = warnings.filter(w => w.message.includes("Google account email lookup failed"));
		expect(reported).toHaveLength(1);
		expect(reported[0]?.message).toContain("without an account label");
		expect(String(reported[0]?.fields.error)).toContain("ENOTFOUND");
	});

	/**
	 * A non-ok response never entered the catch at all: it fell straight to
	 * `return undefined`, so it was even quieter than the throwing case.
	 */
	test("warns with the status when the userinfo request is refused", async () => {
		stubFetch(async () => new Response("insufficient scope", { status: 403 }));

		const credentials = await makeFlow().exchangeToken("code", "state", "https://localhost/callback");

		expect(credentials.email).toBeUndefined();
		const reported = warnings.filter(w => w.message.includes("Google account email lookup was refused"));
		expect(reported).toHaveLength(1);
		expect(reported[0]?.fields.status).toBe(403);
	});

	/** A successful lookup must stay silent and must still label the account. */
	test("says nothing when the email comes back", async () => {
		stubFetch(async () => Response.json({ email: "operator@example.com" }));

		const credentials = await makeFlow().exchangeToken("code", "state", "https://localhost/callback");

		expect(credentials.email).toBe("operator@example.com");
		expect(warnings.filter(w => w.message.includes("Google account email lookup"))).toEqual([]);
	});
});
