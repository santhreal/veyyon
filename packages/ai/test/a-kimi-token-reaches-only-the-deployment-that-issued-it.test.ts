/**
 * WHY: Kimi Code runs two deployments, mainland China on kimi.com and every other region on kimi.ai,
 * and a token one deployment issues is rejected by the other. Every Kimi request went to kimi.com, so
 * an account outside mainland China could not sign in, and a kimi.ai token sent to kimi.com failed.
 *
 * Class closed: every way a Kimi Code token leaves the process goes to the deployment that issued it,
 * for every deployment in `KIMI_CODE_REGIONS`: the device login, a turn through `streamSimple` in both
 * API formats, a turn through `stream` straight to chat completions, the usage probe, model discovery,
 * and the token refresh, plus a turn with the refreshed token, both as `AuthStorage` stores it and as
 * the provider's refresh returns it with no stored row merged under it. Each row is driven from
 * `/login` through the real `AuthStorage`, so the region has to survive storage, key derivation and
 * refresh. The Kimi login rows are read from `PROVIDER_REGISTRY` and pinned by exact equality, so a
 * new Kimi login row turns this suite red until its deployment is recorded here. Beside the
 * per-consumer URLs, every request a row makes is checked against the origins of its own deployment,
 * so a consumer this file does not name still fails it by reaching the other deployment.
 *
 * A custom base URL (a proxy) is kept for either deployment, a plain key (`KIMI_API_KEY`), which
 * names no deployment, follows the configured base, and a model served from either deployment's host
 * gets the Moonshot-native compat whatever its provider id.
 *
 * NOT CAUGHT: whether either deployment accepts the requests (there is no network here), and the web
 * search provider, which is in coding-agent and is covered by its own suite there.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { buildUsageCredential } from "@veyyon/ai/auth-storage/usage-requests";
import { PROVIDER_REGISTRY } from "@veyyon/ai/registry";
import { getOAuthApiKey, refreshOAuthToken } from "@veyyon/ai/registry/oauth";
import * as kimiOauth from "@veyyon/ai/registry/oauth/kimi";
import * as aiStream from "@veyyon/ai/stream";
import type { Context, Model, ModelSpec } from "@veyyon/ai/types";
import { kimiUsageProvider } from "@veyyon/ai/usage/kimi";
import { getBundledModel } from "@veyyon/catalog";
import { buildModel } from "@veyyon/catalog/build";
import { kimiCodeModelManagerOptions } from "@veyyon/catalog/provider-models/openai-compat";
import { KIMI_CODE_REGIONS, type KimiCodeRegion, kimiCodeApiKey } from "@veyyon/catalog/wire/kimi-code";

/** The deployment each Kimi login row signs in at. A new row is recorded here by whoever read its flow. */
const ROW_REGION: Readonly<Record<string, KimiCodeRegion>> = {
	"kimi-code": "mainland-cn",
	"kimi-code-global": "global",
};

const KIMI_LOGIN_ROWS = PROVIDER_REGISTRY.filter(
	row => typeof row.login === "function" && (row.id === "kimi-code" || row.storeCredentialsAs === "kimi-code"),
);

const CONTEXT: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

const HEADERS = {
	"User-Agent": "KimiCLI/0.0.0",
	"X-Msh-Platform": "kimi_cli",
	"X-Msh-Version": "0.0.0",
	"X-Msh-Device-Name": "test",
	"X-Msh-Device-Model": "test",
	"X-Msh-Os-Version": "test",
	"X-Msh-Device-Id": "test",
} as const;

/** One request a stub server received: where it went, and the credential it carried. */
interface Sent {
	url: string;
	credential: string | null;
}

/**
 * A server answering both deployments: the device flow and refresh on `/api/oauth/*`, and a 400 for
 * every API request, which ends a turn without a stream. It records every request it receives.
 */
function kimiServer(sent: Sent[]): typeof fetch {
	const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
		const body = await request.text();
		const url = new URL(request.url);
		const authorization = request.headers.get("authorization");
		sent.push({
			url: `${url.origin}${url.pathname}`,
			credential: authorization?.replace(/^Bearer /, "") ?? request.headers.get("x-api-key"),
		});
		if (url.pathname === "/api/oauth/device_authorization") {
			return Response.json({
				user_code: "ABCD-1234",
				device_code: "device-1",
				verification_uri: `${url.origin}/code/authorize_device`,
				interval: 1,
				expires_in: 900,
			});
		}
		if (url.pathname === "/api/oauth/token") {
			const refreshing = new URLSearchParams(body).get("grant_type") === "refresh_token";
			return Response.json({
				access_token: refreshing ? "access-refreshed" : "access-issued",
				refresh_token: refreshing ? "refresh-refreshed" : "refresh-issued",
				expires_in: 3600,
			});
		}
		return Response.json({ error: { type: "invalid_request_error", message: "stub" } }, { status: 400 });
	};
	return Object.assign(handler, { preconnect: fetch.preconnect }) as typeof fetch;
}

/** The distinct requests made since `mark`, in order. A retried request counts once. */
function since(sent: readonly Sent[], mark: number): Sent[] {
	const seen = new Set<string>();
	const distinct: Sent[] = [];
	for (const entry of sent.slice(mark)) {
		const key = `${entry.url} ${entry.credential}`;
		if (seen.has(key)) continue;
		seen.add(key);
		distinct.push(entry);
	}
	return distinct;
}

function kimiModel(baseUrl?: string): Model<"openai-completions"> {
	const bundled = getBundledModel<"openai-completions">("kimi-code", "kimi-for-coding");
	if (baseUrl === undefined) return bundled;
	return buildModel({
		...bundled,
		baseUrl,
		compat: bundled.compatConfig,
	} as ModelSpec<"openai-completions">);
}

/** One turn through `streamSimple` in an API format, or straight through `stream` to chat completions. */
async function runTurn(
	model: Model<"openai-completions">,
	apiKey: string,
	fetchImpl: typeof fetch,
	format: "anthropic" | "openai" | "stream",
): Promise<void> {
	if (format === "stream") {
		await aiStream.stream(model, CONTEXT, { apiKey, fetch: fetchImpl }).result();
		return;
	}
	await aiStream.streamSimple(model, CONTEXT, { apiKey, fetch: fetchImpl, kimiApiFormat: format }).result();
}

describe("a Kimi token reaches only the deployment that issued it", () => {
	let db: Database;
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		// An ambient KIMI_API_KEY must not stand in for the credential the login stores.
		vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
		vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue(HEADERS);
		db = new Database(":memory:");
		store = new SqliteAuthCredentialStore(db);
		storage = new AuthStorage(store);
		await storage.reload();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		store.close();
	});

	it("offers one login per deployment, and records which deployment each one signs in at", () => {
		expect(KIMI_LOGIN_ROWS.map(row => row.id).sort()).toEqual(Object.keys(ROW_REGION).sort());
		expect([...new Set<string>(Object.values(ROW_REGION))].sort()).toEqual(Object.keys(KIMI_CODE_REGIONS).sort());
	});

	for (const row of KIMI_LOGIN_ROWS) {
		const region = ROW_REGION[row.id];
		it(`sends every request of a ${row.id} login to the ${region} deployment`, async () => {
			if (region === undefined) throw new Error(`no deployment recorded for Kimi login row ${row.id}`);
			const endpoints = KIMI_CODE_REGIONS[region];
			const sent: Sent[] = [];
			const server = kimiServer(sent);
			vi.spyOn(globalThis, "fetch").mockImplementation(server);
			const model = kimiModel();

			await storage.login(row.id as Parameters<AuthStorage["login"]>[0], {
				onAuth: () => {},
				onProgress: () => {},
				onPrompt: async () => "",
			});
			expect(since(sent, 0).filter(entry => entry.url.includes("/api/oauth/"))).toEqual([
				{ url: `${endpoints.oauthHost}/api/oauth/device_authorization`, credential: null },
				{ url: `${endpoints.oauthHost}/api/oauth/token`, credential: null },
			]);

			const apiKey = await storage.getApiKey("kimi-code", "s");
			if (apiKey === undefined) throw new Error("the login stored no kimi-code credential");

			let mark = sent.length;
			await runTurn(model, apiKey, server, "anthropic");
			expect(since(sent, mark)).toEqual([
				{ url: `${endpoints.anthropicBaseUrl}/v1/messages`, credential: "access-issued" },
			]);

			mark = sent.length;
			await runTurn(model, apiKey, server, "openai");
			expect(since(sent, mark)).toEqual([
				{ url: `${endpoints.baseUrl}/chat/completions`, credential: "access-issued" },
			]);

			mark = sent.length;
			await runTurn(model, apiKey, server, "stream");
			expect(since(sent, mark)).toEqual([
				{ url: `${endpoints.baseUrl}/chat/completions`, credential: "access-issued" },
			]);

			const stored = store.listAuthCredentials("kimi-code")[0]?.credential;
			if (stored?.type !== "oauth") throw new Error("the login stored no kimi-code OAuth row");
			mark = sent.length;
			await kimiUsageProvider.fetchUsage(
				{ provider: "kimi-code", credential: buildUsageCredential(stored), baseUrl: model.baseUrl },
				{ fetch: server },
			);
			expect(since(sent, mark)).toEqual([{ url: `${endpoints.baseUrl}/usages`, credential: "access-issued" }]);

			mark = sent.length;
			await kimiCodeModelManagerOptions({ apiKey, fetch: server }).fetchDynamicModels?.();
			expect(since(sent, mark)).toEqual([{ url: `${endpoints.baseUrl}/models`, credential: "access-issued" }]);

			mark = sent.length;
			const refreshedKey = await storage.getApiKey("kimi-code", "s", { forceRefresh: true });
			if (refreshedKey === undefined) throw new Error("the refresh left no kimi-code credential");
			expect(since(sent, mark)).toEqual([{ url: `${endpoints.oauthHost}/api/oauth/token`, credential: null }]);

			mark = sent.length;
			await runTurn(model, refreshedKey, server, "anthropic");
			expect(since(sent, mark)).toEqual([
				{ url: `${endpoints.anthropicBaseUrl}/v1/messages`, credential: "access-refreshed" },
			]);

			// A consumer that keys the refresh result as returned, with no stored row merged under it.
			mark = sent.length;
			const unmerged = await refreshOAuthToken("kimi-code", stored);
			const unmergedKey = (await getOAuthApiKey("kimi-code", { "kimi-code": unmerged }))?.apiKey;
			if (unmergedKey === undefined) throw new Error("the refresh result derives no kimi-code key");
			await runTurn(model, unmergedKey, server, "openai");
			expect(since(sent, mark)).toEqual([
				{ url: `${endpoints.oauthHost}/api/oauth/token`, credential: null },
				{ url: `${endpoints.baseUrl}/chat/completions`, credential: "access-refreshed" },
			]);

			const ownOrigins = new Set([new URL(endpoints.oauthHost).origin, new URL(endpoints.baseUrl).origin]);
			expect(sent.map(entry => new URL(entry.url).origin).filter(origin => !ownOrigins.has(origin))).toEqual([]);
		});
	}

	it("keeps a custom base URL for a token from either deployment", async () => {
		const proxy = "https://proxy.example.test/kimi/v1";
		const model = kimiModel(proxy);
		for (const region of Object.keys(KIMI_CODE_REGIONS) as KimiCodeRegion[]) {
			const apiKey = kimiCodeApiKey(`token-${region}`, KIMI_CODE_REGIONS[region].baseUrl);
			for (const format of ["openai", "stream"] as const) {
				const sent: Sent[] = [];
				await runTurn(model, apiKey, kimiServer(sent), format);
				expect(since(sent, 0)).toEqual([{ url: `${proxy}/chat/completions`, credential: `token-${region}` }]);
			}
		}
	});

	it("sends a plain key to the deployment of the configured base", async () => {
		for (const region of Object.keys(KIMI_CODE_REGIONS) as KimiCodeRegion[]) {
			const endpoints = KIMI_CODE_REGIONS[region];
			const model = kimiModel(endpoints.baseUrl);
			const expected = {
				anthropic: `${endpoints.anthropicBaseUrl}/v1/messages`,
				openai: `${endpoints.baseUrl}/chat/completions`,
				stream: `${endpoints.baseUrl}/chat/completions`,
			};
			for (const format of ["anthropic", "openai", "stream"] as const) {
				const sent: Sent[] = [];
				await runTurn(model, "plain-key", kimiServer(sent), format);
				expect(since(sent, 0)).toEqual([{ url: expected[format], credential: "plain-key" }]);
			}
		}
	});

	it("gives a model served from either deployment's host the Moonshot-native compat", () => {
		const bundled = getBundledModel<"openai-completions">("kimi-code", "kimi-for-coding");
		// A provider id other than `kimi-code` reaches the compat only through the host of its base URL,
		// and no compat is declared, so the resolved record is the host's.
		const servedFrom = (baseUrl: string) =>
			buildModel({
				...bundled,
				provider: "kimi-proxy",
				baseUrl,
				compat: undefined,
			} as ModelSpec<"openai-completions">).compat.toolSchemaFlavor;
		for (const region of Object.keys(KIMI_CODE_REGIONS) as KimiCodeRegion[]) {
			expect(servedFrom(KIMI_CODE_REGIONS[region].baseUrl)).toBe("moonshot-mfjs");
		}
		expect(servedFrom("https://proxy.example.test/kimi/v1")).toBeUndefined();
	});
});
