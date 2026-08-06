import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type MCPServer, mcpCapability } from "@veyyon/coding-agent/capability/mcp";
import { loadCapability } from "@veyyon/coding-agent/discovery";
import { removeWithRetries } from "@veyyon/utils";

/**
 * The OpenCode provider reads `~/.config/opencode/opencode.json` only. A repository
 * contributes AGENTS.md/CLAUDE.md context and nothing else, so a cloned `opencode.json`
 * cannot hand the agent an MCP server to launch.
 */
async function loadOpenCodeMcpConfig(home: string, cwd: string): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		home,
		providers: ["opencode"],
	});
	return result.items;
}

async function writeUserConfig(home: string, config: unknown): Promise<string> {
	const dir = path.join(home, ".config", "opencode");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, "opencode.json");
	await fs.writeFile(file, JSON.stringify(config));
	return file;
}

describe("OpenCode MCP discovery", () => {
	let tempDir = "";
	let home = "";
	let cwd = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-opencode-mcp-"));
		home = path.join(tempDir, "home");
		cwd = path.join(tempDir, "project");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
	});

	afterEach(async () => {
		await removeWithRetries(tempDir);
	});

	test("normalizes array commands and OpenCode environment fields", async () => {
		await writeUserConfig(home, {
			mcp: {
				sequentialthinking: {
					type: "local",
					command: ["npx", "-y", "@modelcontextprotocol/server-sequential-thinking"],
					enabled: true,
				},
				github: {
					type: "local",
					command: ["npx", "-y", "@modelcontextprotocol/server-github"],
					environment: {
						GITHUB_PERSONAL_ACCESS_TOKEN: "token",
					},
					enabled: true,
				},
				firecrawl: {
					type: "local",
					command: ["firecrawl-mcp"],
					env: {
						FIRECRAWL_API_KEY: "legacy-token",
					},
				},
			},
		});

		const servers = await loadOpenCodeMcpConfig(home, cwd);
		const byName = Object.fromEntries(servers.map(server => [server.name, server]));

		expect(byName.sequentialthinking).toMatchObject({
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
			transport: "stdio",
		});
		expect(byName.github).toMatchObject({
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-github"],
			env: { GITHUB_PERSONAL_ACCESS_TOKEN: "token" },
			transport: "stdio",
		});
		expect(byName.firecrawl).toMatchObject({
			command: "firecrawl-mcp",
			env: { FIRECRAWL_API_KEY: "legacy-token" },
			transport: "stdio",
		});
		expect(byName.firecrawl?.args).toBeUndefined();
	});

	test("omits empty args for scalar OpenCode commands", async () => {
		await writeUserConfig(home, {
			mcp: {
				plain: {
					type: "local",
					command: "server-bin",
				},
			},
		});

		const servers = await loadOpenCodeMcpConfig(home, cwd);
		const server = servers.find(item => item.name === "plain");

		expect(server?.command).toBe("server-bin");
		expect(server?.args).toBeUndefined();
	});

	test("takes no MCP server from a project opencode.json", async () => {
		await writeUserConfig(home, {
			mcp: {
				"from-user": { type: "local", command: "user-bin" },
			},
		});
		await fs.writeFile(
			path.join(cwd, "opencode.json"),
			JSON.stringify({ mcp: { "from-project": { type: "local", command: "project-bin" } } }),
		);

		const servers = await loadOpenCodeMcpConfig(home, cwd);

		expect(servers.map(server => server.name)).toEqual(["from-user"]);
	});
});
