/**
 * `${VAR}` placeholders in an MCP server entry are expanded from the environment,
 * including the `auth` and `oauth` blocks that carry the OAuth client material.
 *
 * These cases used to run against the `mcp-json` provider and a standalone
 * `mcp.json` / `.mcp.json` in the PROJECT ROOT. That provider is gone: a
 * repository does not name the MCP servers an agent connects to. Expansion is a
 * property of the config format, not of where the file sits, so the fixtures
 * moved to the profile-scoped `<agentDir>/mcp.json` and `<agentDir>/.mcp.json`
 * that the `native` provider reads. The last case locks the removal: the same
 * bytes in the working tree contribute nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@veyyon/coding-agent/capability/fs";
import { type MCPServer, mcpCapability } from "@veyyon/coding-agent/capability/mcp";
import { loadCapability } from "@veyyon/coding-agent/discovery";
import { removeWithRetries, setAgentDir } from "@veyyon/utils";
import { captureDirOverrides, restoreDirOverrides } from "@veyyon/utils/dirs";

function envPlaceholder(name: string): string {
	return `\${${name}}`;
}

describe("MCP server env expansion in the profile config", () => {
	let agentDir = "";
	let projectDir = "";
	const dirOverrides = captureDirOverrides();
	const originalEnv = {
		VEYYON_OAUTH_TOKEN_URL: process.env.VEYYON_OAUTH_TOKEN_URL,
		VEYYON_OAUTH_CLIENT_ID: process.env.VEYYON_OAUTH_CLIENT_ID,
		VEYYON_OAUTH_CLIENT_SECRET: process.env.VEYYON_OAUTH_CLIENT_SECRET,
		VEYYON_OAUTH_REDIRECT_URI: process.env.VEYYON_OAUTH_REDIRECT_URI,
		VEYYON_OAUTH_CALLBACK_PATH: process.env.VEYYON_OAUTH_CALLBACK_PATH,
		VEYYON_MCP_HEADER: process.env.VEYYON_MCP_HEADER,
		VEYYON_MCP_URL: process.env.VEYYON_MCP_URL,
		VEYYON_MCP_ENV: process.env.VEYYON_MCP_ENV,
	};

	async function loadProfileServers(): Promise<MCPServer[]> {
		clearFsCache();
		const result = await loadCapability<MCPServer>(mcpCapability.id, { cwd: projectDir, providers: ["native"] });
		return result.items;
	}

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-mcp-env-agent-"));
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-mcp-env-project-"));
		setAgentDir(agentDir);
		process.env.VEYYON_OAUTH_TOKEN_URL = "https://provider.example/token";
		process.env.VEYYON_OAUTH_CLIENT_ID = "oauth-client-id";
		process.env.VEYYON_OAUTH_CLIENT_SECRET = "oauth-client-secret";
		process.env.VEYYON_OAUTH_REDIRECT_URI = "https://public.example/oauth/callback";
		process.env.VEYYON_OAUTH_CALLBACK_PATH = "/oauth/callback";
		process.env.VEYYON_MCP_HEADER = "Bearer test-token";
		process.env.VEYYON_MCP_URL = "https://mcp.example.com";
		process.env.VEYYON_MCP_ENV = "env-value";
		clearFsCache();
	});

	afterEach(async () => {
		clearFsCache();
		restoreDirOverrides(dirOverrides);
		await removeWithRetries(agentDir);
		await removeWithRetries(projectDir);
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	test("expands auth and oauth fields alongside existing env-expanded fields", async () => {
		await fs.writeFile(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					figma: {
						url: `${envPlaceholder("VEYYON_MCP_URL")}/mcp`,
						headers: { Authorization: envPlaceholder("VEYYON_MCP_HEADER") },
						env: { MCP_VALUE: envPlaceholder("VEYYON_MCP_ENV") },
						auth: {
							type: "oauth",
							tokenUrl: envPlaceholder("VEYYON_OAUTH_TOKEN_URL"),
							clientId: envPlaceholder("VEYYON_OAUTH_CLIENT_ID"),
							clientSecret: envPlaceholder("VEYYON_OAUTH_CLIENT_SECRET"),
						},
						oauth: {
							clientId: envPlaceholder("VEYYON_OAUTH_CLIENT_ID"),
							clientSecret: envPlaceholder("VEYYON_OAUTH_CLIENT_SECRET"),
							redirectUri: envPlaceholder("VEYYON_OAUTH_REDIRECT_URI"),
							callbackPort: 4317,
							callbackPath: envPlaceholder("VEYYON_OAUTH_CALLBACK_PATH"),
						},
					},
				},
			}),
		);

		const [server] = await loadProfileServers();
		expect(server).toBeDefined();
		expect(server?.url).toBe("https://mcp.example.com/mcp");
		expect(server?.headers).toEqual({ Authorization: "Bearer test-token" });
		expect(server?.env).toEqual({ MCP_VALUE: "env-value" });
		expect(server?.auth).toEqual({
			type: "oauth",
			tokenUrl: "https://provider.example/token",
			clientId: "oauth-client-id",
			clientSecret: "oauth-client-secret",
		});
		expect(server?.oauth).toEqual({
			clientId: "oauth-client-id",
			clientSecret: "oauth-client-secret",
			redirectUri: "https://public.example/oauth/callback",
			callbackPort: 4317,
			callbackPath: "/oauth/callback",
		});
	});

	test("expands only the oauth fields that are present", async () => {
		await fs.writeFile(
			path.join(agentDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					slack: {
						url: "https://slack.example.com/mcp",
						oauth: {
							redirectUri: envPlaceholder("VEYYON_OAUTH_REDIRECT_URI"),
							callbackPath: envPlaceholder("VEYYON_OAUTH_CALLBACK_PATH"),
						},
					},
				},
			}),
		);

		const [server] = await loadProfileServers();
		expect(server).toBeDefined();
		expect(server?.oauth).toEqual({
			redirectUri: "https://public.example/oauth/callback",
			callbackPath: "/oauth/callback",
		});
		expect(server?.auth).toBeUndefined();
	});

	/**
	 * The inversion. The same two filenames in the project root were the
	 * `mcp-json` provider's whole surface. Re-registering it turns this red.
	 */
	test("a standalone mcp.json in the working tree is not a source of MCP servers", async () => {
		const body = JSON.stringify({
			mcpServers: { repo: { url: `${envPlaceholder("VEYYON_MCP_URL")}/mcp` } },
		});
		await fs.writeFile(path.join(projectDir, "mcp.json"), body);
		await fs.writeFile(path.join(projectDir, ".mcp.json"), body);
		clearFsCache();

		const result = await loadCapability<MCPServer>(mcpCapability.id, { cwd: projectDir, includeDisabled: true });
		expect(result.all.map(server => server.name)).not.toContain("repo");
		expect(result.all.filter(server => server._source.path.startsWith(projectDir))).toEqual([]);
	});
});
