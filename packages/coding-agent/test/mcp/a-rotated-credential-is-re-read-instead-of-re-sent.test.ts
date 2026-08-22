/**
 * WHY. A `!command` config value is how an operator keeps a credential out of a config file:
 * `!op read op://vault/mcp/token`, `!gcloud auth print-access-token`, `!vault kv get …`. Those
 * commands return SHORT-LIVED values. The resolution cache is keyed by the command TEXT, which is
 * byte-identical before and after the secret behind it rotates, so once a value was cached the
 * product re-sent it forever: the server answered 401, the transport retried with the same header,
 * and the only cure was restarting the process. Worse, the auth-retry hook was installed only for
 * servers with a stored OAuth credential, so a server authenticated purely by a command had no
 * refresh path at all — the 401 could not even be reacted to.
 *
 * THE CLASS THIS CLOSES. Not "a 401 on one endpoint re-runs one command". The invariant is that
 * every route which LEARNS a credential is stale re-reads it, every route which learns nothing
 * does not, and one rotation costs one execution of the command however many callers noticed. The
 * three learning routes are a 401/403 answer, an operator-driven reconnect, and a config reload;
 * the non-learning route is an automatic reconnect after a dropped transport, which is the one
 * that must stay cached, because a password-manager command re-run per reconnect is a stream of
 * unlock prompts during a server restart.
 *
 * These drive the real `MCPManager` against a real HTTP MCP server that rejects the old token and
 * accepts the new one, with a real executable minting the token and counting its own executions.
 *
 * WHAT IT DOES NOT CATCH. The synchronous resolver in `model-registry.ts` caches provider API keys
 * through the same policy, and a provider 401 does not invalidate them: that is a separate row
 * with a separate owner. Nor is anything here a bound on how often a command may run — the cost
 * argument is made by the automatic-reconnect case, not by a rate limit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createCommandResolutionPolicy } from "@veyyon/coding-agent/config/config-value-resolution";
import {
	clearConfigValueCache,
	invalidateConfigValue,
	resolveConfigValue,
} from "@veyyon/coding-agent/config/resolve-config-value";
import { MCPManager } from "@veyyon/coding-agent/mcp/manager";
import type { MCPServerConfig } from "@veyyon/coding-agent/mcp/types";
import * as natives from "@veyyon/natives";
import { logger } from "@veyyon/utils";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const makeTempDir = useTrackedTempDirs("veyyon-rotating-credential-");

/** A real executable that prints the current token and records that it ran. */
interface Minter {
	/** The `!command` config value that runs it. */
	value: string;
	/** How many times the command has executed. */
	runs(): number;
	/** Change the secret the command will print from now on. */
	rotate(token: string): void;
}

function tokenMinter(dir: string, name: string, token: string, prefix = ""): Minter {
	const tokenPath = path.join(dir, `${name}.token`);
	const runsPath = path.join(dir, `${name}.runs`);
	const scriptPath = path.join(dir, `${name}.sh`);
	fs.writeFileSync(tokenPath, token);
	fs.writeFileSync(runsPath, "");
	// Appends one byte per execution, so the count is the file's size and no output parsing or
	// in-process counter can flatter it: this is a separate process the resolver spawned.
	// The prefix is part of the command's output because a `!command` must be the WHOLE config
	// value — `Bearer !cmd` is a literal header, not an indirection, which is a mistake worth
	// having the fixture make impossible.
	fs.writeFileSync(
		scriptPath,
		`printf r >> ${JSON.stringify(runsPath)}\nprintf %s ${JSON.stringify(prefix)}\ncat ${JSON.stringify(tokenPath)}\n`,
	);
	return {
		value: `!sh ${scriptPath}`,
		runs: () => fs.statSync(runsPath).size,
		rotate: next => fs.writeFileSync(tokenPath, next),
	};
}

/** A real MCP endpoint that answers 401 to every token but the one it currently accepts. */
interface RotatingServer {
	url: string;
	/** The token the server will accept from now on. */
	accept(token: string): void;
	/** Every `Authorization` header the server has seen, in order. */
	seen: string[];
	stop(): void;
}

function rotatingMcpServer(accepted: string): RotatingServer {
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
			if (authorization !== `Bearer ${current}`) {
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
						serverInfo: { name: "rotating", version: "1.0.0" },
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
		accept: token => {
			current = token;
		},
		seen,
		stop: () => server.stop(true),
	};
}

describe("a rotated credential is re-read instead of re-sent", () => {
	let dir: string;
	let servers: RotatingServer[];
	let managers: MCPManager[];

	beforeEach(() => {
		dir = makeTempDir();
		servers = [];
		managers = [];
		clearConfigValueCache();
		// `reportUnresolvedConfigValue` logs, and one case here deliberately fails a command.
		vi.spyOn(logger, "warn").mockImplementation(() => {});
	});

	afterEach(async () => {
		for (const manager of managers) await manager.disconnectAll().catch(() => {});
		for (const server of servers) server.stop();
		clearConfigValueCache();
		vi.restoreAllMocks();
	});

	function serving(accepted: string): RotatingServer {
		const server = rotatingMcpServer(accepted);
		servers.push(server);
		return server;
	}

	/** A connected manager for one command-authenticated HTTP server. */
	async function connected(name: string, config: MCPServerConfig): Promise<MCPManager> {
		const manager = new MCPManager(dir);
		managers.push(manager);
		const result = await manager.connectServers({ [name]: config }, {});
		expect(result.errors.get(name)).toBeUndefined();
		return manager;
	}

	function commandAuthenticated(server: RotatingServer, minter: Minter): MCPServerConfig {
		return { type: "http", url: server.url, headers: { Authorization: minter.value } };
	}

	it("re-runs the command when the server rejects the token, and succeeds without a restart", async () => {
		// Before the fix this server had no auth-retry hook at all, because it has no stored OAuth
		// credential — so the 401 was terminal until the process restarted.
		const minter = tokenMinter(dir, "mint", "token-a", "Bearer ");
		const server = serving("token-a");
		const manager = await connected("rotating", commandAuthenticated(server, minter));
		expect(minter.runs()).toBe(1);

		minter.rotate("token-b");
		server.accept("token-b");
		const connection = await manager.waitForConnection("rotating");
		if (!connection) throw new Error("expected the server to be connected");

		const result = await connection.transport.request("tools/list", {});

		expect(result).toEqual({ tools: [{ name: "ping", description: "ping", inputSchema: { type: "object" } }] });
		expect(minter.runs()).toBe(2);
		// The rejected token was sent once, then the fresh one — and the fresh one is what the
		// retry carried, not a second copy of the stale header.
		expect(server.seen.at(-2)).toBe("Bearer token-a");
		expect(server.seen.at(-1)).toBe("Bearer token-b");
	});

	it("charges one rotation one execution, however many callers noticed the 401", async () => {
		const minter = tokenMinter(dir, "mint", "token-a", "Bearer ");
		const server = serving("token-a");
		const manager = await connected("rotating", commandAuthenticated(server, minter));
		const connection = await manager.waitForConnection("rotating");
		if (!connection) throw new Error("expected the server to be connected");

		minter.rotate("token-b");
		server.accept("token-b");
		const both = await Promise.all([
			connection.transport.request("tools/list", {}),
			connection.transport.request("tools/list", {}),
		]);

		expect(both).toHaveLength(2);
		// Two 401s at the same instant is one rotation. A per-caller re-run would be two unlock
		// prompts from a password manager, which is how a correct gate gets turned off.
		expect(minter.runs()).toBe(2);
	});

	it("re-reads on an operator-driven reconnect and stays cached on an automatic one", async () => {
		const minter = tokenMinter(dir, "mint", "token-a", "Bearer ");
		const server = serving("token-a");
		const manager = await connected("rotating", commandAuthenticated(server, minter));
		expect(minter.runs()).toBe(1);

		// A dropped transport is no evidence about a credential, so this reconnect must reuse the
		// cached value: re-running the command per reconnect is what makes a restarting server
		// unusable.
		await manager.reconnectServer("rotating");
		expect(minter.runs()).toBe(1);

		minter.rotate("token-b");
		server.accept("token-b");
		await manager.reconnectServer("rotating", { manual: true });

		expect(minter.runs()).toBe(2);
		expect(server.seen.at(-1)).toBe("Bearer token-b");
	});

	it("re-reads the MCP commands a reload covers and leaves every other command cached", async () => {
		const mcpMinter = tokenMinter(dir, "mcp", "token-a", "Bearer ");
		const providerMinter = tokenMinter(dir, "provider", "provider-key");
		const server = serving("token-a");
		const manager = await connected("rotating", commandAuthenticated(server, mcpMinter));
		expect(await resolveConfigValue(providerMinter.value)).toBe("provider-key");
		expect(providerMinter.runs()).toBe(1);

		// What `/mcp reload` does before it re-reads the config files.
		const dropped = manager.invalidateCommandCredentials();

		expect(dropped).toBe(1);
		mcpMinter.rotate("token-b");
		server.accept("token-b");
		await manager.reconnectServer("rotating");
		expect(mcpMinter.runs()).toBe(2);
		// A command that mints a provider key is not part of an MCP reload, and re-running it would
		// be a cost the operator did not ask for.
		expect(await resolveConfigValue(providerMinter.value)).toBe("provider-key");
		expect(providerMinter.runs()).toBe(1);
	});

	it("re-reads only the server it was named, not every server that has a command", async () => {
		const rotating = tokenMinter(dir, "mint", "token-a", "Bearer ");
		const untouched = tokenMinter(dir, "other", "other-a", "Bearer ");
		const rotatingServer = serving("token-a");
		const otherServer = serving("other-a");
		const manager = new MCPManager(dir);
		managers.push(manager);
		const result = await manager.connectServers(
			{
				rotating: commandAuthenticated(rotatingServer, rotating),
				other: commandAuthenticated(otherServer, untouched),
			},
			{},
		);
		expect(result.errors.size).toBe(0);
		expect(untouched.runs()).toBe(1);

		expect(manager.invalidateCommandCredentials("rotating")).toBe(1);
		rotating.rotate("token-b");
		rotatingServer.accept("token-b");
		await manager.reconnectServer("rotating");
		await manager.reconnectServer("other");

		expect(rotating.runs()).toBe(2);
		// One server's 401 is not evidence about another server's credential, and a rotation that
		// re-reads every vault entry in the config is the cost this scoping exists to avoid.
		expect(untouched.runs()).toBe(1);
	});

	it("installs no auth-retry hook for a server whose credentials cannot be re-read", async () => {
		// The gate widened to cover commands; it must not have widened to everything. A literal
		// header has nothing to re-run, so a 401 on it is the operator's to fix.
		const server = serving("static-token");
		const manager = await connected("static", {
			type: "http",
			url: server.url,
			headers: { Authorization: "Bearer static-token" },
		});
		const connection = await manager.waitForConnection("static");
		if (!connection) throw new Error("expected the server to be connected");

		expect("onAuthError" in connection.transport).toBe(true);
		expect(Reflect.get(connection.transport, "onAuthError")).toBeUndefined();
	});

	it("names nothing to re-read when a server's credentials are literals", async () => {
		const server = serving("static-token");
		const manager = await connected("static", {
			type: "http",
			url: server.url,
			headers: { Authorization: "Bearer static-token" },
		});

		expect(manager.invalidateCommandCredentials()).toBe(0);
		expect(manager.invalidateCommandCredentials("static")).toBe(0);
	});

	it("does not join a run that started before the rotation", async () => {
		// The ordering the join rule must NOT swallow: a run is already reading the OLD secret when
		// the rotation is learned. Joining it hands the rotated caller the value that was just
		// rejected, which looks exactly like no fix at all. The command is held open through the
		// real resolver's own shell seam so the two runs overlap without a clock.
		const releaseFirst = Promise.withResolvers<void>();
		let calls = 0;
		vi.spyOn(natives, "executeShell").mockImplementation(async (_options, onChunk) => {
			calls += 1;
			if (calls === 1) {
				await releaseFirst.promise;
				onChunk?.(null, "Bearer token-a");
			} else {
				onChunk?.(null, "Bearer token-b");
			}
			return { exitCode: 0, cancelled: false, timedOut: false };
		});

		const first = resolveConfigValue("!mint-token");
		await Promise.resolve();
		invalidateConfigValue("!mint-token");
		const second = await resolveConfigValue("!mint-token");
		releaseFirst.resolve();

		expect(second).toBe("Bearer token-b");
		// The run that predates the rotation still answers its own caller — it asked before — but
		// its value must not survive into the cache the rotated caller reads.
		expect(await first).toBe("Bearer token-a");
		expect(await resolveConfigValue("!mint-token")).toBe("Bearer token-b");
		expect(calls).toBe(2);
	});

	it("reports whether a config value was a command at all", () => {
		// An environment reference and a literal are read afresh on every resolution, so there is
		// nothing to drop and the caller is told so rather than believing it invalidated something.
		expect(invalidateConfigValue("!echo hi")).toBe(true);
		expect(invalidateConfigValue("HOME")).toBe(false);
		expect(invalidateConfigValue("sk-literal-value")).toBe(false);
	});

	it("keeps a failing command's back-off across an invalidation", () => {
		// The back-off is what stops a broken command being re-run on every resolution. An
		// invalidation says the VALUE is stale, which a command that produced no value never had.
		const policy = createCommandResolutionPolicy(60_000);
		policy.recordFailure("!locked-vault", "an api key", "exited 1");
		expect(policy.isBackedOff("!locked-vault")).toBe(true);

		policy.invalidate("!locked-vault");

		expect(policy.isBackedOff("!locked-vault")).toBe(true);
		expect(policy.getCached("!locked-vault")).toBeUndefined();
	});

	it("refuses to cache the answer of a run that an invalidation overtook", () => {
		// The ordering that produces a resurrected secret: a run reads token A, a rotation is
		// recorded, and then the slow run finishes and writes A back into the cache.
		const policy = createCommandResolutionPolicy(60_000);
		const generation = policy.generationOf("!mint");
		policy.invalidate("!mint");

		policy.recordSuccess("!mint", "token-a", generation);

		expect(policy.getCached("!mint")).toBeUndefined();
		policy.recordSuccess("!mint", "token-b", policy.generationOf("!mint"));
		expect(policy.getCached("!mint")).toBe("token-b");
	});
});
