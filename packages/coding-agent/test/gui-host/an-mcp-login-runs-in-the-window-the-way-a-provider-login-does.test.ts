/**
 * WHY: a remote MCP server that wants OAuth is signed into from the window
 * through the same `AuthFlow` section and the same `SubmitAuthSecret` /
 * `CancelAuthFlow` actions a provider login uses, under the provider
 * `mcp:<server>`. The defect class this closes is a login whose result lands
 * somewhere other than where the terminal's `/mcp add`, `/mcp reauth` and
 * `/mcp unauth` put it: a server written before its login finishes, so a
 * cancelled login leaves a server that cannot connect; a pasted redirect filed
 * as an api key under the flow's provider name; a pasted code whose `state` is
 * not this login's accepted anyway; a reauth that stores a new token and keeps
 * connecting with the old one; an unauth that deletes the token and leaves the
 * config pointing at it.
 *
 * The server is a loopback HTTP MCP endpoint behind a real authorization
 * server (metadata discovery, dynamic client registration, code exchange), so
 * every credential here was minted by a token request. The browser's redirect
 * is replaced by pasting it, which is the window's only route when the browser
 * cannot reach this machine; the loopback callback itself is the provider
 * login suites' concern.
 *
 * What it does NOT catch: a login that completes through the loopback
 * callback, and a token refresh, which the MCP transport suites own.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@veyyon/ai";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { AuthFlowView, McpServerView } from "../../src/gui-host/wire";
import { readMCPConfigFile } from "../../src/mcp/config-writer";
import { MCPManager } from "../../src/mcp/manager";
import { mcpOAuthCredentialId } from "../../src/mcp/oauth-flow";
import type { MCPServerConfig } from "../../src/mcp/types";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { OAUTH_TOOL, type OAuthMcpServer, startOAuthMcpServer } from "./oauth-mcp-server";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

let root = "";
let agentDir = "";
let authStorage: AuthStorage;
let fixture: OAuthMcpServer;
let host: GuiHostServer | undefined;
let client: TestSocketClient;
let nextId = 1;

/** Reads frames, starting with `seen`, until one satisfies `done`; returns every frame read. */
async function readUntil(seen: RequestFrame[], done: (frame: RequestFrame) => boolean): Promise<RequestFrame[]> {
	const frames = [...seen];
	while (!frames.some(done)) frames.push((await client.nextFrame()) as RequestFrame);
	return frames;
}

function authFlow(frame: RequestFrame): AuthFlowView | undefined {
	return frame.Snapshot?.AuthFlow as AuthFlowView | undefined;
}

function flowIn(state: AuthFlowView["state"]): (frame: RequestFrame) => boolean {
	return frame => authFlow(frame)?.state === state;
}

async function send(action: unknown): Promise<{ frames: RequestFrame[]; outcome: RequestFrame }> {
	const id = nextId++;
	return client.request(id, action);
}

async function succeeds(action: unknown): Promise<RequestFrame[]> {
	const { frames, outcome } = await send(action);
	expect(outcome.RequestSucceeded).toBeDefined();
	return frames;
}

async function failsWith(action: unknown): Promise<string | undefined> {
	const { outcome } = await send(action);
	expect(outcome.RequestFailed?.error.scope).toBe("Mcp");
	return outcome.RequestFailed?.error.code;
}

function rowOf(frames: RequestFrame[], name: string): McpServerView | undefined {
	return snapshotSections<McpServerView[]>(frames, "Mcp")
		.at(-1)
		?.find(row => row.name === name);
}

async function profileServers(): Promise<Record<string, MCPServerConfig>> {
	return (await readMCPConfigFile(path.join(agentDir, "mcp.json"))).mcpServers ?? {};
}

/** Wait for the login `started` began to ask for the browser, and return what the window draws for it. */
async function awaitLogin(provider: string, started: RequestFrame[]): Promise<AuthFlowView> {
	const waiting = await readUntil(started, flowIn("AwaitingSecret"));
	const flow = authFlow(waiting.findLast(flowIn("AwaitingSecret"))!)!;
	expect(flow.provider).toBe(provider);
	expect(flow.prompt).not.toBeNull();
	return flow;
}

/**
 * Answer `flow` with the redirect the browser would have followed, carrying
 * `code` and `state` (the login's own state unless given). Returns the frames
 * read up to the paste's answer.
 */
async function pasteRedirect(flow: AuthFlowView, code: string, state?: string): Promise<RequestFrame[]> {
	const authorize = new URL(flow.url!);
	expect(`${authorize.origin}${authorize.pathname}`).toBe(new URL("/authorize", fixture.url).href);
	const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
	redirect.searchParams.set("code", code);
	redirect.searchParams.set("state", state ?? authorize.searchParams.get("state")!);
	return succeeds({ SubmitAuthSecret: { provider: flow.provider, secret: redirect.href } });
}

/** Wait for the login `started` began, paste `code` and return the frames up to `Completed`. */
async function signIn(provider: string, started: RequestFrame[], code: string): Promise<RequestFrame[]> {
	const pasted = await pasteRedirect(await awaitLogin(provider, started), code);
	return readUntil(pasted, flowIn("Completed"));
}

/** Add `name` through the window and finish its login; returns the frames up to `Completed`. */
async function addSignedIn(name: string, code: string): Promise<RequestFrame[]> {
	const started = await succeeds({ AddMcpServer: { name, target: { Http: { url: fixture.url, token: null } } } });
	return signIn(`mcp:${name}`, started, code);
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-mcp-login-"));
	agentDir = path.join(root, "agent");
	await fs.mkdir(agentDir);
	MCPManager.resetForTests();
	authStorage = await isolatedAuthStorage(root);
	fixture = await startOAuthMcpServer();
	host = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: root, agentDir, authStorage });
	client = await TestSocketClient.connect(host.endpoint);
	nextId = 1;
});

afterEach(async () => {
	client.destroy();
	await host?.close();
	host = undefined;
	MCPManager.resetForTests();
	await fixture.close();
	authStorage.close();
	await fs.rm(root, { recursive: true, force: true });
});

describe("an mcp login runs in the window the way a provider login does", () => {
	test("adding a server that wants a login writes it only once the pasted redirect signs it in", async () => {
		const started = await succeeds({
			AddMcpServer: { name: "remote", target: { Http: { url: fixture.url, token: null } } },
		});
		expect(await profileServers()).toEqual({});

		const finished = await signIn("mcp:remote", started, "pasted-code");
		expect(rowOf(finished, "remote")).toEqual({
			name: "remote",
			enabled: true,
			status: "Connected",
			tools: [OAUTH_TOOL],
		});
		expect(fixture.exchanged).toEqual(["pasted-code"]);

		const credentialId = mcpOAuthCredentialId(fixture.url);
		expect((await profileServers()).remote).toMatchObject({
			type: "http",
			url: fixture.url,
			auth: { type: "oauth", credentialId },
		});
		await authStorage.reload();
		expect(authStorage.get(credentialId)).toMatchObject({ type: "oauth", access: "access-1" });
		expect(authStorage.get("mcp:remote")).toBeUndefined();
	});

	test("a pasted redirect whose state is not this login's is not exchanged", async () => {
		const started = await succeeds({
			AddMcpServer: { name: "remote", target: { Http: { url: fixture.url, token: null } } },
		});
		const flow = await awaitLogin("mcp:remote", started);
		const forged = await pasteRedirect(flow, "forged-code", "state-of-another-login");
		const finished = await readUntil([...forged, ...(await pasteRedirect(flow, "real-code"))], flowIn("Completed"));
		expect(fixture.exchanged).toEqual(["real-code"]);
		expect(rowOf(finished, "remote")?.status).toBe("Connected");
	});

	test("a cancelled login adds nothing and frees the window for the next one", async () => {
		const started = await succeeds({
			AddMcpServer: { name: "remote", target: { Http: { url: fixture.url, token: null } } },
		});
		await awaitLogin("mcp:remote", started);
		expect(
			await failsWith({ AddMcpServer: { name: "other", target: { Http: { url: fixture.url, token: null } } } }),
		).toBe("AUTH_FLOW_IN_PROGRESS");

		const cancelled = await succeeds({ CancelAuthFlow: { provider: "mcp:remote" } });
		expect(cancelled.some(flowIn("Cancelled"))).toBe(true);
		expect(await profileServers()).toEqual({});
		expect(fixture.exchanged).toEqual([]);

		await addSignedIn("other", "after-cancel");
		expect(Object.keys(await profileServers())).toEqual(["other"]);
	});

	test("a token the server rejects adds nothing", async () => {
		expect(
			await failsWith({
				AddMcpServer: { name: "remote", target: { Http: { url: fixture.url, token: "not-issued" } } },
			}),
		).toBe("MCP_AUTH_FAILED");
		expect(await profileServers()).toEqual({});
	});

	test("signing in again replaces the token the server connects with", async () => {
		await addSignedIn("remote", "first");
		fixture.revokeAll();

		const started = await succeeds({ ReauthMcpServer: { server: "remote" } });
		const finished = await signIn("mcp:remote", started, "second");
		expect(fixture.issued).toEqual(["access-1", "access-2"]);
		expect(rowOf(finished, "remote")).toEqual({
			name: "remote",
			enabled: true,
			status: "Connected",
			tools: [OAUTH_TOOL],
		});
		await authStorage.reload();
		expect(authStorage.get(mcpOAuthCredentialId(fixture.url))).toMatchObject({ access: "access-2" });
	});

	test("signing a server out deletes its token and the auth block pointing at it", async () => {
		await addSignedIn("remote", "first");
		const credentialId = mcpOAuthCredentialId(fixture.url);

		const cleared = await succeeds({ ClearMcpServerAuth: { server: "remote" } });
		await authStorage.reload();
		expect(authStorage.get(credentialId)).toBeUndefined();
		const entry = (await profileServers()).remote;
		expect(entry).toMatchObject({ type: "http", url: fixture.url });
		expect(entry && "auth" in entry).toBe(false);
		const row = rowOf(cleared, "remote");
		expect(row?.tools).toEqual([]);
		expect(row?.status).not.toBe("Connected");

		expect(await failsWith({ ClearMcpServerAuth: { server: "absent" } })).toBe("MCP_SERVER_NOT_FOUND");
	});
});
