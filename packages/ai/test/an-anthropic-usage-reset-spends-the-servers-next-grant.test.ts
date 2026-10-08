/**
 * WHY: `/usage reset` spends an Anthropic usage-limit reset through `AuthStorage`, which reads the
 * `cedar_ember` status from the OAuth usage endpoint and claims one reset on the organization route.
 * A reset is scarce and irreversible, so the defects this suite closes are the ones that spend the
 * wrong thing or report the wrong result:
 *
 * - claiming a grant other than the server's `next_grant_id` (rejected server-side after the trip),
 * - claiming when no grant is spendable, or without an organization id, instead of stopping locally,
 * - reporting a business outcome that arrives on a 4xx status (`cooldown`) as a transport failure,
 * - mapping Anthropic's result names onto the wrong provider-neutral code.
 *
 * It drives the real `AuthStorage`, and through it `auth-storage/reset-credits.ts` and
 * `usage/anthropic-reset`, against a fake `fetch`;
 * it does not prove the live server's response shape, which was read from Claude Code's client and
 * is pinned only by these fixtures.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

const ORG = "org-0000-1111";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1";
const CLAIM_URL = `https://api.anthropic.com/api/organizations/${ORG}/reset_rate_limits`;

interface Grant {
	id: string;
	resets_left: number;
	usable_now?: boolean;
	paused?: boolean;
	ends_at?: string;
}

interface Recorded {
	url: string;
	method: string;
	body?: string;
}

interface Scenario {
	status: { eligible: boolean; grants: readonly Grant[]; next_grant_id?: string } | null;
	orgHeader?: string;
	claim?: { status: number; body: unknown };
}

function fakeFetch(scenario: Scenario, calls: Recorded[]): typeof fetch {
	const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = input instanceof Request ? input.url : String(input);
		const method = init?.method ?? "GET";
		calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
		if (method === "GET") {
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (scenario.orgHeader) headers["anthropic-organization-id"] = scenario.orgHeader;
			return new Response(JSON.stringify({ five_hour: null, cedar_ember: scenario.status }), {
				status: 200,
				headers,
			});
		}
		const claim = scenario.claim ?? { status: 500, body: {} };
		return new Response(JSON.stringify(claim.body), { status: claim.status });
	};
	return Object.assign(impl, { preconnect: fetch.preconnect });
}

describe("Anthropic usage-limit reset through AuthStorage", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-anthropic-reset-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	});

	afterEach(async () => {
		store?.close();
		store = null;
		if (tempDir) await removeWithRetries(tempDir);
		tempDir = "";
	});

	async function storageFor(scenario: Scenario, calls: Recorded[], orgId?: string): Promise<AuthStorage> {
		if (!store) throw new Error("test setup failed");
		const storage = new AuthStorage(store, { usageFetch: fakeFetch(scenario, calls) });
		await storage.set("anthropic", [
			{
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60 * 60_000,
				email: "me@example.com",
				...(orgId ? { orgId } : {}),
			},
		]);
		return storage;
	}

	const redeem = (storage: AuthStorage) =>
		storage.redeemResetCredit({ target: { provider: "anthropic", email: "me@example.com" } });

	test("lists the resets left on spendable grants only", async () => {
		const calls: Recorded[] = [];
		const storage = await storageFor(
			{
				status: {
					eligible: true,
					next_grant_id: "launch",
					grants: [
						{ id: "launch", resets_left: 2, usable_now: true },
						{ id: "paused", resets_left: 5, usable_now: true, paused: true },
						{ id: "expired", resets_left: 3, usable_now: true, ends_at: "2000-01-01T00:00:00Z" },
						{ id: "later", resets_left: 4, usable_now: false },
					],
				},
			},
			calls,
		);

		const [account] = await storage.listResetCredits({ provider: "anthropic" });

		expect(account).toMatchObject({ provider: "anthropic", email: "me@example.com", availableCount: 2 });
		expect(account?.credits.map(credit => [credit.id, credit.status])).toEqual([
			["launch", "available"],
			["paused", "paused"],
			["expired", "unavailable"],
			["later", "unavailable"],
		]);
		expect(calls).toEqual([{ url: USAGE_URL, method: "GET", body: undefined }]);
	});

	test("claims the server's next grant on the organization named by the usage response", async () => {
		const calls: Recorded[] = [];
		const storage = await storageFor(
			{
				status: {
					eligible: true,
					next_grant_id: "second",
					grants: [
						{ id: "first", resets_left: 1, usable_now: true },
						{ id: "second", resets_left: 1, usable_now: true },
					],
				},
				orgHeader: ORG,
				claim: { status: 200, body: { result: "reset", cleared: ["five_hour"], resets_left: 0 } },
			},
			calls,
		);

		const outcome = await redeem(storage);

		expect(outcome).toEqual({
			ok: true,
			code: "reset",
			provider: "anthropic",
			accountId: undefined,
			email: "me@example.com",
			creditId: "second",
		});
		const claim = calls.find(call => call.method === "POST");
		expect(claim?.url).toBe(CLAIM_URL);
		const body: unknown = JSON.parse(claim?.body ?? "null");
		expect(body).toMatchObject({ program: "cedar_ember", grant_id: "second" });
		expect(body).toHaveProperty("request_id", expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/));
	});

	test("prefers the organization stored on the credential over the response header", async () => {
		const calls: Recorded[] = [];
		const storage = await storageFor(
			{
				status: { eligible: true, next_grant_id: "g", grants: [{ id: "g", resets_left: 1, usable_now: true }] },
				orgHeader: "org-from-header",
				claim: { status: 200, body: { result: "reset" } },
			},
			calls,
			ORG,
		);

		await redeem(storage);

		expect(calls.find(call => call.method === "POST")?.url).toBe(CLAIM_URL);
	});

	test.each([
		["already_used", 200, "already_redeemed"],
		["not_limited", 200, "nothing_to_reset"],
		["cooldown", 409, "cooldown"],
		["ineligible", 422, "ineligible"],
		["unavailable", 503, "unavailable"],
	] as const)("maps a claim result of %s (HTTP %d) to %s without reporting success", async (result, status, code) => {
		const calls: Recorded[] = [];
		const storage = await storageFor(
			{
				status: { eligible: true, next_grant_id: "g", grants: [{ id: "g", resets_left: 1, usable_now: true }] },
				orgHeader: ORG,
				claim: { status, body: { result } },
			},
			calls,
		);

		const outcome = await redeem(storage);

		expect(outcome.ok).toBe(false);
		expect(outcome.code).toBe(code);
	});

	test("reports a claim response without a result as the HTTP status", async () => {
		const storage = await storageFor(
			{
				status: { eligible: true, next_grant_id: "g", grants: [{ id: "g", resets_left: 1, usable_now: true }] },
				orgHeader: ORG,
				claim: { status: 502, body: { error: "bad gateway" } },
			},
			[],
		);

		expect((await redeem(storage)).code).toBe("http_502");
	});

	test.each([
		[
			"no spendable grant",
			{ eligible: true, next_grant_id: "g", grants: [{ id: "g", resets_left: 0, usable_now: true }] },
			ORG,
			"no_credit",
		],
		["an ineligible account", { eligible: false, grants: [] }, ORG, "ineligible"],
		["a missing status block", null, ORG, "status_unavailable"],
		[
			"no organization id",
			{ eligible: true, next_grant_id: "g", grants: [{ id: "g", resets_left: 1, usable_now: true }] },
			undefined,
			"no_organization",
		],
	] as const)("stops before claiming on %s", async (_name, status, orgHeader, code) => {
		const calls: Recorded[] = [];
		const storage = await storageFor({ status, orgHeader, claim: { status: 200, body: { result: "reset" } } }, calls);

		const outcome = await redeem(storage);

		expect(outcome).toMatchObject({ ok: false, code });
		expect(calls.filter(call => call.method === "POST")).toEqual([]);
	});

	test("reports no_account for a target that matches no stored account and sends nothing", async () => {
		const calls: Recorded[] = [];
		const storage = await storageFor({ status: null }, calls);

		const outcome = await storage.redeemResetCredit({
			target: { provider: "anthropic", email: "other@example.com" },
		});

		expect(outcome).toMatchObject({ ok: false, code: "no_account", provider: "anthropic" });
		expect(calls).toEqual([]);
	});
});
