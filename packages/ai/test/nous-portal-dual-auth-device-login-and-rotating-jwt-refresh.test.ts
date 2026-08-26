/**
 * WHY: Nous Research provides dual authentication pathways to the same product:
 * 1. An API-key login validated against the inference models endpoint (https://inference-api.nousresearch.com/v1/models).
 * 2. An OAuth device-code flow issuing short-lived inference JWTs and rotating refresh tokens.
 *
 * This suite defends:
 * - The API-key login flow: prompt, masked paste, validation against models endpoint, error mapping,
 *   and storage under the product id 'nous-research' (via storeCredentialsAs).
 * - The OAuth device-code flow: device authorization request, polling state transitions
 *   (pending -> slow_down -> complete), inference JWT scope validation, and expiry skew calculation.
 * - Credential storage: all credentials (both API key and OAuth) are filed under the product
 *   'nous-research', ensuring downstream consumers (model manager, account card) find them.
 * - JWT re-exchange lifecycle in AuthStorage: when a short-lived JWT expires, AuthStorage
 *   automatically executes a refresh request with the rotating refresh token (via x-nous-refresh-token header),
 *   persists the rotated refresh token and new JWT, and returns the active JWT.
 * - Failure paths: rejected refresh token (invalid_grant, refresh_token_reused) surfaces as an OAuthError
 *   and triggers proper credential disablement/failure in AuthStorage.
 * - Loop termination and bounds: device polling terminates on deadline expiry or signal cancellation with
 *   counted attempt verification; concurrent refreshes for the same expired credential are deduplicated
 *   so rotating single-use tokens are never double-spent.
 *
 * WHAT IT DOES NOT CATCH: Live cryptographic signature verification of Portal JWTs or live network availability.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import * as AIError from "@veyyon/ai/error";
import {
	loginNousResearch,
	NOUS_DEVICE_CODE_URL,
	NOUS_INFERENCE_SCOPE,
	NOUS_TOKEN_URL,
	refreshNousResearchToken,
} from "@veyyon/ai/oauth/nous-research";
import { PROVIDER_REGISTRY } from "@veyyon/ai/registry";
import { nousResearchProvider } from "@veyyon/ai/registry/nous-research";
import { loginNousResearchApiKey, nousResearchApiKeyProvider } from "@veyyon/ai/registry/nous-research-api-key";
import type {
	OAuthAuthInfo,
	OAuthCredentials,
	OAuthLoginCallbacks,
	OAuthPrompt,
} from "@veyyon/ai/registry/oauth/types";
import type { FetchImpl } from "@veyyon/ai/types";

interface CapturedRequest {
	url: string;
	method?: string;
	headers: Record<string, string>;
	body?: string;
}

function createInferenceJwt(expiresAtSeconds: number, scope: unknown = NOUS_INFERENCE_SCOPE): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({ exp: expiresAtSeconds, scope })).toString("base64url");
	return `${header}.${payload}.signature`;
}

function createFetchStub(handler: (request: CapturedRequest) => Response | Promise<Response>): {
	fetch: FetchImpl;
	requests: CapturedRequest[];
} {
	const requests: CapturedRequest[] = [];
	const fetchStub: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const headersRecord: Record<string, string> = {};
		if (init?.headers) {
			const headers = new Headers(init.headers);
			headers.forEach((value, key) => {
				headersRecord[key.toLowerCase()] = value;
			});
		}
		const captured: CapturedRequest = {
			url,
			method: init?.method ?? "GET",
			headers: headersRecord,
			body: init?.body !== undefined ? String(init.body) : undefined,
		};
		requests.push(captured);
		return handler(captured);
	};
	return { fetch: fetchStub, requests };
}

describe("Nous Research dual authentication and rotating JWT refresh lifecycle", () => {
	let store: SqliteAuthCredentialStore | null = null;
	let storage: AuthStorage | null = null;
	let db: Database | null = null;

	beforeEach(async () => {
		db = new Database(":memory:");
		store = new SqliteAuthCredentialStore(db);
		storage = new AuthStorage(store);
		await storage.reload();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		storage = null;
		db = null;
	});

	describe("Pathway 1: Nous Research Portal API key login", () => {
		it("validates API key with GET against the models endpoint", async () => {
			const { fetch, requests } = createFetchStub(() => Response.json({ data: [{ id: "nous-hermes-3" }] }));

			const authInfoList: OAuthAuthInfo[] = [];
			const promptCalls: OAuthPrompt[] = [];

			const key = await loginNousResearchApiKey({
				onAuth: info => authInfoList.push(info),
				onPrompt: async prompt => {
					promptCalls.push(prompt);
					return "  sk-nous-portal-key-123  ";
				},
				fetch,
			});

			expect(key).toBe("sk-nous-portal-key-123");
			expect(authInfoList).toEqual([
				{
					url: "https://portal.nousresearch.com/api-keys",
					instructions: "Create or copy an API key from the Nous Research Portal",
				},
			]);
			expect(promptCalls).toEqual([
				{
					message: "Paste your Nous Research API key",
					placeholder: "sk-...",
					secret: true,
				},
			]);

			expect(requests).toHaveLength(1);
			const req = requests[0];
			expect(req?.url).toBe("https://inference-api.nousresearch.com/v1/models");
			expect(req?.method).toBe("GET");
			expect(req?.headers.authorization).toBe("Bearer sk-nous-portal-key-123");
		});

		it("surfaces validation refusal from models endpoint as ApiKeyRequiredError", async () => {
			const { fetch } = createFetchStub(() =>
				Response.json({ error: { message: "Invalid API key provided for Nous Portal" } }, { status: 401 }),
			);

			await expect(
				loginNousResearchApiKey({
					onPrompt: async () => "sk-bad-key",
					fetch,
				}),
			).rejects.toThrow("nous-research API key validation failed (401): Invalid API key provided for Nous Portal");
		});

		it("stores the pasted API key under the product 'nous-research' in AuthStorage", async () => {
			if (!storage || !db) throw new Error("test setup failed");

			const { fetch } = createFetchStub(() => Response.json({ data: [{ id: "nous-hermes-3" }] }));

			const callbacks: OAuthLoginCallbacks = {
				onAuth: () => {},
				onPrompt: async () => "sk-nous-portal-pasted",
				fetch,
			};

			await storage.login("nous-research-api-key" as Parameters<AuthStorage["login"]>[0], callbacks);

			const resolvedKey = await storage.getApiKey("nous-research", "session-test");
			expect(resolvedKey).toBe("sk-nous-portal-pasted");

			const rows = db.prepare("SELECT provider, credential_type FROM auth_credentials").all() as Array<{
				provider: string;
				credential_type: string;
			}>;
			expect(rows).toEqual([{ provider: "nous-research", credential_type: "api_key" }]);

			expect(nousResearchApiKeyProvider.storeCredentialsAs).toBe("nous-research");
		});
	});

	describe("Pathway 2: Nous Research OAuth device-code flow & JWT exchange", () => {
		it("drives full state transitions: device-code -> pending -> slow_down -> complete", async () => {
			const sleepTimes: number[] = [];
			vi.spyOn(Bun, "sleep").mockImplementation(async (ms: number | Date) => {
				sleepTimes.push(typeof ms === "number" ? ms : ms.getTime() - Date.now());
			});

			const nowSeconds = Math.floor(Date.now() / 1000);
			const expectedJwt = createInferenceJwt(nowSeconds + 3600);

			let pollCount = 0;
			const { fetch, requests } = createFetchStub(req => {
				if (req.url === NOUS_DEVICE_CODE_URL) {
					return Response.json({
						device_code: "dev-code-xyz",
						user_code: "NOUS-1234",
						verification_uri: "https://portal.nousresearch.com/device",
						verification_uri_complete: "https://portal.nousresearch.com/device?user_code=NOUS-1234",
						expires_in: 300,
						interval: 1,
					});
				}
				if (req.url === NOUS_TOKEN_URL) {
					pollCount += 1;
					if (pollCount === 1) {
						return Response.json({ error: "authorization_pending" }, { status: 400 });
					}
					if (pollCount === 2) {
						return Response.json({ error: "slow_down" }, { status: 400 });
					}
					return Response.json({
						access_token: expectedJwt,
						refresh_token: "rt-initial-token",
						expires_in: 3600,
						scope: "inference:invoke",
					});
				}
				return Response.json({ error: "not_found" }, { status: 404 });
			});

			const authEvents: OAuthAuthInfo[] = [];
			const credentials = await loginNousResearch({
				onAuth: info => authEvents.push(info),
				fetch,
			});

			expect(pollCount).toBe(3);
			expect(credentials.access).toBe(expectedJwt);
			expect(credentials.refresh).toBe("rt-initial-token");
			expect(credentials.expires).toBe((nowSeconds + 3600) * 1000 - 120_000);

			expect(authEvents).toHaveLength(1);
			expect(authEvents[0]?.url).toBe("https://portal.nousresearch.com/device?user_code=NOUS-1234");
			expect(authEvents[0]?.instructions).toContain("NOUS-1234");

			expect(sleepTimes).toEqual([1000, 6000]);

			expect(requests[0]?.url).toBe(NOUS_DEVICE_CODE_URL);
			expect(requests[0]?.method).toBe("POST");
			const deviceParams = new URLSearchParams(requests[0]?.body);
			expect(deviceParams.get("client_id")).toBe("hermes-cli");
			expect(deviceParams.get("scope")).toBe("inference:invoke");

			for (let i = 1; i <= 3; i++) {
				expect(requests[i]?.url).toBe(NOUS_TOKEN_URL);
				expect(requests[i]?.method).toBe("POST");
				const tokenParams = new URLSearchParams(requests[i]?.body);
				expect(tokenParams.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
				expect(tokenParams.get("client_id")).toBe("hermes-cli");
				expect(tokenParams.get("device_code")).toBe("dev-code-xyz");
			}
		});

		it("rejects access tokens without the inference:invoke scope", async () => {
			const nowSeconds = Math.floor(Date.now() / 1000);
			const badScopeJwt = createInferenceJwt(nowSeconds + 3600, "user:profile");

			const { fetch } = createFetchStub(req => {
				if (req.url === NOUS_DEVICE_CODE_URL) {
					return Response.json({
						device_code: "dev-code-bad-scope",
						user_code: "NOUS-BAD",
						verification_uri: "https://portal.nousresearch.com/device",
						expires_in: 300,
						interval: 1,
					});
				}
				return Response.json({
					access_token: badScopeJwt,
					refresh_token: "rt-bad-scope",
					expires_in: 3600,
					scope: "user:profile",
				});
			});

			await expect(
				loginNousResearch({
					onAuth: () => {},
					fetch,
				}),
			).rejects.toThrow("missing inference:invoke scope");
		});

		it("stores OAuth credentials under 'nous-research' in AuthStorage", async () => {
			if (!storage || !db) throw new Error("test setup failed");

			const nowSeconds = Math.floor(Date.now() / 1000);
			const validJwt = createInferenceJwt(nowSeconds + 3600);

			const { fetch } = createFetchStub(req => {
				if (req.url === NOUS_DEVICE_CODE_URL) {
					return Response.json({
						device_code: "dev-code-oauth",
						user_code: "NOUS-OAUTH",
						verification_uri: "https://portal.nousresearch.com/device",
						expires_in: 300,
						interval: 1,
					});
				}
				return Response.json({
					access_token: validJwt,
					refresh_token: "rt-stored-token",
					expires_in: 3600,
					scope: "inference:invoke",
				});
			});

			const callbacks: OAuthLoginCallbacks = {
				onAuth: () => {},
				onPrompt: async () => "",
				fetch,
			};

			await storage.login("nous-research" as Parameters<AuthStorage["login"]>[0], callbacks);

			const resolvedKey = await storage.getApiKey("nous-research", "session-oauth");
			expect(resolvedKey).toBe(validJwt);

			const rows = db.prepare("SELECT provider, credential_type FROM auth_credentials").all() as Array<{
				provider: string;
				credential_type: string;
			}>;
			expect(rows).toEqual([{ provider: "nous-research", credential_type: "oauth" }]);
		});
	});

	describe("JWT Re-Exchange and Refresh Token Rotation in AuthStorage", () => {
		it("returns cached JWT when valid, and automatically re-exchanges via refresh token when expired", async () => {
			if (!storage || !db || !store) throw new Error("test setup failed");

			const initialExp = Math.floor(Date.now() / 1000) - 100;
			const expiredJwt = createInferenceJwt(initialExp);

			const nextExp = Math.floor(Date.now() / 1000) + 3600;
			const freshJwt = createInferenceJwt(nextExp);

			let refreshCount = 0;
			const capturedRefreshRequests: CapturedRequest[] = [];

			vi.spyOn(globalThis, "fetch").mockImplementation((async (
				input: string | URL | Request,
				init?: RequestInit,
			) => {
				const url = String(input);
				const headersRecord: Record<string, string> = {};
				if (init?.headers) {
					const headers = new Headers(init.headers);
					headers.forEach((value, key) => {
						headersRecord[key.toLowerCase()] = value;
					});
				}
				capturedRefreshRequests.push({
					url,
					method: init?.method ?? "GET",
					headers: headersRecord,
					body: init?.body !== undefined ? String(init.body) : undefined,
				});
				refreshCount += 1;
				return Response.json({
					access_token: freshJwt,
					refresh_token: "rt-rotated-token-2",
					expires_in: 3600,
					scope: "inference:invoke",
				});
			}) as typeof fetch);

			const initialCreds: OAuthCredentials = {
				access: expiredJwt,
				refresh: "rt-initial-token-1",
				expires: initialExp * 1000 - 120_000,
			};
			store.saveOAuth("nous-research", initialCreds);
			await storage.reload();
			const resolvedKey = await storage.getApiKey("nous-research", "session-refresh");
			expect(resolvedKey).toBe(freshJwt);
			expect(refreshCount).toBe(1);

			expect(capturedRefreshRequests).toHaveLength(1);
			const refreshReq = capturedRefreshRequests[0];
			expect(refreshReq?.url).toBe(NOUS_TOKEN_URL);
			expect(refreshReq?.headers["x-nous-refresh-token"]).toBe("rt-initial-token-1");
			expect(refreshReq?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
			const refreshBody = new URLSearchParams(refreshReq?.body);
			expect(refreshBody.get("grant_type")).toBe("refresh_token");
			expect(refreshBody.get("client_id")).toBe("hermes-cli");

			const updatedRows = db
				.prepare("SELECT data FROM auth_credentials WHERE provider = 'nous-research'")
				.all() as Array<{
				data: string;
			}>;
			expect(updatedRows).toHaveLength(1);
			const storedData = JSON.parse(updatedRows[0]?.data ?? "{}") as OAuthCredentials;
			expect(storedData.access).toBe(freshJwt);
			expect(storedData.refresh).toBe("rt-rotated-token-2");
			expect(storedData.expires).toBe(nextExp * 1000 - 120_000);

			const secondResolveKey = await storage.getApiKey("nous-research", "session-refresh");
			expect(secondResolveKey).toBe(freshJwt);
			expect(refreshCount).toBe(1);
		});
		it("handles rejected refresh token with OAuthError and disables invalid credential in AuthStorage", async () => {
			if (!storage || !db || !store) throw new Error("test setup failed");

			const expiredJwt = createInferenceJwt(Math.floor(Date.now() / 1000) - 500);
			const fetchStub: FetchImpl = async () =>
				Response.json(
					{
						error: "invalid_grant",
						error_description: "Refresh token has been revoked or expired",
					},
					{ status: 400 },
				);

			vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub as typeof fetch);

			const revokedCreds: OAuthCredentials = {
				access: expiredJwt,
				refresh: "rt-revoked-token",
				expires: Date.now() - 500_000,
			};

			// Direct refresh call surfaces the exact OAuthError contract with provider details
			await expect(refreshNousResearchToken(revokedCreds, fetchStub)).rejects.toThrow(
				"Nous Portal token refresh failed: 400: invalid_grant: Refresh token has been revoked or expired",
			);

			// In AuthStorage, a definitive failure disables the stored row and returns undefined
			store.saveOAuth("nous-research", revokedCreds);
			await storage.reload();

			const resolved = await storage.getApiKey("nous-research", "session-fail");
			expect(resolved).toBeUndefined();

			const rows = db
				.prepare("SELECT disabled_cause FROM auth_credentials WHERE provider = 'nous-research'")
				.all() as Array<{
				disabled_cause: string | null;
			}>;
			expect(rows).toHaveLength(1);
			expect(rows[0]?.disabled_cause).toContain("invalid_grant");
		});
	});

	describe("Bounds, Loop Termination, and Deduplication", () => {
		it("terminates polling when the device code expires after bounded attempts", async () => {
			vi.spyOn(Bun, "sleep").mockImplementation(async () => {});

			let attempts = 0;
			const { fetch } = createFetchStub(req => {
				if (req.url === NOUS_DEVICE_CODE_URL) {
					return Response.json({
						device_code: "dev-timeout",
						user_code: "NOUS-TIME",
						verification_uri: "https://portal.nousresearch.com/device",
						expires_in: 3,
						interval: 1,
					});
				}
				attempts += 1;
				return Response.json({ error: "authorization_pending" }, { status: 400 });
			});

			const startTime = Date.now();
			let nowOffset = 0;
			vi.spyOn(Date, "now").mockImplementation(() => {
				nowOffset += 1200;
				return startTime + nowOffset;
			});

			await expect(
				loginNousResearch({
					onAuth: () => {},
					fetch,
				}),
			).rejects.toThrow("Device flow timed out");

			expect(attempts).toBeGreaterThanOrEqual(1);
			expect(attempts).toBeLessThanOrEqual(5);
		});

		it("terminates device polling immediately when signal is aborted", async () => {
			const controller = new AbortController();
			let attempts = 0;

			const { fetch } = createFetchStub(req => {
				if (req.url === NOUS_DEVICE_CODE_URL) {
					return Response.json({
						device_code: "dev-abort",
						user_code: "NOUS-ABORT",
						verification_uri: "https://portal.nousresearch.com/device",
						expires_in: 300,
						interval: 1,
					});
				}
				attempts += 1;
				controller.abort();
				return Response.json({ error: "authorization_pending" }, { status: 400 });
			});

			await expect(
				loginNousResearch({
					onAuth: () => {},
					fetch,
					signal: controller.signal,
				}),
			).rejects.toBeInstanceOf(AIError.LoginCancelledError);

			expect(attempts).toBe(1);
		});

		it("deduplicates concurrent refresh requests for the same expired credential to prevent token burn", async () => {
			if (!storage || !db || !store) throw new Error("test setup failed");

			const expiredJwt = createInferenceJwt(Math.floor(Date.now() / 1000) - 100);
			const freshJwt = createInferenceJwt(Math.floor(Date.now() / 1000) + 3600);

			let refreshNetworkCalls = 0;
			const { promise: slowRefresh, resolve: completeRefresh } = Promise.withResolvers<Response>();

			vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
				refreshNetworkCalls += 1;
				return slowRefresh;
			}) as unknown as typeof fetch);

			const creds: OAuthCredentials = {
				access: expiredJwt,
				refresh: "rt-single-use-token",
				expires: Date.now() - 100_000,
			};
			store.saveOAuth("nous-research", creds);
			await storage.reload();
			const request1 = storage.getApiKey("nous-research", "session-c1");
			const request2 = storage.getApiKey("nous-research", "session-c2");
			const request3 = storage.getApiKey("nous-research", "session-c3");

			completeRefresh(
				Response.json({
					access_token: freshJwt,
					refresh_token: "rt-rotated-token-fresh",
					expires_in: 3600,
					scope: "inference:invoke",
				}),
			);

			const [key1, key2, key3] = await Promise.all([request1, request2, request3]);

			expect(key1).toBe(freshJwt);
			expect(key2).toBe(freshJwt);
			expect(key3).toBe(freshJwt);
			expect(refreshNetworkCalls).toBe(1);
		});
	});

	describe("Provider Definition contract integrity", () => {
		it("registers both nous-research and nous-research-api-key in PROVIDER_REGISTRY", () => {
			const oauthEntry = PROVIDER_REGISTRY.find(p => p.id === "nous-research");
			expect(oauthEntry).toBeDefined();
			expect(oauthEntry?.name).toBe("Nous Research");
			expect(oauthEntry?.login).toBe(nousResearchProvider.login);
			expect(oauthEntry?.refreshToken).toBe(refreshNousResearchToken);
			expect(oauthEntry?.storeCredentialsAs).toBeUndefined();

			const apiKeyEntry = PROVIDER_REGISTRY.find(p => p.id === "nous-research-api-key");
			expect(apiKeyEntry).toBeDefined();
			expect(apiKeyEntry?.name).toBe("Nous Research (API key)");
			expect(apiKeyEntry?.login).toBe(loginNousResearchApiKey);
			expect(apiKeyEntry?.storeCredentialsAs).toBe("nous-research");
		});
	});
});
