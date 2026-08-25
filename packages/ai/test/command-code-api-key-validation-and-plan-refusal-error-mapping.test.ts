/**
 * WHY: Command Code was introduced as an API-key provider requiring validation
 * against its chat completions endpoint (https://api.commandcode.ai/provider/v1/chat/completions)
 * with model moonshotai/Kimi-K2.7-Code.
 *
 * This suite defends:
 * 1. The validation request contract (URL, method, headers, model payload).
 * 2. Error mapping on refusal: HTTP 403 (upgrade required / plan limit), 401 (invalid key),
 *    404 (model/route not found), and 429 (rate limit / wait) must all surface distinct,
 *    meaningful error messages carrying the provider's explanation rather than a generic failure.
 * 3. Interactive login callback contracts (onAuth, onPrompt, secret masking, trim, cancellation).
 * 4. Provider registration and unredirected storage under 'command-code' in AuthStorage.
 *
 * WHAT IT DOES NOT CATCH: Live external network availability of the Command Code API.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import * as AIError from "@veyyon/ai/error";
import { PROVIDER_REGISTRY } from "@veyyon/ai/registry";
import { commandCodeProvider, loginCommandCode } from "@veyyon/ai/registry/command-code";
import type { OAuthAuthInfo, OAuthLoginCallbacks, OAuthPrompt } from "@veyyon/ai/registry/oauth/types";
import type { FetchImpl } from "@veyyon/ai/types";

interface CapturedRequest {
	url: string;
	method?: string;
	headers: Record<string, string>;
	body?: string;
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
			body: typeof init?.body === "string" ? init.body : undefined,
		};
		requests.push(captured);
		return handler(captured);
	};
	return { fetch: fetchStub, requests };
}

describe("Command Code API key validation and error mapping", () => {
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

	it("validates key with POST to chat/completions carrying moonshotai/Kimi-K2.7-Code", async () => {
		const { fetch, requests } = createFetchStub(() =>
			Response.json({
				id: "chatcmpl-test",
				choices: [{ message: { role: "assistant", content: "pong" } }],
			}),
		);

		const authInfoList: OAuthAuthInfo[] = [];
		const promptCalls: OAuthPrompt[] = [];

		const result = await loginCommandCode({
			onAuth: info => authInfoList.push(info),
			onPrompt: async prompt => {
				promptCalls.push(prompt);
				return "  sk-command-secret-123  ";
			},
			fetch,
		});

		expect(result).toBe("sk-command-secret-123");
		expect(authInfoList).toEqual([
			{
				url: "https://commandcode.ai/studio/provider",
				instructions: "Create or copy your API key from Command Code Studio's Provider page",
			},
		]);
		expect(promptCalls).toEqual([
			{
				message: "Paste your Command Code API key",
				placeholder: "sk-...",
				secret: true,
			},
		]);

		expect(requests).toHaveLength(1);
		const req = requests[0];
		expect(req?.url).toBe("https://api.commandcode.ai/provider/v1/chat/completions");
		expect(req?.method).toBe("POST");
		expect(req?.headers["content-type"]).toBe("application/json");
		expect(req?.headers.authorization).toBe("Bearer sk-command-secret-123");

		const parsedBody = JSON.parse(req?.body ?? "{}") as {
			model?: string;
			messages?: Array<{ role: string; content: string }>;
			max_tokens?: number;
			temperature?: number;
		};
		expect(parsedBody.model).toBe("moonshotai/Kimi-K2.7-Code");
		expect(parsedBody.messages).toEqual([{ role: "user", content: "ping" }]);
		expect(parsedBody.max_tokens).toBe(1);
		expect(parsedBody.temperature).toBe(0);
	});

	describe("refusal paths and status distinguishability", () => {
		const scenarios = [
			{
				status: 403,
				name: "403 upgrade_required",
				body: {
					error: {
						message:
							"Your Go plan doesn't include API access. Upgrade to Provider or higher at https://commandcode.ai/billing to use these endpoints.",
						type: "permission_error",
						code: "upgrade_required",
					},
				},
				expectedSubstrings: ["(403)", "Your Go plan doesn't include API access", "https://commandcode.ai/billing"],
			},
			{
				status: 401,
				name: "401 invalid_api_key",
				body: {
					error: {
						message:
							"Incorrect API key provided: sk-inv***123. Check your key at https://commandcode.ai/studio/provider",
						type: "invalid_request_error",
						code: "invalid_api_key",
					},
				},
				expectedSubstrings: ["(401)", "Incorrect API key provided", "https://commandcode.ai/studio/provider"],
			},
			{
				status: 404,
				name: "404 model_not_found",
				body: {
					error: {
						message: "The model 'moonshotai/Kimi-K2.7-Code' does not exist or you do not have access to it.",
						type: "invalid_request_error",
						code: "model_not_found",
					},
				},
				expectedSubstrings: ["(404)", "The model 'moonshotai/Kimi-K2.7-Code' does not exist"],
			},
			{
				status: 429,
				name: "429 rate_limit_exceeded",
				body: {
					error: {
						message: "Rate limit reached for requests. Please wait 5s before retrying.",
						type: "requests",
						code: "rate_limit_exceeded",
					},
				},
				expectedSubstrings: ["(429)", "Rate limit reached for requests", "Please wait 5s"],
			},
		] as const;

		for (const scenario of scenarios) {
			it(`surfaces provider explanation for ${scenario.name}`, async () => {
				const { fetch } = createFetchStub(() => Response.json(scenario.body, { status: scenario.status }));

				const loginPromise = loginCommandCode({
					onPrompt: async () => "sk-test-key",
					fetch,
				});

				await expect(loginPromise).rejects.toBeInstanceOf(AIError.ApiKeyRequiredError);

				let errorMessage = "";
				try {
					await loginPromise;
				} catch (err) {
					errorMessage = (err as Error).message;
				}

				for (const substring of scenario.expectedSubstrings) {
					expect(errorMessage).toContain(substring);
				}
			});
		}

		it("produces distinct, distinguishable error messages across all four status codes", async () => {
			const errorMessages: Record<number, string> = {};

			for (const scenario of scenarios) {
				const { fetch } = createFetchStub(() => Response.json(scenario.body, { status: scenario.status }));

				try {
					await loginCommandCode({
						onPrompt: async () => "sk-test-key",
						fetch,
					});
				} catch (err) {
					errorMessages[scenario.status] = (err as Error).message;
				}
			}

			const statuses = scenarios.map(s => s.status);
			expect(Object.keys(errorMessages).map(Number).sort()).toEqual([...statuses].sort());

			const uniqueMessages = new Set(Object.values(errorMessages));
			expect(uniqueMessages.size).toBe(4);

			expect(errorMessages[403]).toContain("(403)");
			expect(errorMessages[401]).toContain("(401)");
			expect(errorMessages[404]).toContain("(404)");
			expect(errorMessages[429]).toContain("(429)");

			expect(errorMessages[403]).not.toEqual(errorMessages[401]);
			expect(errorMessages[403]).not.toEqual(errorMessages[404]);
			expect(errorMessages[403]).not.toEqual(errorMessages[429]);
			expect(errorMessages[401]).not.toEqual(errorMessages[429]);
		});
	});

	describe("input validation and cancellation contracts", () => {
		it("fails fast with OnPromptRequiredError if onPrompt is missing", async () => {
			await expect(loginCommandCode({})).rejects.toBeInstanceOf(AIError.OnPromptRequiredError);
		});

		it("rejects empty or whitespace-only keys without making network requests", async () => {
			const { fetch, requests } = createFetchStub(() => Response.json({ ok: true }));

			await expect(
				loginCommandCode({
					onPrompt: async () => "   \t\n   ",
					fetch,
				}),
			).rejects.toBeInstanceOf(AIError.ApiKeyRequiredError);

			expect(requests).toHaveLength(0);
		});

		it("throws LoginCancelledError if the abort signal is aborted before key entry", async () => {
			const controller = new AbortController();
			controller.abort();

			await expect(
				loginCommandCode({
					onPrompt: async () => "sk-key",
					signal: controller.signal,
				}),
			).rejects.toBeInstanceOf(AIError.LoginCancelledError);
		});
	});

	describe("registration and storage integration", () => {
		it("is registered in PROVIDER_REGISTRY with unredirected storage under command-code", () => {
			const registered = PROVIDER_REGISTRY.find(p => p.id === "command-code");
			expect(registered).toBeDefined();
			expect(registered?.name).toBe("Command Code");
			expect(registered?.login).toBe(loginCommandCode);
			expect(registered?.storeCredentialsAs).toBeUndefined();
			expect(commandCodeProvider.id).toBe("command-code");
			expect(commandCodeProvider.name).toBe("Command Code");
		});

		it("persists valid key in AuthStorage under command-code", async () => {
			if (!storage || !db) throw new Error("test setup failed");

			const { fetch } = createFetchStub(() =>
				Response.json({
					id: "chatcmpl-test",
					choices: [{ message: { role: "assistant", content: "pong" } }],
				}),
			);

			const callbacks: OAuthLoginCallbacks = {
				onAuth: () => {},
				onPrompt: async () => "sk-command-stored-key",
				fetch,
			};

			await storage.login("command-code" as Parameters<AuthStorage["login"]>[0], callbacks);

			const storedKey = await storage.getApiKey("command-code", "session-1");
			expect(storedKey).toBe("sk-command-stored-key");

			const rows = db.prepare("SELECT provider, credential_type FROM auth_credentials").all() as Array<{
				provider: string;
				credential_type: string;
			}>;
			expect(rows).toEqual([{ provider: "command-code", credential_type: "api_key" }]);
		});
	});
});
