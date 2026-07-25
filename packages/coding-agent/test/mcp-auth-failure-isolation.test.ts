import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
import { MCPManager } from "@veyyon/coding-agent/mcp/manager";
import * as oauthFlow from "@veyyon/coding-agent/mcp/oauth-flow";
import type { MCPServerConfig } from "@veyyon/coding-agent/mcp/types";

/**
 * An MCP server losing its authorization must not cost you your model login.
 *
 * MCP credentials and model-provider credentials live in the SAME store, in the
 * same `agent.db`. That is deliberate, and it puts them one bug apart. When an
 * MCP refresh comes back `invalid_grant`, veyyon deletes the row: the right call
 * on its own terms, because a dead refresh token otherwise gets re-sent forever
 * and produces the permanent 401 loop of issue #1908.
 *
 * But "delete the credential" is exactly the operation that goes too far
 * quietly. Written slightly wrong, by provider rather than by credential id, or
 * by clearing a cache wholesale rather than one entry, it takes the Anthropic or
 * OpenAI credential with it. The user's symptom is that a flaky MCP server
 * logged them out of their model, with no message connecting the two, and the
 * MCP path is the more fragile one: third-party servers, short-lived tokens, and
 * refresh failures that are routine rather than exceptional.
 *
 * So the blast radius is the contract, and it is asserted from BOTH ends: the
 * MCP credential really is gone (or the test would pass against a build that
 * deleted nothing at all), and every other credential is byte-identical.
 */

const MCP_CREDENTIAL_ID = "mcp_oauth_isolation";
const TOKEN_URL = "https://example.com/oauth/token";

/** A model-provider credential of each kind that shares the store. */
const PROVIDER_OAUTH_ID = "anthropic";
const PROVIDER_API_KEY_ID = "openai";

describe("an MCP auth failure leaves model-provider credentials alone", () => {
	let manager: MCPManager;
	let authStorage: AuthStorage;
	let store: SqliteAuthCredentialStore;
	let serverConfig: MCPServerConfig;

	beforeEach(async () => {
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		authStorage = new AuthStorage(store);
		await authStorage.reload();

		// Expired, so `#resolveAuthConfig` decides to refresh and reaches the
		// failure path. A live credential takes the no-refresh branch and never
		// exercises anything this suite is about.
		await authStorage.set(MCP_CREDENTIAL_ID, {
			access: "mcp-stale-access",
			expires: Date.now() - 60_000,
			refresh: "mcp-stale-refresh",
			type: "oauth",
		});

		// The bystanders. An OAuth provider credential is the one that could
		// plausibly be caught by a provider-wide sweep; an API key is the one a
		// "clear all oauth" mistake would spare, so both are present and both are
		// checked.
		await authStorage.set(PROVIDER_OAUTH_ID, {
			access: "provider-access",
			expires: Date.now() + 3_600_000,
			refresh: "provider-refresh",
			type: "oauth",
		});
		await authStorage.set(PROVIDER_API_KEY_ID, { key: "provider-api-key", type: "api_key" });

		manager = new MCPManager(process.cwd());
		manager.setAuthStorage(authStorage);

		serverConfig = {
			auth: { credentialId: MCP_CREDENTIAL_ID, tokenUrl: TOKEN_URL, type: "oauth" },
			type: "http",
			url: "https://mcp.example.com/mcp",
		};
	});

	afterEach(() => {
		authStorage.close();
		vi.restoreAllMocks();
	});

	/** Snapshot every non-MCP credential so a change of any kind is visible. */
	function bystanders(): Record<string, unknown> {
		return {
			apiKey: authStorage.get(PROVIDER_API_KEY_ID),
			oauth: authStorage.get(PROVIDER_OAUTH_ID),
		};
	}

	/**
	 * The definitive-failure path, which is the one that deletes. Both halves are
	 * asserted: the MCP row is gone, so the deletion genuinely happened, and the
	 * provider rows are unchanged, so it happened to exactly one row.
	 */
	test("deletes only the MCP credential when the refresh is definitively rejected", async () => {
		const before = bystanders();
		vi.spyOn(oauthFlow, "refreshMCPOAuthToken").mockRejectedValue(
			new Error('MCP OAuth refresh failed: 400 {"error":"invalid_grant","error_description":"revoked"}'),
		);

		await manager.prepareConfig(serverConfig);

		// The deletion really happened; without this the isolation check below
		// would pass against a build that deleted nothing.
		expect(authStorage.get(MCP_CREDENTIAL_ID)).toBeUndefined();
		expect(bystanders()).toEqual(before);
	});

	/** The same contract for an HTTP 401, which routes through the same deletion. */
	test("leaves provider credentials alone when the token endpoint replies 401", async () => {
		const before = bystanders();
		vi.spyOn(oauthFlow, "refreshMCPOAuthToken").mockRejectedValue(
			new Error("MCP OAuth refresh failed: 401 Unauthorized"),
		);

		await manager.prepareConfig(serverConfig);

		expect(authStorage.get(MCP_CREDENTIAL_ID)).toBeUndefined();
		expect(bystanders()).toEqual(before);
	});

	/**
	 * A transient failure must delete NOTHING, not even the MCP row. A network
	 * blip is not evidence that a token is dead, and treating it as such would
	 * log the user out of an MCP server every time their connection wobbled.
	 */
	test("deletes nothing at all on a transient network failure", async () => {
		const before = bystanders();
		vi.spyOn(oauthFlow, "refreshMCPOAuthToken").mockRejectedValue(
			new Error("MCP OAuth refresh failed: fetch failed ECONNREFUSED 127.0.0.1:443"),
		);

		await manager.prepareConfig(serverConfig);

		expect(authStorage.get(MCP_CREDENTIAL_ID)).toBeDefined();
		expect(bystanders()).toEqual(before);
	});

	/**
	 * Repeated failures must not escalate. A retry loop against a permanently
	 * broken server is the realistic way a narrow deletion turns into a wide one,
	 * so the same call is made three times and the bystanders are re-checked.
	 */
	test("does not widen its blast radius across repeated failures", async () => {
		const before = bystanders();
		vi.spyOn(oauthFlow, "refreshMCPOAuthToken").mockRejectedValue(
			new Error('MCP OAuth refresh failed: 400 {"error":"invalid_grant"}'),
		);

		await manager.prepareConfig(serverConfig);
		await manager.prepareConfig(serverConfig);
		await manager.prepareConfig(serverConfig);

		expect(bystanders()).toEqual(before);
	});

	/**
	 * And a second MCP server's credential is not collateral either. Several MCP
	 * servers commonly share one session, and they fail independently; a deletion
	 * keyed by anything coarser than the credential id would take the healthy
	 * one down with the broken one.
	 */
	test("leaves another MCP server's credential alone", async () => {
		const otherId = "mcp_oauth_isolation_other";
		await authStorage.set(otherId, {
			access: "other-access",
			expires: Date.now() + 3_600_000,
			refresh: "other-refresh",
			type: "oauth",
		});
		const otherBefore = authStorage.get(otherId);

		vi.spyOn(oauthFlow, "refreshMCPOAuthToken").mockRejectedValue(
			new Error('MCP OAuth refresh failed: 400 {"error":"invalid_grant"}'),
		);

		await manager.prepareConfig(serverConfig);

		expect(authStorage.get(MCP_CREDENTIAL_ID)).toBeUndefined();
		expect(authStorage.get(otherId)).toEqual(otherBefore);
	});
});
