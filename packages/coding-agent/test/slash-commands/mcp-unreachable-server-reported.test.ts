/**
 * Locks out the bare `catch {}` in `collectConnectedMcpLines`
 * (`slash-commands/helpers/mcp.ts`), whose comment read "unreachable server:
 * skip silently".
 *
 * `/mcp resources` and `/mcp prompts` build their listing by connecting to each
 * configured server. A server that could not be reached was dropped from the
 * listing with no trace, so a server that is down produced exactly the same
 * output as a server that is up and has nothing to offer. The operator's own
 * `.mcp.json` entry vanished from the answer to a question they asked directly.
 *
 * If this regresses, a dead MCP server becomes indistinguishable from an empty
 * one and there is nothing in the logs to tell them apart.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { handleMcpAcp } from "@veyyon/coding-agent/slash-commands/helpers/mcp";
import { parseSlashCommand } from "@veyyon/coding-agent/slash-commands/helpers/parse";
import type { SlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";
import { getMCPConfigPath, logger, removeWithRetries, setAgentDir } from "@veyyon/utils";
import { captureDirOverrides, restoreDirOverrides } from "@veyyon/utils/dirs";

let tempDir = "";
let agentDir = "";
let warnings: Array<{ message: string; fields: Record<string, unknown> }>;
let output: string[];

const dirOverrides = captureDirOverrides();

const resourcesCommand = parseSlashCommand("/mcp resources");
if (!resourcesCommand) throw new Error("`/mcp resources` must parse as a slash command");

function makeRuntime(): SlashCommandRuntime {
	return {
		cwd: tempDir,
		output: (text: string) => {
			output.push(text);
		},
		session: { modelRegistry: { authStorage: undefined } },
	} as unknown as SlashCommandRuntime;
}

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-unreachable-"));
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-unreachable-agent-"));
	setAgentDir(agentDir);
	warnings = [];
	output = [];
	vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
		warnings.push({ message, fields: fields ?? {} });
	});
	// A stdio server whose command does not exist, so connecting fails the way a
	// dead server does rather than by configuration rejection. It goes in the
	// PROFILE's mcp.json, which is the only file `/mcp` reads: a repository must
	// not name a server the agent connects to, so a working-tree entry would not
	// be queried at all and there would be nothing to report.
	const configPath = getMCPConfigPath("user", tempDir, agentDir);
	await fs.mkdir(path.dirname(configPath), { recursive: true });
	await fs.writeFile(
		configPath,
		JSON.stringify({
			mcpServers: {
				"dead-server": { command: "veyyon-no-such-binary-38f1c2", args: [] },
			},
		}),
	);
});

afterEach(async () => {
	vi.restoreAllMocks();
	restoreDirOverrides(dirOverrides);
	if (dirOverrides.agentDirEnv === undefined) delete Bun.env.VEYYON_CODING_AGENT_DIR;
	await removeWithRetries(tempDir);
	await removeWithRetries(agentDir);
});

describe("An MCP server that cannot be queried is reported", () => {
	test("warns with the server name and says it is missing from the listing", async () => {
		await handleMcpAcp(resourcesCommand, makeRuntime());

		const reported = warnings.filter(w => w.message.includes("MCP server could not be queried"));
		expect(reported).toHaveLength(1);
		expect(reported[0]?.message).toContain("missing from this listing");
		expect(reported[0]?.fields.name).toBe("dead-server");
		expect(String(reported[0]?.fields.error)).not.toBe("");
	});

	/**
	 * The behavior being preserved: one unreachable server must not fail the
	 * command, and the operator still gets the listing for whatever answered.
	 */
	test("still completes the command", async () => {
		await handleMcpAcp(resourcesCommand, makeRuntime());

		expect(output.join("\n")).toContain("No resources available on connected servers.");
	});
});
