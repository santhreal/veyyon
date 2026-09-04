/**
 * WHY. `MCPManager.#resolveAuthConfig()` resolved a stored OAuth credential inside a `try`, and
 * every way that resolution could fail ended at one `logger.warn("Failed to resolve OAuth
 * credential")`. The function then returned the config it already had — one with no
 * `Authorization` header — and the connect went ahead. A revoked credential, a refresh token the
 * auth broker holds and redacts locally, and a credential store that could not be read all
 * produced the same thing an operator could see: whatever the SERVER says about an anonymous
 * request. An HTTP 401 with a provider's own wording, or a lockout after enough of them, and
 * nothing at all about the credential or the command that fixes it.
 *
 * THE CLASS THIS CLOSES. Not "invalid_grant produces a better sentence". The invariant is that a
 * credential which cannot be presented is never replaced by no credential: `lookupMcpOAuthCredential`
 * returns a lookup only when a stored credential was FOUND, so if resolution began with one, the
 * connection either carries a credential or is not attempted at all. Every reason for failing to
 * present it is a separate operator action, so every reason carries its own sentence, and the
 * reason list is swept from source so a fourth reason cannot be added without a decision.
 *
 * The two directions are both pinned, because a control that only refuses is as wrong as one that
 * only proceeds: a live access token whose REFRESH failed still connects (the refresh fires up to
 * five minutes early, so that session works), and a server with no stored credential at all still
 * connects anonymously, which is what its operator configured.
 *
 * These drive the real `MCPManager` against a real HTTP MCP server that records every request it
 * receives, so "was not attempted" is measured at the far end rather than inferred from a header.
 *
 * WHAT IT DOES NOT CATCH. It says nothing about a credential that is present and simply wrong —
 * that is the server's 401 to explain, and the rotation path in
 * `a-rotated-credential-is-re-read-instead-of-re-sent.test.ts` owns re-reading it. It does not
 * cover model-provider auth, which has its own resolution path; the only provider assertion here
 * is that an MCP refusal leaves provider credentials byte-identical. And it does not bound how
 * often a refusal may be retried: the retry policy is `#doReconnect`'s, not this module's.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
import {
	MCP_AUTH_FAILURE_REASONS,
	MCPAuthRequiredError,
	mcpAuthRequiredMessage,
} from "@veyyon/coding-agent/mcp/auth-failure";
import { MCPManager } from "@veyyon/coding-agent/mcp/manager";
import * as oauthFlow from "@veyyon/coding-agent/mcp/oauth-flow";
import type { McpConnectionStatusEvent } from "@veyyon/coding-agent/mcp/startup-events";
import type { MCPServerConfig } from "@veyyon/coding-agent/mcp/types";
import { REMOTE_REFRESH_SENTINEL } from "@veyyon/kernel/session/auth-storage";
import { logger } from "@veyyon/utils";

const MCP_CREDENTIAL_ID = "mcp_oauth_attribution";
const TOKEN_URL = "https://tokens.example.com/oauth/token";
const ACCESS_TOKEN = "mcp-access-token-do-not-log";
const REFRESH_TOKEN = "mcp-refresh-token-do-not-log";
const PROVIDER_OAUTH_ID = "anthropic";
const PROVIDER_API_KEY_ID = "openai";

/** A real MCP endpoint that records every request, so an anonymous attempt cannot hide. */
interface RecordingServer {
	url: string;
	/** Every `Authorization` header a POST carried, in order — `""` for an anonymous request. */
	seen: string[];
	/** The token the server accepts; `undefined` accepts anyone. */
	accept(token: string | undefined): void;
	stop(): void;
}

function recordingMcpServer(accepted: string | undefined): RecordingServer {
	let current = accepted;
	const seen: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			// A streamable-HTTP client also opens a GET stream and sends a DELETE on close; neither
			// carries a JSON-RPC body, and counting their headers would blur what the POSTs saw.
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const authorization = request.headers.get("authorization") ?? "";
			seen.push(authorization);
			if (current !== undefined && authorization !== `Bearer ${current}`) {
				return Response.json({ error: "unauthorized" }, { status: 401 });
			}
			const body = (await request.json()) as { id?: string | number; method?: string };
			if (body.id === undefined) return new Response(null, { status: 202 });
			if (body.method === "initialize") {
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						protocolVersion: "2024-11-05",
						capabilities: { tools: {} },
						serverInfo: { name: "recording", version: "1.0.0" },
					},
				});
			}
			if (body.method === "tools/list") {
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object" } }] },
				});
			}
			return Response.json({ jsonrpc: "2.0", id: body.id, result: { ok: true } });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/mcp`,
		seen,
		accept: token => {
			current = token;
		},
		stop: () => server.stop(true),
	};
}

describe("a credential that cannot be presented is not sent anonymously", () => {
	let authStorage: AuthStorage;
	let servers: RecordingServer[];
	let managers: MCPManager[];

	beforeEach(async () => {
		authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		await authStorage.reload();
		servers = [];
		managers = [];
		// The failure paths log deliberately; the assertions read the thrown error, not the log.
		vi.spyOn(logger, "warn").mockImplementation(() => {});

		// Bystanders in the same store. A refusal must not touch them.
		await authStorage.set(PROVIDER_OAUTH_ID, {
			type: "oauth",
			access: "provider-access",
			refresh: "provider-refresh",
			expires: Date.now() + 3_600_000,
		});
		await authStorage.set(PROVIDER_API_KEY_ID, { type: "api_key", key: "provider-api-key" });
	});

	afterEach(async () => {
		for (const manager of managers) await manager.disconnectAll().catch(() => {});
		for (const server of servers) server.stop();
		authStorage.close();
		vi.restoreAllMocks();
	});

	function serving(accepted: string | undefined): RecordingServer {
		const server = recordingMcpServer(accepted);
		servers.push(server);
		return server;
	}

	function managing(): MCPManager {
		const manager = new MCPManager(process.cwd());
		manager.setAuthStorage(authStorage);
		managers.push(manager);
		return manager;
	}

	/** Store the MCP credential this suite's server config points at. */
	async function storeCredential(options: { expires: number; refresh: string }): Promise<void> {
		await authStorage.set(MCP_CREDENTIAL_ID, {
			type: "oauth",
			access: ACCESS_TOKEN,
			refresh: options.refresh,
			expires: options.expires,
		});
	}

	function oauthServerConfig(server: RecordingServer): MCPServerConfig {
		return {
			type: "http",
			url: server.url,
			auth: { type: "oauth", credentialId: MCP_CREDENTIAL_ID, tokenUrl: TOKEN_URL },
		};
	}

	function bystanders(): Record<string, unknown> {
		return {
			apiKey: authStorage.get(PROVIDER_API_KEY_ID),
			oauth: authStorage.get(PROVIDER_OAUTH_ID),
		};
	}

	/** Connect through the production entry point and collect what an operator would see. */
	async function connect(
		manager: MCPManager,
		config: MCPServerConfig,
	): Promise<{ error: string | undefined; events: McpConnectionStatusEvent[] }> {
		const events: McpConnectionStatusEvent[] = [];
		const result = await manager.connectServers({ recording: config }, {}, event => {
			events.push(event);
		});
		return { error: result.errors.get("recording"), events };
	}

	function failureEvent(events: McpConnectionStatusEvent[]): McpConnectionStatusEvent | undefined {
		return events.find(event => event.type === "failed");
	}

	it("refuses the connection and names the reauth command when the credential was revoked", async () => {
		// The refresh helper disables the row and answers `{ credential: undefined, removed: true }`.
		// Before the fix that returned a config with no Authorization and the connect went ahead.
		await storeCredential({ expires: Date.now() - 60_000, refresh: REFRESH_TOKEN });
		vi.spyOn(oauthFlow, "refreshMCPOAuthToken").mockRejectedValue(
			new Error('MCP OAuth refresh failed: 400 {"error":"invalid_grant","error_description":"revoked"}'),
		);
		const server = serving(ACCESS_TOKEN);
		const manager = managing();

		const { error, events } = await connect(manager, oauthServerConfig(server));

		expect(error).toContain("was rejected and cleared");
		expect(error).toContain("/mcp reauth <name>");
		expect(error).toContain(server.url);
		// Measured at the far end: nothing was sent, so the server has no failed-auth counter to
		// increment and no anonymous request to log.
		expect(server.seen).toEqual([]);
		expect(manager.getConnectedServers()).toEqual([]);
		const failed = failureEvent(events);
		expect(failed?.type).toBe("failed");
		expect(failed && "error" in failed ? failed.error : undefined).toBe(error);
	});

	it("refuses the connection and says to retry when the credential store cannot be read", async () => {
		// A store I/O error says nothing about the credential, so the credential must survive and
		// the sentence must send the operator to a retry rather than to a fresh authorization.
		await storeCredential({ expires: Date.now() - 60_000, refresh: REFRESH_TOKEN });
		const before = bystanders();
		vi.spyOn(authStorage, "refreshStoredOAuthCredential").mockRejectedValue(
			new Error("SQLITE_IOERR: disk I/O error reading agent.db"),
		);
		const server = serving(ACCESS_TOKEN);
		const manager = managing();

		const { error } = await connect(manager, oauthServerConfig(server));

		expect(error).toContain("could not be read or renewed");
		expect(error).toContain("/mcp reconnect <name>");
		expect(server.seen).toEqual([]);
		// Nothing was deleted: the store failed, the credential did not.
		expect(authStorage.get(MCP_CREDENTIAL_ID)).toBeDefined();
		expect(bystanders()).toEqual(before);
	});

	it("reports a definitive rejection as revoked even when it arrives as an exception", async () => {
		// The refresh helper answers `{ removed: true }` when it manages to disable the row, but a
		// persist that itself fails throws the provider's rejection instead. Same credential state,
		// different route, and the operator still needs a new authorization rather than a retry.
		await storeCredential({ expires: Date.now() - 60_000, refresh: REFRESH_TOKEN });
		vi.spyOn(authStorage, "refreshStoredOAuthCredential").mockRejectedValue(
			new Error('MCP OAuth refresh failed: 400 {"error":"invalid_grant","error_description":"revoked"}'),
		);
		const server = serving(ACCESS_TOKEN);
		const manager = managing();

		const { error } = await connect(manager, oauthServerConfig(server));

		expect(error).toContain("was rejected and cleared");
		expect(error).not.toContain("could not be read or renewed");
		expect(server.seen).toEqual([]);
	});

	it("refuses the connection and names the broker when an expired token cannot be renewed here", async () => {
		// The refresh token is held by the auth broker and redacted locally, so this process has
		// nothing to refresh with and the access token is already dead.
		await storeCredential({ expires: Date.now() - 60_000, refresh: REMOTE_REFRESH_SENTINEL });
		const refreshSpy = vi.spyOn(oauthFlow, "refreshMCPOAuthToken");
		const server = serving(ACCESS_TOKEN);
		const manager = managing();

		const { error } = await connect(manager, oauthServerConfig(server));

		expect(error).toContain("held by the auth broker");
		expect(error).toContain("/mcp reauth <name>");
		expect(server.seen).toEqual([]);
		// No token endpoint was called either: there is no refresh token to send.
		expect(refreshSpy).not.toHaveBeenCalled();
		// The row stays, because the broker can still authorize it again.
		expect(authStorage.get(MCP_CREDENTIAL_ID)).toBeDefined();
	});

	it("still connects when a broker-held refresh fails but the access token is live", async () => {
		// Inside the five-minute refresh buffer the access token still works. Refusing here would
		// end a working session over a renewal it did not need yet, which is the opposite mistake.
		await storeCredential({ expires: Date.now() + 60_000, refresh: REMOTE_REFRESH_SENTINEL });
		const server = serving(ACCESS_TOKEN);
		const manager = managing();

		const { error } = await connect(manager, oauthServerConfig(server));

		expect(error).toBeUndefined();
		expect(manager.getConnectedServers()).toEqual(["recording"]);
		expect(server.seen).toContain(`Bearer ${ACCESS_TOKEN}`);
	});

	it("connects normally when the stored token needs no refresh", async () => {
		// The control. Without it every assertion above could pass against a build that refuses
		// every connection.
		await storeCredential({ expires: Date.now() + 3_600_000, refresh: REFRESH_TOKEN });
		const server = serving(ACCESS_TOKEN);
		const manager = managing();

		const { error } = await connect(manager, oauthServerConfig(server));

		expect(error).toBeUndefined();
		expect(server.seen).toContain(`Bearer ${ACCESS_TOKEN}`);
	});

	it("connects a server that has no stored credential at all", async () => {
		// Nothing was configured, so an anonymous request is what the operator asked for and the
		// server's own answer is the honest one. A refusal here would break every unauthenticated
		// MCP server in existence.
		const server = serving(undefined);
		const manager = managing();

		const { error } = await connect(manager, { type: "http", url: server.url });

		expect(error).toBeUndefined();
		// Handshake, initialized notification and the tool listing — every one of them anonymous,
		// which is the point: nothing invented a header for a server that declared none.
		expect(server.seen.length).toBeGreaterThan(0);
		expect(new Set(server.seen)).toEqual(new Set([""]));
	});

	it("lets reauth's deliberate unauthenticated probe through", async () => {
		// `/mcp reauth` must observe the server's bare 401 to discover its OAuth metadata, so it
		// asks for resolution with `oauth: false`. That path never had a credential to present and
		// must not be turned into a failure.
		await storeCredential({ expires: Date.now() - 60_000, refresh: REFRESH_TOKEN });
		vi.spyOn(oauthFlow, "refreshMCPOAuthToken").mockRejectedValue(new Error("invalid_grant"));
		const server = serving(ACCESS_TOKEN);
		const manager = managing();

		const prepared = await manager.prepareConfig(oauthServerConfig(server), { oauth: false });

		expect(prepared.type === "http" ? prepared.headers?.Authorization : "unexpected").toBeUndefined();
	});

	it("attributes a mid-session revocation to the credential rather than to the server", async () => {
		// The 401 arrives on a live connection, the auth-retry hook re-resolves, and resolution now
		// fails. The request must surface the credential's state; before the fix the hook returned
		// a header-less config and the reader saw the server's 401 body.
		await storeCredential({ expires: Date.now() + 3_600_000, refresh: REFRESH_TOKEN });
		const server = serving(ACCESS_TOKEN);
		const manager = managing();
		expect((await connect(manager, oauthServerConfig(server))).error).toBeUndefined();
		const connection = await manager.waitForConnection("recording");

		server.accept("rotated-server-side");
		vi.spyOn(oauthFlow, "refreshMCPOAuthToken").mockRejectedValue(
			new Error('MCP OAuth refresh failed: 400 {"error":"invalid_grant"}'),
		);

		// `listTools` answers from `connection.tools` once the handshake cached them, so the
		// request goes through the transport the hook is wired to.
		await expect(connection.transport.request("tools/list", {})).rejects.toThrow(/was rejected and cleared/);
	});

	it("never puts token bytes in the sentence an operator reads", async () => {
		// A refresh endpoint's body is exactly the text that carries a token, and the failure
		// travels as `cause` for the log. A diagnostic that prints what it protected is the leak it
		// reported, so BOTH routes are checked: the one that answers `removed` and drops the cause,
		// and the one that throws with the body attached.
		await storeCredential({ expires: Date.now() - 60_000, refresh: REFRESH_TOKEN });
		const leaky = `MCP OAuth refresh failed: 400 {"error":"invalid_grant","access_token":"${ACCESS_TOKEN}","refresh_token":"${REFRESH_TOKEN}"}`;
		vi.spyOn(oauthFlow, "refreshMCPOAuthToken").mockRejectedValue(new Error(leaky));
		const server = serving(ACCESS_TOKEN);
		const manager = managing();

		const { error } = await connect(manager, oauthServerConfig(server));

		expect(error).toBeDefined();
		expect(error).not.toContain(ACCESS_TOKEN);
		expect(error).not.toContain(REFRESH_TOKEN);

		// The same body, this time thrown out of the store so it reaches the classifier as a cause.
		await storeCredential({ expires: Date.now() - 60_000, refresh: REFRESH_TOKEN });
		vi.spyOn(authStorage, "refreshStoredOAuthCredential").mockRejectedValue(new Error(leaky));
		const second = managing();

		const thrown = await connect(second, oauthServerConfig(server));

		expect(thrown.error).toBeDefined();
		expect(thrown.error).not.toContain(ACCESS_TOKEN);
		expect(thrown.error).not.toContain(REFRESH_TOKEN);
	});

	it("gives every failure reason a sentence that names the server and an action", () => {
		// Enumerated from the exported list, and pinned by exact equality: a fourth reason turns
		// this red until someone writes its sentence and records the decision here.
		expect(MCP_AUTH_FAILURE_REASONS).toEqual(["revoked", "broker-redacted", "store-unavailable"]);
		const target = "MCP server at https://mcp.example.com/mcp";
		for (const reason of MCP_AUTH_FAILURE_REASONS) {
			const message = mcpAuthRequiredMessage(reason, target);
			expect(message).toContain(target);
			expect(message).toContain("Fix: ");
			expect(message).toMatch(/`\/mcp (reauth|reconnect) <name>`/);
			expect(new MCPAuthRequiredError(reason, target).reason).toBe(reason);
		}
	});
});
