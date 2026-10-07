// WHY: the auth broker serves its routes from one dispatch table. Every route but `GET /v1/healthz`
// must turn away a request without an accepted bearer, every path must answer a method it does not
// serve with a 404 naming the request, every `/v1/credential/:id/<action>` route must answer an id
// no loaded row carries with a 404 naming the id, and a handler that throws must answer the JSON 500
// rather than the server's default error page. The sweep reads the routes from the broker's own
// table, and the body table below must list exactly those routes, so a new route turns this suite
// red until it is recorded here.
//
// Not caught: which peer address a request log records, and the success bodies of the snapshot,
// usage, refresh, and upload routes, which `auth-broker-wire.test.ts` owns.
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
import { AUTH_BROKER_AUTHORIZED_ROUTES, type AuthBrokerServerHandle, startAuthBroker } from "@veyyon/ai/auth-broker";
import { removeWithRetries } from "../../utils/src/temp";

const ACCEPTED_TOKEN = "broker-bearer-token";
/** Same length as the accepted token, last byte changed. */
const REJECTED_TOKEN = "broker-bearer-tokeX";
const UNKNOWN_ID = 987_654;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const blockBody = JSON.stringify({ providerKey: "anthropic", blockScope: "global", blockedUntilMs: 4_102_444_800_000 });

/** The request body each authorized route reads. */
const ROUTE_BODIES: Record<string, string | undefined> = {
	"GET /v1/snapshot/stream": undefined,
	"GET /v1/snapshot": undefined,
	"GET /v1/usage": undefined,
	"POST /v1/usage/stale": undefined,
	"POST /v1/credential": JSON.stringify({ provider: "anthropic", credential: { type: "api_key", key: "sk-test" } }),
	"POST /v1/credential/:id/refresh": undefined,
	"POST /v1/credential/:id/disable": undefined,
	"POST /v1/credential/:id/block": blockBody,
	"DELETE /v1/credential/:id/blocks": undefined,
};

const CREDENTIAL_ROUTES = AUTH_BROKER_AUTHORIZED_ROUTES.filter(route => route.includes(":id"));

function oauthCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: 4_102_444_800_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("every auth-broker route", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;
	let handle: AuthBrokerServerHandle;
	let liveIds: number[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-routes-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		store.saveOAuth("anthropic", oauthCredential("a"));
		store.saveOAuth("anthropic", oauthCredential("b"));
		storage = new AuthStorage(store);
		await storage.reload();
		liveIds = storage.exportSnapshot().credentials.map(entry => entry.id);
		expect(liveIds).toHaveLength(2);
		handle = startAuthBroker({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [ACCEPTED_TOKEN],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await handle.close();
		storage.close();
		store.close();
		await removeWithRetries(tempDir);
	});

	function target(route: string, id: number): { method: string; pathname: string } {
		const [method, pattern] = route.split(" ");
		return { method, pathname: pattern.replace(":id", String(id)) };
	}

	function send(route: string, options: { id?: number; authorization?: string; method?: string } = {}) {
		const { method: routeMethod, pathname } = target(route, options.id ?? liveIds[0]);
		const method = options.method ?? routeMethod;
		const headers = new Headers();
		if (options.authorization !== undefined) headers.set("authorization", options.authorization);
		const body = method === "GET" ? undefined : ROUTE_BODIES[route];
		return fetch(`${handle.url}${pathname}`, { method, headers, body });
	}

	async function snapshotBlocks(id: number): Promise<unknown[] | undefined> {
		const res = await send("GET /v1/snapshot", { authorization: `Bearer ${ACCEPTED_TOKEN}` });
		const body = (await res.json()) as { credentials: Array<{ id: number; blocks?: unknown[] }> };
		return body.credentials.find(entry => entry.id === id)?.blocks;
	}

	it("is listed in the body table, and the table lists no other route", () => {
		expect(Object.keys(ROUTE_BODIES).sort()).toEqual([...AUTH_BROKER_AUTHORIZED_ROUTES].sort());
	});

	describe.each([...AUTH_BROKER_AUTHORIZED_ROUTES])("%s", route => {
		it("answers 401 without a bearer, with a rejected bearer, and with another scheme", async () => {
			for (const authorization of [undefined, `Bearer ${REJECTED_TOKEN}`, `Basic ${ACCEPTED_TOKEN}`]) {
				const res = await send(route, { authorization });
				expect({ authorization, status: res.status, body: await res.json() }).toEqual({
					authorization,
					status: 401,
					body: { error: "unauthorized" },
				});
			}
		});

		it("answers 404 naming the request for every method its path does not serve", async () => {
			const { pathname } = target(route, liveIds[0]);
			const pattern = route.split(" ")[1];
			for (const method of METHODS) {
				if (AUTH_BROKER_AUTHORIZED_ROUTES.includes(`${method} ${pattern}`)) continue;
				const res = await send(route, { method, authorization: `Bearer ${ACCEPTED_TOKEN}` });
				expect({ method, status: res.status, body: await res.json() }).toEqual({
					method,
					status: 404,
					body: { error: `No route: ${method} ${pathname}` },
				});
			}
		});
	});

	it.each(CREDENTIAL_ROUTES)("%s answers 404 naming an id no row carries", async route => {
		const res = await send(route, { id: UNKNOWN_ID, authorization: `Bearer ${ACCEPTED_TOKEN}` });
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain(`No credential with id=${UNKNOWN_ID}`);
	});

	it("GET /v1/healthz answers without a bearer and with a rejected one", async () => {
		for (const authorization of [undefined, `Bearer ${REJECTED_TOKEN}`]) {
			const headers = new Headers();
			if (authorization !== undefined) headers.set("authorization", authorization);
			const res = await fetch(`${handle.url}/v1/healthz`, { headers });
			expect(res.status).toBe(200);
			expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
		}
	});

	it("places a block on a live row, clears it, and places none on a row disabled since", async () => {
		const [live, disabled] = liveIds;
		const auth = `Bearer ${ACCEPTED_TOKEN}`;

		const placed = await send("POST /v1/credential/:id/block", { id: live, authorization: auth });
		expect(placed.status).toBe(200);
		expect(await snapshotBlocks(live)).toEqual([
			expect.objectContaining({ providerKey: "anthropic", blockScope: "global", blockedUntilMs: 4_102_444_800_000 }),
		]);

		const cleared = await send("DELETE /v1/credential/:id/blocks", { id: live, authorization: auth });
		expect(cleared.status).toBe(200);
		expect(await snapshotBlocks(live)).toBeUndefined();

		expect((await send("POST /v1/credential/:id/disable", { id: disabled, authorization: auth })).status).toBe(200);
		const refused = await send("POST /v1/credential/:id/block", { id: disabled, authorization: auth });
		expect(refused.status).toBe(404);
		expect(store.listCredentialBlocks([disabled])).toEqual([]);
		expect((await send("DELETE /v1/credential/:id/blocks", { id: disabled, authorization: auth })).status).toBe(404);
	});

	it("answers a handler that throws with the JSON 500", async () => {
		vi.spyOn(storage, "reload").mockRejectedValue(new Error("store unavailable"));
		const res = await send("GET /v1/snapshot", { authorization: `Bearer ${ACCEPTED_TOKEN}` });
		expect(res.status).toBe(500);
		expect(res.headers.get("content-type")).toBe("application/json");
		expect(await res.json()).toEqual({ error: "internal error" });
	});

	it("admits a request without a bearer when no token is allowed", async () => {
		const open = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [], disableRefresher: true });
		try {
			const res = await fetch(`${open.url}/v1/snapshot`);
			expect(res.status).toBe(200);
		} finally {
			await open.close();
		}
	});
});
