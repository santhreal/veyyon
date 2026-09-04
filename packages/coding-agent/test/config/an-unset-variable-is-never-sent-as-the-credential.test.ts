/**
 * WHY. `resolveEnvOrLiteral` was `process.env[config] || config`. A config value
 * that names an environment variable therefore resolved to the NAME of the
 * variable whenever the variable was unset or exported empty. One typo
 * (`GITHUB_TOKN`) or one CI secret that did not reach the job, and veyyon sent
 * the string `GITHUB_TOKN` to the server as the credential: a request that
 * cannot succeed, carrying a value that means nothing, answered by whatever the
 * far end says about a bad credential. Nothing in that exchange mentions the
 * variable, so the operator debugs the provider instead of the environment.
 *
 * THE CLASS THIS CLOSES. Not "a better sentence for a missing GITHUB_TOKEN".
 * The invariant is that a value which names a variable is never replaced by the
 * variable's own name: it resolves to the variable's contents or it resolves to
 * nothing, and a consumer that cannot proceed without it refuses to send
 * anything. The MCP refusal is measured at the far end — a recording server that
 * logs every request, and a marker file a spawned child writes — so "nothing was
 * sent" is observed rather than inferred from a header. Every transport in the
 * shipped MCP schema is swept, so a fourth transport with a credential-bearing
 * field cannot be added without a decision recorded here.
 *
 * Both directions are pinned, because a control that only refuses is as wrong as
 * one that only sends: `literal:` transmits verbatim, a resolvable reference
 * transmits the variable's contents, and a failing `!command` keeps its existing
 * skip-the-key behaviour (it has its own back-off and its own report).
 *
 * WHAT IT DOES NOT CATCH. It says nothing about a value that is present and
 * simply wrong — that is the server's 401 to explain. It does not cover the
 * `!command` grammar, which `config-value-command-failures.test.ts` owns, nor
 * the ambiguity that remains for a bare value outside the environment-name shape
 * (`sk_live_...`), which stays env-then-literal on purpose so that fixing a typo
 * does not break configs that cannot make one.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry, type ProviderConfigInput } from "@veyyon/coding-agent/config/model-registry";
import { clearConfigValueCache, resolveConfigValue } from "@veyyon/coding-agent/config/resolve-config-value";
import { MCPManager } from "@veyyon/coding-agent/mcp/manager";
import type { MCPServerConfig } from "@veyyon/coding-agent/mcp/types";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/kernel/session/auth-storage";
import { logger } from "@veyyon/utils";
import mcpSchema from "../../src/config/mcp-schema.json";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

/** The variable every case points at, and never sets unless the case says so. */
const TOKEN_VAR = "VEYYON_TEST_UNSET_CREDENTIAL";
/** A neighbouring secret, so a diagnostic that quotes values is caught quoting one. */
const NEIGHBOUR_VAR = "VEYYON_TEST_NEIGHBOUR_CREDENTIAL";
const NEIGHBOUR_VALUE = "neighbour-secret-do-not-log";

const makeTempDir = useTrackedTempDirs("veyyon-env-ref-");

/** Every request an MCP endpoint received, so a refused connection cannot hide one. */
interface RecordingServer {
	url: string;
	requests: Array<{ method: string; authorization: string }>;
	stop(): void;
}

function recordingMcpServer(): RecordingServer {
	const requests: Array<{ method: string; authorization: string }> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push({ method: request.method, authorization: request.headers.get("authorization") ?? "" });
			if (request.method !== "POST") return new Response(null, { status: 405 });
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
				return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
			}
			return Response.json({ jsonrpc: "2.0", id: body.id, result: { ok: true } });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/mcp`,
		requests,
		stop: () => server.stop(true),
	};
}

/**
 * The transports the shipped schema accepts, and the field of each that carries a
 * credential. Derived from the schema at run time so a new transport fails the
 * equality assertion below until someone records which field of it is a secret.
 */
const CREDENTIAL_FIELD: Record<string, "env" | "headers"> = { stdio: "env", http: "headers", sse: "headers" };

function schemaTransports(): string[] {
	const defs = mcpSchema.$defs as unknown as Record<string, { properties?: Record<string, { const?: string }> }>;
	const variants = (mcpSchema.$defs.serverConfig as unknown as { oneOf: Array<{ $ref: string }> }).oneOf;
	return variants.map(variant => {
		const name = variant.$ref.replace("#/$defs/", "");
		const declared = defs[name]?.properties?.type?.const;
		// The stdio variant leaves `type` optional, which the interface spells as a
		// default rather than a constant; the def name carries it either way.
		return declared ?? name.replace(/Server$/, "");
	});
}

describe("an unset variable is never sent as the credential", () => {
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;
	let servers: RecordingServer[];
	let managers: MCPManager[];

	beforeEach(() => {
		delete process.env[TOKEN_VAR];
		process.env[NEIGHBOUR_VAR] = NEIGHBOUR_VALUE;
		clearConfigValueCache();
		warnings = [];
		servers = [];
		managers = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(async () => {
		for (const manager of managers) await manager.disconnectAll().catch(() => {});
		for (const server of servers) server.stop();
		delete process.env[TOKEN_VAR];
		delete process.env[NEIGHBOUR_VAR];
		clearConfigValueCache();
		vi.restoreAllMocks();
	});

	function serving(): RecordingServer {
		const server = recordingMcpServer();
		servers.push(server);
		return server;
	}

	async function connect(config: MCPServerConfig): Promise<string | undefined> {
		const manager = new MCPManager(process.cwd());
		manager.setAuthStorage(new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:"))));
		managers.push(manager);
		const result = await manager.connectServers({ probe: config }, {});
		return result.errors.get("probe");
	}

	/** A child that records having been spawned and exits at once. */
	function markerCommand(): { command: string; marker: string; spawned: () => boolean } {
		const dir = makeTempDir();
		const marker = path.join(dir, "spawned");
		const script = path.join(dir, "server.sh");
		fs.writeFileSync(script, `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
		return { command: script, marker, spawned: () => fs.existsSync(marker) };
	}

	it("maps every transport the shipped schema accepts to the field that carries its credential", () => {
		// Fail by default: a fourth transport arrives here before it can carry an
		// unresolved reference into a request nobody swept.
		expect(schemaTransports().sort()).toEqual(Object.keys(CREDENTIAL_FIELD).sort());
	});

	it.each(schemaTransports())(
		"refuses to connect a %p server whose credential names an unset variable",
		async transport => {
			const server = transport === "stdio" ? undefined : serving();
			const marker = transport === "stdio" ? markerCommand() : undefined;
			const config = (
				marker
					? { type: "stdio", command: marker.command, env: { TOKEN: `\${${TOKEN_VAR}}` } }
					: { type: transport, url: server?.url, headers: { Authorization: `\${${TOKEN_VAR}}` } }
			) as MCPServerConfig;

			const error = await connect(config);

			expect(error).toContain(TOKEN_VAR);
			expect(error).toContain("not set");
			expect(error).toContain("literal:");
			// The value is the whole point: nothing may be quoted, and the neighbouring
			// secret is the value a report that reads the environment would reach for.
			expect(error).not.toContain(NEIGHBOUR_VALUE);
			// Measured at the far end rather than inferred from the config we built.
			expect(server?.requests ?? []).toEqual([]);
			expect(marker?.spawned() ?? false).toBe(false);
		},
	);

	it("says so when the variable exists and is empty, which a literal fallback hid", async () => {
		process.env[TOKEN_VAR] = "";
		const server = serving();

		const error = await connect({ type: "http", url: server.url, headers: { Authorization: TOKEN_VAR } });

		expect(error).toContain(TOKEN_VAR);
		expect(error).toContain("set but empty");
		expect(server.requests).toEqual([]);
	});

	it("sends the variable's contents when it is set", async () => {
		process.env[TOKEN_VAR] = "Bearer real-token";
		const server = serving();

		const error = await connect({ type: "http", url: server.url, headers: { Authorization: `\${${TOKEN_VAR}}` } });

		expect(error).toBeUndefined();
		expect(server.requests.some(request => request.authorization === "Bearer real-token")).toBe(true);
	});

	it("sends a literal: value verbatim, which is how a key shaped like a variable name is written", async () => {
		const server = serving();

		const error = await connect({
			type: "http",
			url: server.url,
			headers: { Authorization: `literal:Bearer ${TOKEN_VAR}` },
		});

		expect(error).toBeUndefined();
		expect(server.requests.some(request => request.authorization === `Bearer ${TOKEN_VAR}`)).toBe(true);
	});

	it("spawns a stdio server whose reference resolves", async () => {
		// The positive control for the marker: the refusal above is only evidence if
		// a resolvable value does reach a spawn.
		process.env[TOKEN_VAR] = "resolved-token";
		const marker = markerCommand();

		await connect({ type: "stdio", command: marker.command, env: { TOKEN: `\${${TOKEN_VAR}}` } });

		expect(marker.spawned()).toBe(true);
	});

	it("still connects when a !command produces nothing, which keeps its own back-off and report", async () => {
		// A failed command is not an unresolved reference: it has a retry window and a
		// report of its own, and its key is omitted rather than the connection refused.
		const server = serving();

		const error = await connect({ type: "http", url: server.url, headers: { Authorization: "!true" } });

		expect(error).toBeUndefined();
		expect(server.requests.some(request => request.authorization === "")).toBe(true);
	});

	describe("the diagnostic", () => {
		const report = () =>
			warnings.filter(
				w => w.message === "A configured environment variable is unset, so the setting it resolves is unset",
			);

		it("names the variable and the setting, and quotes no value", async () => {
			const resolved = await resolveConfigValue(`\${${TOKEN_VAR}}`, 'header "X-Api-Key"');

			expect(resolved).toBeUndefined();
			expect(report()).toHaveLength(1);
			expect(report()[0]?.fields).toEqual({
				setting: 'header "X-Api-Key"',
				variable: TOKEN_VAR,
				state: "not set",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: the config grammar's own spelling, not an interpolation
				form: "${NAME} reference",
				fix: `Export ${TOKEN_VAR} with the value, or write the value in the config as literal:<value>. Nothing was sent: the variable's own name is never used as the credential.`,
			});
			expect(JSON.stringify(report())).not.toContain(NEIGHBOUR_VALUE);
		});

		it("reports one missing variable once, however often the value is resolved", async () => {
			for (let i = 0; i < 5; i++) await resolveConfigValue(TOKEN_VAR, "provider API key");

			expect(report()).toHaveLength(1);
			expect(report()[0]?.fields.form).toBe("bare environment name");
		});
	});

	describe("a provider API key", () => {
		let authStorage: AuthStorage;
		let registry: ModelRegistry;

		const model: NonNullable<ProviderConfigInput["models"]>[number] = {
			id: "probe-model",
			name: "Probe Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		};

		beforeEach(async () => {
			const dir = makeTempDir();
			authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
			registry = new ModelRegistry(authStorage, path.join(dir, "models.json"), {
				fetch: () => Promise.reject(new Error("network disabled in env-reference test")),
			});
		});

		afterEach(() => {
			registry.clearSourceRegistrations("ext://probe");
			authStorage.close();
		});

		function authorizationOf(apiKey: string): string | undefined {
			registry.registerProvider(
				"probe-provider",
				{
					baseUrl: "https://probe.example.com/v1",
					api: "openai-completions",
					apiKey,
					authHeader: true,
					models: [model],
				},
				"ext://probe",
			);
			return registry.find("probe-provider", "probe-model")?.headers?.Authorization;
		}

		it("sends no Authorization header at all when the key names an unset variable", () => {
			const authorization = authorizationOf(`\${${TOKEN_VAR}}`);

			expect(authorization).toBeUndefined();
		});

		it("never falls back to the variable's own name", () => {
			// The defect exactly: the header used to carry the identifier as the secret.
			const authorization = authorizationOf(TOKEN_VAR);

			expect(authorization).toBeUndefined();
		});

		it("sends the variable's contents when it is set, and a literal: key verbatim", () => {
			process.env[TOKEN_VAR] = "resolved-provider-key";

			expect(authorizationOf(`\${${TOKEN_VAR}}`)).toBe("Bearer resolved-provider-key");

			registry.clearSourceRegistrations("ext://probe");
			expect(authorizationOf(`literal:${TOKEN_VAR}`)).toBe(`Bearer ${TOKEN_VAR}`);
		});
	});
});
