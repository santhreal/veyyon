/**
 * A repository cannot name a server `/mcp` reaches or writes to.
 *
 * `#findConfiguredServer` in the MCP command controller used to resolve four
 * files: the profile's `<agentDir>/mcp.json` plus three working-tree
 * candidates — `<cwd>/.veyyon/mcp.json`, `<cwd>/mcp.json` and
 * `<cwd>/.mcp.json`. Discovery stopped loading all three, so nothing connected
 * at boot, but `/mcp test` and `/mcp reauth` resolve through that function and
 * would have CONNECTED to a repo-declared server, and `/mcp enable` would have
 * written `enabled: true` back into the repository file.
 *
 * Every case here declares the same server in all three working-tree files and
 * asserts the command cannot see it. The stdio command each entry carries
 * writes a sentinel file, so "did Veyyon connect" is answered by the
 * filesystem rather than by a mock: restoring the cwd candidates makes the
 * sentinel appear and every case fail.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MCPServerConfig } from "@veyyon/coding-agent/mcp/types";
import { MCPCommandController } from "@veyyon/coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import {
	getMCPConfigPath,
	getProjectDir,
	pathExists,
	removeWithRetries,
	setAgentDir,
	setProjectDir,
} from "@veyyon/utils";
import { captureDirOverrides, restoreDirOverrides } from "@veyyon/utils/dirs";

const originalProjectDir = getProjectDir();
const dirOverrides = captureDirOverrides();

const REPO_SERVER = "repo-declared";
const REPO_DISABLED_SERVER = "repo-declared-disabled";

function createController() {
	const showError = vi.fn();
	const showStatus = vi.fn();
	const present = vi.fn();
	const mcpManager = {
		disconnectAll: vi.fn(async () => {}),
		discoverAndConnect: vi.fn(async () => ({ errors: new Map<string, string>() })),
		disconnectServer: vi.fn(async () => {}),
		connectServers: vi.fn(async () => ({
			errors: new Map<string, string>(),
			connectedServers: [],
			tools: [],
			exaApiKeys: [],
		})),
		getTools: vi.fn(() => []),
		waitForConnection: vi.fn(async () => ({})),
		getConnectionStatus: vi.fn(() => "connected"),
		getSource: vi.fn(() => undefined),
		getServerConfig: vi.fn(() => undefined),
		getAllServerNames: vi.fn(() => [] as string[]),
		getConnection: vi.fn(() => undefined),
		// Real enough that a resolved config reaches connectToServer, which spawns
		// the stdio command: without it the mock swallows the connect attempt and
		// the sentinel assertion below could never fail.
		prepareConfig: vi.fn(async (config: MCPServerConfig) => config),
	};
	const controller = new MCPCommandController({
		chatContainer: { addChild: vi.fn() },
		present,
		ui: { requestRender: vi.fn() },
		editor: {},
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		showError,
		showStatus,
		showWarning: vi.fn(),
		oauthManualInput: {
			hasPending: vi.fn(() => false),
			pendingProviderId: undefined,
			tryClaimInput: vi.fn(),
		},
		session: {
			refreshMCPTools: vi.fn(async () => {}),
			modelRegistry: { authStorage: undefined },
		},
		mcpManager,
	} as never);

	return { controller, showError, showStatus, mcpManager };
}

describe("a repository's MCP config is invisible to /mcp", () => {
	let projectDir = "";
	let agentDir = "";
	let sentinel = "";
	/** Every working-tree file the controller used to resolve, newest first. */
	let repoFiles: string[] = [];

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-mcp-repo-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-mcp-repo-agent-"));
		sentinel = path.join(projectDir, "connected.sentinel");
		setProjectDir(projectDir);
		setAgentDir(agentDir);

		// A command that leaves proof on disk if anything ever spawns it.
		const repoConfig: MCPServerConfig = {
			type: "stdio",
			command: "sh",
			args: ["-c", `printf connected > ${JSON.stringify(sentinel)}`],
		};
		// Two entries, because the two failure modes need different starting
		// states: `/mcp test` needs an ENABLED entry to try to connect to, and
		// `/mcp enable` only writes when the entry it found is disabled.
		const body = `${JSON.stringify(
			{
				mcpServers: {
					[REPO_SERVER]: repoConfig,
					[REPO_DISABLED_SERVER]: { ...repoConfig, enabled: false },
				},
			},
			null,
			2,
		)}\n`;
		repoFiles = [
			path.join(projectDir, ".veyyon", "mcp.json"),
			path.join(projectDir, "mcp.json"),
			path.join(projectDir, ".mcp.json"),
		];
		for (const file of repoFiles) {
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, body, "utf8");
		}
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		restoreDirOverrides(dirOverrides);
		if (dirOverrides.agentDirEnv === undefined) delete Bun.env.VEYYON_CODING_AGENT_DIR;
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	async function readRepoFiles(): Promise<string[]> {
		return await Promise.all(repoFiles.map(file => fs.readFile(file, "utf8")));
	}

	test("/mcp test does not connect to a server only a repository declares", async () => {
		const { controller, showError } = createController();

		await controller.handle(`/mcp test ${REPO_SERVER}`);

		expect(await pathExists(sentinel, "the MCP connection sentinel")).toBe(false);
		expect(showError).toHaveBeenCalledTimes(1);
		expect(showError.mock.calls[0]![0]).toContain(`Server "${REPO_SERVER}" not found`);
	});

	test("/mcp reauth does not resolve a server only a repository declares", async () => {
		const { controller, showError } = createController();

		await controller.handle(`/mcp reauth ${REPO_SERVER}`);

		expect(await pathExists(sentinel, "the MCP connection sentinel")).toBe(false);
		expect(showError).toHaveBeenCalledTimes(1);
		expect(showError.mock.calls[0]![0]).toContain(`Server "${REPO_SERVER}" not found`);
	});

	test("/mcp enable names where configs are read from and writes into no repository file", async () => {
		const before = await readRepoFiles();
		const { controller, showError, mcpManager } = createController();

		await controller.handle(`/mcp enable ${REPO_DISABLED_SERVER}`);

		// Order matters: the repository files are the contract. Asserting the
		// message first would hide the write behind a message mismatch.
		expect(await readRepoFiles()).toEqual(before);
		expect(await pathExists(sentinel, "the MCP connection sentinel")).toBe(false);
		expect(mcpManager.connectServers).not.toHaveBeenCalled();

		expect(showError).toHaveBeenCalledTimes(1);
		const message = showError.mock.calls[0]![0] as string;
		expect(message).toContain(`MCP server "${REPO_DISABLED_SERVER}" is not configured`);
		// The remedy has to name the file that IS read, or the operator goes back
		// to editing the repository file that did nothing.
		expect(message).toContain("mcp.json");
		expect(message).toContain("is never loaded");
		expect(message).toContain("Fix:");
	});

	test("/mcp disable writes into no repository file either", async () => {
		const before = await readRepoFiles();
		const { controller, showError } = createController();

		await controller.handle(`/mcp disable ${REPO_SERVER}`);

		expect(await readRepoFiles()).toEqual(before);
		expect(showError).toHaveBeenCalledTimes(1);
	});

	test("positive control: the profile's own mcp.json is still enabled and written", async () => {
		const profilePath = getMCPConfigPath("user", projectDir, agentDir);
		await fs.writeFile(
			profilePath,
			`${JSON.stringify(
				{ mcpServers: { "profile-server": { type: "stdio", command: "profile-cmd", enabled: false } } },
				null,
				2,
			)}\n`,
			"utf8",
		);
		const before = await readRepoFiles();
		const { controller, showError, mcpManager } = createController();

		await controller.handle("/mcp enable profile-server");

		expect(showError).not.toHaveBeenCalled();
		const written = JSON.parse(await fs.readFile(profilePath, "utf8")) as {
			mcpServers: Record<string, MCPServerConfig>;
		};
		expect(written.mcpServers["profile-server"]).toEqual({
			type: "stdio",
			command: "profile-cmd",
			enabled: true,
		});
		expect(mcpManager.connectServers).toHaveBeenCalledTimes(1);
		// The profile write must not have touched the repository on its way past.
		expect(await readRepoFiles()).toEqual(before);
	});

	test("/mcp add rejects --scope instead of writing a repository file", async () => {
		const before = await readRepoFiles();
		const { controller, showError } = createController();

		await controller.handle("/mcp add repo-add --scope project -- echo hi");

		expect(showError).toHaveBeenCalledTimes(1);
		expect(showError.mock.calls[0]![0]).toContain("`--scope` is gone");
		expect(await readRepoFiles()).toEqual(before);
		expect(
			await pathExists(path.join(projectDir, ".veyyon", "mcp.json.tmp"), "a half-written repository mcp.json"),
		).toBe(false);
	});
});
