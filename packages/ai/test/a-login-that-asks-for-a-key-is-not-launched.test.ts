/**
 * WHY: choosing "OpenAI" in `/login` opened a browser on the platform login page and then, under it,
 * asked for a pasted key. The login was a key paste; its `onAuth` URL was the dashboard where a key
 * is obtained, and every UI treated every `onAuth` URL as an authorization to launch. The defect
 * class is that nothing forced anyone to record, per provider, what the login asks for, so a UI had
 * no way to tell a reference URL from one the flow waits on.
 *
 * What this file closes: `credential` is required on every registry row with a `login` (the type
 * enforces it; the sweep proves the built rows honor it), the set of rows that declare a browser
 * login is pinned by exact equality so a new row deciding `oauth` turns this suite red until the
 * decision is recorded here, and every row that declares `api-key` is driven end to end through a
 * fake controller: it prompts for the key, the paste comes back as the credential, and it never
 * needs the `onAuth` URL to be opened, because the URL arrives before the prompt and the flow
 * completes without a callback. `getLoginCredential` is the one read every login surface uses, and
 * it is checked against the row.
 *
 * What it does NOT catch: a row declared `oauth` whose login is a key paste (its flow is not driven
 * here; it is caught by the pin, which forces a reader to look), and whether a UI honors the value
 * (that is `packages/coding-agent/test/a-login-dialog-launches-only-a-browser-login.test.ts`).
 */
import { describe, expect, test, vi } from "bun:test";
import { PROVIDER_REGISTRY } from "@veyyon/ai/registry";
import { getLoginCredential } from "@veyyon/ai/registry/oauth";
import type { OAuthAuthInfo, OAuthLoginCallbacks } from "@veyyon/ai/registry/oauth/types";
import type { ProviderDefinition } from "@veyyon/ai/registry/types";
import type { FetchImpl } from "@veyyon/ai/types";

/**
 * Every row whose login waits on a browser or device authorization. A new row that declares
 * `oauth` is added here by whoever read its flow; a row that declares `api-key` is exercised below
 * instead and needs no entry.
 */
const BROWSER_LOGIN_PROVIDERS = [
	"anthropic",
	"cursor",
	"devin",
	"github-copilot",
	"gitlab-duo",
	"gitlab-duo-agent",
	"google-antigravity",
	"google-gemini-cli",
	"kilo",
	"kimi-code",
	"nous-research",
	"openai-codex",
	"openai-codex-device",
	"perplexity",
	"xai-oauth",
] as const;

/**
 * Environment a row's login reads before it can validate a key. Seeded for that row's test only
 * and restored after, so the sweep can construct every member instead of skipping one.
 */
const ROW_ENV: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	coreweave: { COREWEAVE_PROJECT: "team/project" },
};

function withRowEnv<T>(id: string, body: () => Promise<T>): Promise<T> {
	const seed = ROW_ENV[id];
	if (!seed) return body();
	const previous: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(seed)) {
		previous[key] = process.env[key];
		process.env[key] = value;
	}
	return body().finally(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}

type Row = ProviderDefinition & { login: NonNullable<ProviderDefinition["login"]> };

function rowsWithLogin(defs: readonly ProviderDefinition[]): Row[] {
	return defs.filter((def): def is Row => typeof def.login === "function");
}

type Trace = {
	callbacks: OAuthLoginCallbacks;
	/** `auth` and `prompt` in the order the flow raised them. */
	order: ("auth" | "prompt")[];
	authCalls: OAuthAuthInfo[];
};

function trace(paste: string): Trace {
	const order: Trace["order"] = [];
	const authCalls: OAuthAuthInfo[] = [];
	const fetchStub: FetchImpl = vi.fn(async () => {
		return new Response(JSON.stringify({ data: [], models: [] }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	return {
		order,
		authCalls,
		callbacks: {
			onAuth: vi.fn((info: OAuthAuthInfo) => {
				order.push("auth");
				authCalls.push(info);
			}),
			onProgress: vi.fn(),
			onPrompt: vi.fn(async () => {
				order.push("prompt");
				return paste;
			}),
			fetch: fetchStub,
		},
	};
}

describe("a login that asks for a key is not launched", () => {
	const rows = rowsWithLogin(PROVIDER_REGISTRY);

	test("every row with a login states what it asks for", () => {
		const undecided = rows.filter(row => row.credential !== "api-key" && row.credential !== "oauth");
		expect(undecided.map(row => row.id)).toEqual([]);
	});

	test("the rows that wait on a browser are exactly the recorded set", () => {
		const declared = rows
			.filter(row => row.credential === "oauth")
			.map(row => row.id)
			.sort();
		expect(declared).toEqual([...BROWSER_LOGIN_PROVIDERS].sort());
	});

	test("getLoginCredential reports the row's declaration, and a browser login for an unknown id", () => {
		for (const row of rows) {
			expect(getLoginCredential(row.id)).toBe(row.credential);
		}
		expect(getLoginCredential("an-extension-registered-this")).toBe("oauth");
	});

	const keyRows = rows.filter(row => row.credential === "api-key");

	test("at least one row asks for a key, so the sweep below is not vacuous", () => {
		expect(keyRows.length).toBeGreaterThan(0);
	});

	test.each(keyRows.map(row => [row.id, row] as const))(
		"%s prompts for the key and completes without the URL being opened",
		async (_id, row) => {
			const { callbacks, order, authCalls } = trace("  pasted-secret-key  ");
			const result = await withRowEnv(row.id, () => row.login(callbacks));

			// The paste is the credential: a string for a plain key, or credentials for a row that
			// stores the pasted token in the OAuth shape. Either way it is a value, not a wait.
			expect(result === "pasted-secret-key" || (typeof result === "object" && result !== null)).toBe(true);
			expect(order).toContain("prompt");
			// Any URL the flow reports is a reference: the flow went on to ask for the paste after
			// reporting it and resolved without anything opening it. A row that asks a question
			// before the URL (a region, a base URL) still asks for the key after it.
			expect(order.lastIndexOf("auth")).toBeLessThan(order.lastIndexOf("prompt"));
			for (const info of authCalls) {
				expect(info.url).toMatch(/^https?:\/\//);
			}
		},
	);
});
