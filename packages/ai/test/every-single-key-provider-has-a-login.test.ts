/**
 * WHY: a provider whose credential is one pasted API key used to reach `/login <id>` and be told
 * the provider "has no browser login". The defect class is not "openai was forgotten" — it is that
 * nothing in the tree forced anyone to decide, per provider, whether a key-paste login exists. The
 * membership list for `/login` is derived from the registry, so a provider could be added with no
 * `login` and nothing anywhere would go red.
 *
 * What this file closes: the registry is read at run time and split on `login`. Every provider that
 * lacks one must appear in `NO_LOGIN_EXCEPTIONS` with a non-empty recorded reason, so adding a new
 * provider with no login turns this suite red until someone writes that reason down. The exception
 * set itself is pinned to the three providers that genuinely cannot be one pasted key, and each
 * exception is cross-checked against the registry so a stale entry (provider deleted, or provider
 * that has since grown a login) also goes red. For the seven single-key providers the login is
 * driven end to end through a fake controller: the pasted key comes back trimmed, `onAuth` receives
 * that vendor's real key page, the validation request goes to that vendor's real endpoint, and an
 * all-whitespace paste is rejected.
 *
 * What it does NOT catch: whether a vendor URL is still correct upstream (a moved key page or a
 * retired `/v1/models` route stays green here — only a live request would notice), whether the
 * pasted key is actually accepted by the vendor, whether the credential is persisted correctly by
 * `AuthStorage`, and whether the login list renders the new entries.
 */
import { describe, expect, test, vi } from "bun:test";
import { ApiKeyRequiredError } from "@veyyon/ai/error";
import { PROVIDER_REGISTRY } from "@veyyon/ai/registry";
import type { OAuthAuthInfo, OAuthLoginCallbacks } from "@veyyon/ai/registry/oauth/types";
import type { ProviderDefinition } from "@veyyon/ai/registry/types";
import type { FetchImpl } from "@veyyon/ai/types";

/**
 * Providers that cannot be authenticated by one pasted key. Each entry records what the provider
 * needs instead; a blank reason does not count as a decision.
 */
const NO_LOGIN_EXCEPTIONS: Readonly<Record<string, string>> = {
	azure: "needs a per-resource endpoint plus a deployment name alongside the key, not a key alone",
	"google-vertex": "needs a GCP project and location plus Application Default Credentials, not a pasted key",
	"amazon-bedrock": "needs AWS credentials (access key id, secret, region, optional session token), not a pasted key",
};

/** Registry ids that lack a login and have no recorded reason. Empty means every case was decided. */
function unexplainedMissingLogin(
	defs: readonly ProviderDefinition[],
	exceptions: Readonly<Record<string, string>> = NO_LOGIN_EXCEPTIONS,
): string[] {
	return defs
		.filter(def => typeof def.login !== "function")
		.map(def => def.id)
		.filter(id => (exceptions[id] ?? "").trim() === "");
}

type SingleKeyProvider = {
	id: string;
	authUrl: string;
	/** Validation request the login is expected to make, or null when the vendor has no key check. */
	validationUrl: string | null;
};

const SINGLE_KEY_PROVIDERS: readonly SingleKeyProvider[] = [
	{ id: "openai", authUrl: "https://platform.openai.com/api-keys", validationUrl: "https://api.openai.com/v1/models" },
	{
		id: "google",
		authUrl: "https://aistudio.google.com/apikey",
		validationUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
	},
	{ id: "groq", authUrl: "https://console.groq.com/keys", validationUrl: "https://api.groq.com/openai/v1/models" },
	{ id: "xai", authUrl: "https://console.x.ai/team/default/api-keys", validationUrl: "https://api.x.ai/v1/models" },
	{
		id: "mistral",
		authUrl: "https://console.mistral.ai/api-keys",
		validationUrl: "https://api.mistral.ai/v1/models",
	},
	{
		id: "minimax",
		authUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
		validationUrl: "https://api.minimax.io/v1/models",
	},
	{ id: "aimlapi", authUrl: "https://aimlapi.com/app/keys", validationUrl: null },
];

function providerById(id: string): ProviderDefinition {
	const def = PROVIDER_REGISTRY.find(entry => entry.id === id);
	if (!def) {
		throw new Error(`provider ${id} is missing from PROVIDER_REGISTRY`);
	}
	return def;
}

type Harness = {
	callbacks: OAuthLoginCallbacks;
	authCalls: OAuthAuthInfo[];
	fetchUrls: string[];
};

function harness(paste: string): Harness {
	const authCalls: OAuthAuthInfo[] = [];
	const fetchUrls: string[] = [];
	const fetchStub: FetchImpl = vi.fn(async (input: string | URL | Request) => {
		fetchUrls.push(String(input));
		return new Response(JSON.stringify({ data: [] }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	return {
		authCalls,
		fetchUrls,
		callbacks: {
			onAuth: vi.fn((info: OAuthAuthInfo) => {
				authCalls.push(info);
			}),
			onProgress: vi.fn(),
			onPrompt: vi.fn(async () => paste),
			fetch: fetchStub,
		},
	};
}

describe("single-key providers have a real /login", () => {
	test("every registry provider without a login carries a recorded reason", () => {
		expect(unexplainedMissingLogin(PROVIDER_REGISTRY)).toEqual([]);
	});

	test("a newly added provider with no login is reported until a reason is recorded", () => {
		const newcomer = { id: "brand-new-gateway", name: "Brand New Gateway" } as const satisfies ProviderDefinition;
		expect(unexplainedMissingLogin([...PROVIDER_REGISTRY, newcomer])).toEqual(["brand-new-gateway"]);
	});

	test("an exception whose reason is blank does not count as a decision", () => {
		const blanked = { ...NO_LOGIN_EXCEPTIONS, azure: "   " };
		expect(unexplainedMissingLogin(PROVIDER_REGISTRY, blanked)).toEqual(["azure"]);
	});

	test("the exception set is exactly the three providers a pasted key cannot authenticate", () => {
		expect(Object.keys(NO_LOGIN_EXCEPTIONS).sort()).toEqual(["amazon-bedrock", "azure", "google-vertex"]);
		for (const [id, reason] of Object.entries(NO_LOGIN_EXCEPTIONS)) {
			expect(providerById(id).login).toBeUndefined();
			expect(reason.trim().length).toBeGreaterThan(0);
		}
	});

	test.each(SINGLE_KEY_PROVIDERS.map(provider => [provider.id, provider] as const))(
		"%s returns the trimmed pasted key and opens its own key page",
		async (_id, provider) => {
			const def = providerById(provider.id);
			const login = def.login;
			if (typeof login !== "function") {
				throw new Error(`provider ${provider.id} has no callable login`);
			}

			const { callbacks, authCalls, fetchUrls } = harness("  pasted-secret-key  ");
			const credential = await login(callbacks);

			expect(credential).toBe("pasted-secret-key");
			expect(authCalls).toHaveLength(1);
			expect(authCalls[0]?.url).toBe(provider.authUrl);
			expect(fetchUrls).toEqual(provider.validationUrl === null ? [] : [provider.validationUrl]);
		},
	);

	test.each(SINGLE_KEY_PROVIDERS.map(provider => [provider.id, provider] as const))(
		"%s rejects an empty paste instead of storing it",
		async (_id, provider) => {
			const def = providerById(provider.id);
			const login = def.login;
			if (typeof login !== "function") {
				throw new Error(`provider ${provider.id} has no callable login`);
			}

			const { callbacks, fetchUrls } = harness("   \t \n ");
			await expect(login(callbacks)).rejects.toBeInstanceOf(ApiKeyRequiredError);
			expect(fetchUrls).toEqual([]);
		},
	);
});
