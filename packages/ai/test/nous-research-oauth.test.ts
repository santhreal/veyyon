/**
 * WHY: Nous Portal credentials are rotating OAuth grants, not pasted API keys. This suite drives the
 * registry flow across the official device-code and refresh endpoints so a key-paste regression,
 * a wrong form/header contract, a stale refresh token, or an unusable inference JWT fails here.
 * It does not contact the live Portal or verify the JWT signature; the Portal is the mocked external boundary.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import { loginNousResearch, NOUS_DEVICE_CODE_URL, NOUS_TOKEN_URL } from "@veyyon/ai/oauth/nous-research";
import { getOAuthApiKey, getOAuthProviders, PROVIDER_REGISTRY, refreshOAuthToken } from "@veyyon/ai/registry";
import type { OAuthAuthInfo, OAuthCredentials, OAuthLoginCallbacks } from "@veyyon/ai/registry/oauth/types";
import type { FetchImpl } from "@veyyon/ai/types";

type CapturedRequest = {
	url: string;
	init?: RequestInit;
};

function inferenceJwt(expiresAtSeconds: number, scope: unknown = "inference:invoke"): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({ exp: expiresAtSeconds, scope })).toString("base64url");
	return `${header}.${payload}.signature`;
}

function providerDefinition() {
	const definition = PROVIDER_REGISTRY.find(provider => provider.id === "nous-research");
	if (!definition) throw new Error("nous-research is missing from PROVIDER_REGISTRY");
	return definition;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Nous Portal OAuth", () => {
	test("uses the official device grant and correlates polling without browser PKCE parameters", async () => {
		const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600;
		const accessToken = inferenceJwt(expiresAtSeconds);
		const requests: CapturedRequest[] = [];
		const authEvents: OAuthAuthInfo[] = [];
		const fetchStub: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(input), init });
			if (String(input) === NOUS_DEVICE_CODE_URL) {
				return Response.json({
					device_code: "device-secret",
					user_code: "ABCD-EFGH",
					verification_uri: "https://portal.nousresearch.com/device",
					verification_uri_complete: "https://portal.nousresearch.com/device?user_code=ABCD-EFGH",
					expires_in: 600,
					interval: 1,
				});
			}
			return Response.json({
				access_token: accessToken,
				refresh_token: "refresh-one",
				expires_in: 3600,
				scope: "inference:invoke",
				token_type: "Bearer",
			});
		});
		const callbacks: OAuthLoginCallbacks = {
			onAuth: info => authEvents.push(info),
			onPrompt: async () => "",
			fetch: fetchStub,
		};

		const credentials = await providerDefinition().login?.(callbacks);
		if (!credentials || typeof credentials === "string") throw new Error("expected Nous OAuth credentials");

		expect(requests.map(request => request.url)).toEqual([NOUS_DEVICE_CODE_URL, NOUS_TOKEN_URL]);
		const deviceForm = new URLSearchParams(String(requests[0]?.init?.body));
		expect(Object.fromEntries(deviceForm)).toEqual({ client_id: "hermes-cli", scope: "inference:invoke" });
		expect(deviceForm.has("state")).toBeFalse();
		expect(deviceForm.has("code_challenge")).toBeFalse();
		expect(new Headers(requests[0]?.init?.headers).get("Content-Type")).toBe("application/x-www-form-urlencoded");
		const tokenForm = new URLSearchParams(String(requests[1]?.init?.body));
		expect(Object.fromEntries(tokenForm)).toEqual({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			client_id: "hermes-cli",
			device_code: "device-secret",
		});
		expect(authEvents).toHaveLength(1);
		expect(authEvents[0]?.url).toBe("https://portal.nousresearch.com/device?user_code=ABCD-EFGH");
		expect(authEvents[0]?.instructions).toContain("ABCD-EFGH");
		expect(authEvents[0]?.instructions).toContain("headless/remote session");
		expect(credentials).toEqual({
			access: accessToken,
			refresh: "refresh-one",
			expires: expiresAtSeconds * 1000 - 120_000,
		});
	});

	test("fails before requesting a device code when browser and headless URL output is unavailable", async () => {
		const fetchStub: FetchImpl = vi.fn(async () => Response.json({}));
		await expect(loginNousResearch({ fetch: fetchStub })).rejects.toThrow("requires an onAuth callback");
		expect(fetchStub).not.toHaveBeenCalled();
	});

	test("refreshes through the derived registry, persists the rotated token shape, and sends the refresh header", async () => {
		const expiresAtSeconds = Math.floor(Date.now() / 1000) + 7200;
		const nextAccess = inferenceJwt(expiresAtSeconds, ["profile", "inference:invoke"]);
		const requests: CapturedRequest[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(input), init });
			return Response.json({
				access_token: nextAccess,
				refresh_token: "refresh-rotated",
				expires_in: 7200,
				scope: "inference:invoke",
			});
		}) as typeof fetch);
		const previous: OAuthCredentials = {
			access: inferenceJwt(Math.floor(Date.now() / 1000) - 60),
			refresh: "refresh-original",
			expires: Date.now() - 60_000,
		};

		const refreshed = await refreshOAuthToken("nous-research", previous);

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(NOUS_TOKEN_URL);
		expect(new Headers(requests[0]?.init?.headers).get("x-nous-refresh-token")).toBe("refresh-original");
		expect(new Headers(requests[0]?.init?.headers).get("Content-Type")).toBe("application/x-www-form-urlencoded");
		expect(Object.fromEntries(new URLSearchParams(String(requests[0]?.init?.body)))).toEqual({
			grant_type: "refresh_token",
			client_id: "hermes-cli",
		});
		expect(refreshed).toEqual({
			access: nextAccess,
			refresh: "refresh-rotated",
			expires: expiresAtSeconds * 1000 - 120_000,
		});
	});

	test("rejects an expired inference JWT instead of storing it", async () => {
		const fetchStub: FetchImpl = vi.fn(async (input: string | URL | Request) => {
			if (String(input) === NOUS_DEVICE_CODE_URL) {
				return Response.json({
					device_code: "device-secret",
					user_code: "ABCD-EFGH",
					verification_uri: "https://portal.nousresearch.com/device",
					verification_uri_complete: "https://portal.nousresearch.com/device?user_code=ABCD-EFGH",
					expires_in: 600,
					interval: 1,
				});
			}
			return Response.json({
				access_token: inferenceJwt(Math.floor(Date.now() / 1000) + 60),
				refresh_token: "refresh-one",
				expires_in: 60,
				scope: "inference:invoke",
			});
		});

		await expect(
			loginNousResearch({
				onAuth: () => undefined,
				fetch: fetchStub,
			}),
		).rejects.toThrow("expired or too close to expiry");
	});

	test.each([
		["invalid_grant", "refresh token revoked"],
		["refresh_token_reused", "refresh token reuse detected"],
	] as const)(
		"surfaces a revoked %s refresh grant with the machine-readable OAuth error",
		async (code, description) => {
			vi.spyOn(globalThis, "fetch").mockImplementation((async () =>
				Response.json({ error: code, error_description: description }, { status: 400 })) as typeof fetch);
			const credentials: OAuthCredentials = {
				access: inferenceJwt(Math.floor(Date.now() / 1000) - 60),
				refresh: "revoked-refresh",
				expires: Date.now() - 60_000,
			};

			await expect(refreshOAuthToken("nous-research", credentials)).rejects.toThrow(
				`Nous Portal token refresh failed: 400: ${code}: ${description}`,
			);
		},
	);

	test("is visible in the derived registry and exposes the current access JWT", async () => {
		const definition = providerDefinition();
		expect(getOAuthProviders()).toContainEqual({
			id: "nous-research",
			name: "Nous Research",
			available: true,
			storeCredentialsAs: undefined,
		});
		expect(typeof definition.refreshToken).toBe("function");
		expect(typeof definition.getApiKey).toBe("function");
		const credentials: OAuthCredentials = {
			access: inferenceJwt(Math.floor(Date.now() / 1000) + 3600),
			refresh: "refresh-current",
			expires: Date.now() + 300_000,
		};
		expect(definition.getApiKey?.(credentials)).toBe(credentials.access);
		expect(await getOAuthApiKey("nous-research", { "nous-research": credentials })).toEqual({
			newCredentials: credentials,
			apiKey: credentials.access,
		});
	});
});
