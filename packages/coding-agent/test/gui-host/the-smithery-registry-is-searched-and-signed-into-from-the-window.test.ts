/**
 * WHY: the terminal's `/mcp search`, `/mcp smithery-login` and
 * `/mcp smithery-logout` reach the Smithery registry with the profile's own
 * key, and a search result the operator picks becomes a server in the
 * profile's `mcp.json`. The window has one action per step:
 * `SearchMcpRegistry`, `DeployMcpRegistryServer`, `LoginMcpRegistry` (drawn
 * through `AuthFlow` under the provider `smithery`) and `LogoutMcpRegistry`.
 * The defect class this closes is a step whose effect lands outside the
 * profile or is not the one it reports: a key stored in another profile's
 * directory, or filed as an api key under the flow's provider name; a key the
 * registry rejects stored anyway; a sign-in that keeps polling after it is
 * cancelled; a deploy that writes a result the window never saw, or skips a
 * required input; a suggested name that collides with a server just added.
 *
 * Smithery is the one boundary faked here: `fetch` answers for the login and
 * registry hosts, and every other request, the deployed server's included,
 * reaches the network stack. The deployed server is a loopback HTTP MCP
 * endpoint, so its row is what the protocol produced.
 *
 * What it does NOT catch: a deploy of a stdio result, which launches
 * `bunx @smithery/cli` and needs the network; its input values reaching the
 * launch arguments are pinned only by the refusal of missing and undeclared
 * inputs here.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@veyyon/ai";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { AuthFlowView, McpRegistryView, McpServerView } from "../../src/gui-host/wire";
import { readMCPConfigFile } from "../../src/mcp/config-writer";
import { MCPManager } from "../../src/mcp/manager";
import { getSmitheryApiKey, getSmitheryLoginUrl, saveSmitheryApiKey } from "../../src/mcp/smithery-auth";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { OAUTH_TOOL, type OAuthMcpServer, startOAuthMcpServer } from "./oauth-mcp-server";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

const REGISTRY_ORIGIN = "https://registry.smithery.ai";
const LOGIN_ORIGIN = new URL(getSmitheryLoginUrl()).origin;
const SESSION_ID = "cli-session";
const AUTH_URL = `${LOGIN_ORIGIN}/cli/authorize?session=${SESSION_ID}`;
const VALID_KEY = "valid-key";
const passthroughFetch = globalThis.fetch;

type PollAnswer = { status: "pending" } | { status: "success"; apiKey: string };

/** Smithery as the tests see it: the keys it honors, and what its login poll answers. */
interface FakeSmithery {
	keys: Set<string>;
	poll: PollAnswer;
	/** The cancel signal each poll was sent with. */
	pollSignals: AbortSignal[];
}

let root = "";
let agentDir = "";
let authStorage: AuthStorage;
let deployed: OAuthMcpServer;
let smithery: FakeSmithery;
let host: GuiHostServer | undefined;
let client: TestSocketClient;
let nextId = 1;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const ENTRIES = [
	{ id: "srv-plain", qualifiedName: "@acme/weather", namespace: "acme", slug: "weather", displayName: "Weather" },
	{
		id: "srv-inputs",
		qualifiedName: "@acme/weather-pro",
		namespace: "acme",
		slug: "weather-pro",
		displayName: "Weather Pro",
	},
];

function details(slug: string): Record<string, unknown> | undefined {
	if (slug === "weather") {
		return {
			qualifiedName: "@acme/weather",
			displayName: "Weather",
			description: "Forecasts",
			connections: [{ type: "http", deploymentUrl: deployed.url }],
		};
	}
	if (slug === "weather-pro") {
		return {
			qualifiedName: "@acme/weather-pro",
			displayName: "Weather Pro",
			description: "Forecasts with a key",
			connections: [
				{
					type: "stdio",
					configSchema: {
						required: ["apiKey"],
						properties: {
							apiKey: { type: "string" },
							units: { type: "string", default: "metric", enum: ["metric", "imperial"] },
						},
					},
				},
			],
		};
	}
	return undefined;
}

function answerRegistry(url: URL, init: RequestInit | undefined): Response {
	const key = new Headers(init?.headers).get("Authorization")?.replace(/^Bearer /, "");
	if (!key || !smithery.keys.has(key)) return json({ error: "unauthorized" }, 401);
	if (url.pathname === "/servers") {
		return json({
			servers: ENTRIES.map((entry, index) => ({ ...entry, useCount: 42 - index * 35, verified: index === 0 })),
		});
	}
	const found = details(url.pathname.slice("/servers/acme/".length));
	return found ? json(found) : json({ error: "not found" }, 404);
}

function answerLogin(url: URL, init: RequestInit | undefined): Response {
	if (url.pathname === "/api/auth/cli/session") return json({ sessionId: SESSION_ID, authUrl: AUTH_URL });
	if (url.pathname === `/api/auth/cli/poll/${SESSION_ID}`) {
		if (init?.signal) smithery.pollSignals.push(init.signal);
		return json(smithery.poll);
	}
	return json({ error: "not found" }, 404);
}

function fakeSmithery(): void {
	const impl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin === REGISTRY_ORIGIN) return answerRegistry(url, init);
		if (url.origin === LOGIN_ORIGIN) return answerLogin(url, init);
		return passthroughFetch(input, init);
	}) as unknown as typeof fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation(impl);
}

/** Reads frames, starting with `seen`, until one satisfies `done`; returns every frame read. */
async function readUntil(seen: RequestFrame[], done: (frame: RequestFrame) => boolean): Promise<RequestFrame[]> {
	const frames = [...seen];
	while (!frames.some(done)) frames.push((await client.nextFrame()) as RequestFrame);
	return frames;
}

function smitheryFlow(frame: RequestFrame): AuthFlowView | undefined {
	const flow = frame.Snapshot?.AuthFlow as AuthFlowView | undefined;
	return flow?.provider === "smithery" ? flow : undefined;
}

async function send(action: unknown): Promise<{ frames: RequestFrame[]; outcome: RequestFrame }> {
	return client.request(nextId++, action);
}

async function succeeds(action: unknown): Promise<RequestFrame[]> {
	const { frames, outcome } = await send(action);
	expect(outcome.RequestFailed).toBeUndefined();
	return frames;
}

async function failsWith(action: unknown): Promise<string | undefined> {
	const { outcome } = await send(action);
	expect(outcome.RequestFailed?.error.scope).toBe("Mcp");
	return outcome.RequestFailed?.error.code;
}

function registryIn(frames: RequestFrame[]): McpRegistryView | undefined {
	return snapshotSections<McpRegistryView>(frames, "McpRegistry").at(-1);
}

const SEARCH = { SearchMcpRegistry: { query: "weather", limit: null, semantic: false } };

beforeEach(async () => {
	// The environment's key is read before the profile's; a set one would sign every test in.
	expect(process.env.SMITHERY_API_KEY).toBeUndefined();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-smithery-"));
	agentDir = path.join(root, "agent");
	await fs.mkdir(agentDir);
	MCPManager.resetForTests();
	authStorage = await isolatedAuthStorage(root);
	deployed = await startOAuthMcpServer({ open: true });
	smithery = { keys: new Set([VALID_KEY]), poll: { status: "pending" }, pollSignals: [] };
	fakeSmithery();
	host = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: root, agentDir, authStorage });
	client = await TestSocketClient.connect(host.endpoint);
	nextId = 1;
});

afterEach(async () => {
	client.destroy();
	await host?.close();
	host = undefined;
	vi.restoreAllMocks();
	MCPManager.resetForTests();
	await deployed.close();
	authStorage.close();
	await fs.rm(root, { recursive: true, force: true });
});

describe("the smithery registry is searched and signed into from the window", () => {
	test("a search needs the profile's key, and a key the registry rejects fails it", async () => {
		expect(await failsWith(SEARCH)).toBe("MCP_REGISTRY_SIGNED_OUT");
		await saveSmitheryApiKey("revoked-key", agentDir);
		expect(await failsWith(SEARCH)).toBe("MCP_REGISTRY_KEY_REJECTED");
	});

	test("a search lists each result with its inputs and a name no server in the profile holds", async () => {
		await saveSmitheryApiKey(VALID_KEY, agentDir);
		expect(registryIn(await succeeds(SEARCH))).toEqual({
			signed_in: true,
			query: "weather",
			results: [
				{
					id: "srv-plain",
					name: "Weather",
					description: "Forecasts",
					transport: "http",
					use_count: 42,
					verified: true,
					server: "acme-weather",
					warnings: [],
					inputs: [],
				},
				{
					id: "srv-inputs",
					name: "Weather Pro",
					description: "Forecasts with a key",
					transport: "stdio",
					use_count: 7,
					verified: false,
					server: "acme-weather-pro",
					warnings: [
						"Runs through Smithery CLI at runtime (`bunx @smithery/cli run ...`).",
						"Provider requires configuration input defined by Smithery schema.",
					],
					inputs: [
						{
							key: "apiKey",
							label: "apiKey",
							description: null,
							required: true,
							default: null,
							sensitive: true,
							choices: [],
						},
						{
							key: "units",
							label: "units",
							description: null,
							required: false,
							default: "metric",
							sensitive: false,
							choices: ["metric", "imperial"],
						},
					],
				},
			],
		});
	});

	test("deploying a result writes it into the profile, connects it and moves the suggested name on", async () => {
		await saveSmitheryApiKey(VALID_KEY, agentDir);
		await succeeds(SEARCH);
		const frames = await succeeds({
			DeployMcpRegistryServer: { result: "srv-plain", server: "acme-weather", inputs: [] },
		});
		expect(
			snapshotSections<McpServerView[]>(frames, "Mcp")
				.at(-1)
				?.find(row => row.name === "acme-weather"),
		).toEqual({ name: "acme-weather", enabled: true, status: "Connected", tools: [OAUTH_TOOL] });
		expect((await readMCPConfigFile(path.join(agentDir, "mcp.json"))).mcpServers).toEqual({
			"acme-weather": { type: "http", url: deployed.url },
		});
		expect(registryIn(frames)?.results.map(result => result.server)).toEqual(["acme-weather-2", "acme-weather-pro"]);

		expect(
			await failsWith({ DeployMcpRegistryServer: { result: "srv-plain", server: "acme-weather", inputs: [] } }),
		).toBe("MCP_SERVER_NAME_REFUSED");
	});

	test("a deploy names a result of this window's last search and every input that result requires", async () => {
		await saveSmitheryApiKey(VALID_KEY, agentDir);
		const deploy = (result: string, inputs: { key: string; value: string }[]) => ({
			DeployMcpRegistryServer: { result, server: "chosen", inputs },
		});
		expect(await failsWith(deploy("srv-plain", []))).toBe("MCP_REGISTRY_RESULT_UNKNOWN");
		await succeeds(SEARCH);
		expect(await failsWith(deploy("srv-unlisted", []))).toBe("MCP_REGISTRY_RESULT_UNKNOWN");
		expect(await failsWith(deploy("srv-inputs", [{ key: "units", value: "imperial" }]))).toBe("INVALID_ARGUMENTS");
		expect(
			await failsWith(
				deploy("srv-inputs", [
					{ key: "apiKey", value: "k" },
					{ key: "region", value: "eu" },
				]),
			),
		).toBe("INVALID_ARGUMENTS");
		expect((await readMCPConfigFile(path.join(agentDir, "mcp.json"))).mcpServers).toEqual({});
	});

	test("the browser step's key signs the profile in", async () => {
		smithery.poll = { status: "success", apiKey: VALID_KEY };
		const started = await succeeds("LoginMcpRegistry");
		const finished = await readUntil(started, frame => registryIn([frame]) !== undefined);
		const flows = finished.map(smitheryFlow).filter(flow => flow !== undefined);
		expect(flows.map(flow => flow.state)).toEqual(["AwaitingSecret", "Completed"]);
		expect(flows[0]).toMatchObject({ url: AUTH_URL, prompt: "Smithery API key" });
		expect(registryIn(finished)).toEqual({ signed_in: true, query: null, results: [] });
		expect(await getSmitheryApiKey(agentDir)).toBe(VALID_KEY);
	});

	test("a pasted key the registry rejects is reported and another is awaited", async () => {
		const started = await succeeds("LoginMcpRegistry");
		await readUntil(started, frame => smitheryFlow(frame)?.url === AUTH_URL);

		const rejected = await succeeds({ SubmitAuthSecret: { provider: "smithery", secret: "revoked-key" } });
		const reported = await readUntil(
			rejected,
			frame => smitheryFlow(frame)?.message?.startsWith("Smithery rejected the key") === true,
		);
		expect(await getSmitheryApiKey(agentDir)).toBeUndefined();
		expect(reported.map(smitheryFlow).findLast(flow => flow !== undefined)?.state).toBe("AwaitingSecret");

		const accepted = await succeeds({ SubmitAuthSecret: { provider: "smithery", secret: VALID_KEY } });
		await readUntil(accepted, frame => smitheryFlow(frame)?.state === "Completed");
		expect(await getSmitheryApiKey(agentDir)).toBe(VALID_KEY);
		await authStorage.reload();
		expect(authStorage.get("smithery")).toBeUndefined();
	});

	test("a cancelled sign-in stops polling, stores nothing and frees the window", async () => {
		const started = await succeeds("LoginMcpRegistry");
		await readUntil(started, frame => smitheryFlow(frame)?.url === AUTH_URL);
		expect(await failsWith("LoginMcpRegistry")).toBe("AUTH_FLOW_IN_PROGRESS");

		const cancelled = await succeeds({ CancelAuthFlow: { provider: "smithery" } });
		expect(cancelled.some(frame => smitheryFlow(frame)?.state === "Cancelled")).toBe(true);
		expect(smithery.pollSignals.length).toBeGreaterThan(0);
		expect(smithery.pollSignals.every(signal => signal.aborted)).toBe(true);
		expect(await getSmitheryApiKey(agentDir)).toBeUndefined();

		smithery.poll = { status: "success", apiKey: VALID_KEY };
		await readUntil(await succeeds("LoginMcpRegistry"), frame => smitheryFlow(frame)?.state === "Completed");
		expect(await getSmitheryApiKey(agentDir)).toBe(VALID_KEY);
	});

	test("signing out deletes the profile's key, and a second sign-out has nothing to delete", async () => {
		await saveSmitheryApiKey(VALID_KEY, agentDir);
		expect(registryIn(await succeeds("LogoutMcpRegistry"))).toEqual({ signed_in: false, query: null, results: [] });
		expect(await getSmitheryApiKey(agentDir)).toBeUndefined();
		expect(await failsWith("LogoutMcpRegistry")).toBe("MCP_REGISTRY_NO_STORED_KEY");
	});
});
