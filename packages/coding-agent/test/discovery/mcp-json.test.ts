import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type MCPServer, mcpCapability } from "@veyyon/coding-agent/capability/mcp";
import { loadCapability } from "@veyyon/coding-agent/discovery";
import { removeWithRetries } from "@veyyon/utils";

async function loadStandaloneMcpConfig(cwd: string): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		providers: ["mcp-json"],
	});
	return result.items;
}

function envPlaceholder(name: string): string {
	return `\${${name}}`;
}

describe("standalone mcp.json oauth env expansion", () => {
	let tempDir = "";
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

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-mcp-json-"));
		process.env.VEYYON_OAUTH_TOKEN_URL = "https://provider.example/token";
		process.env.VEYYON_OAUTH_CLIENT_ID = "oauth-client-id";
		process.env.VEYYON_OAUTH_CLIENT_SECRET = "oauth-client-secret";
		process.env.VEYYON_OAUTH_REDIRECT_URI = "https://public.example/oauth/callback";
		process.env.VEYYON_OAUTH_CALLBACK_PATH = "/oauth/callback";
		process.env.VEYYON_MCP_HEADER = "Bearer test-token";
		process.env.VEYYON_MCP_URL = "https://mcp.example.com";
		process.env.VEYYON_MCP_ENV = "env-value";
	});

	afterEach(async () => {
		await removeWithRetries(tempDir);
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	test("expands standalone auth and oauth fields alongside existing env-expanded fields", async () => {
		await fs.writeFile(
			path.join(tempDir, "mcp.json"),
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

		const [server] = await loadStandaloneMcpConfig(tempDir);
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

	test("expands only the standalone oauth fields that are present", async () => {
		await fs.writeFile(
			path.join(tempDir, ".mcp.json"),
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

		const [server] = await loadStandaloneMcpConfig(tempDir);
		expect(server).toBeDefined();
		expect(server?.oauth).toEqual({
			redirectUri: "https://public.example/oauth/callback",
			callbackPath: "/oauth/callback",
		});
		expect(server?.auth).toBeUndefined();
	});
});
