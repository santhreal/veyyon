import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as mcpClient from "@veyyon/coding-agent/mcp/client";
import { MCPCommandController } from "@veyyon/coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { getMCPConfigPath, getProjectDir, removeWithRetries, setAgentDir, setProjectDir } from "@veyyon/utils";
import { captureDirOverrides, restoreDirOverrides } from "@veyyon/utils/dirs";

const originalProjectDir = getProjectDir();
// One owner for "undo a setAgentDir call": the hand-rolled version below could not
// restore an ABSENT VEYYON_CODING_AGENT_DIR and left the active profile cleared,
// which leaked into every file that ran after this one.
const dirOverrides = captureDirOverrides();

describe("issue #956: interactive /mcp test", () => {
	// The fixture used to be `<projectDir>/.mcp.json`, a working-tree file, and
	// the regression this guards was `/mcp test` reporting "not found" for a
	// server it had just listed. `/mcp test` no longer resolves any repository
	// file, so the same regression is now guarded from the profile config the
	// command actually reads; `mcp-command-ignores-repo-config.test.ts` owns the
	// other half, that the repository files stay invisible.
	let projectDir = "";
	let agentDir = "";

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-issue-956-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-issue-956-agent-"));
		setProjectDir(projectDir);
		setAgentDir(agentDir);

		await fs.writeFile(
			getMCPConfigPath("user", projectDir, agentDir),
			JSON.stringify(
				{
					mcpServers: {
						github: {
							type: "stdio",
							command: "github-mcp-server",
							args: ["serve"],
						},
					},
				},
				null,
				2,
			),
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		restoreDirOverrides(dirOverrides);
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	it("tests a connected server configured in the profile's mcp.json", async () => {
		const transport = {
			connected: true,
			request: vi.fn(),
			notify: vi.fn(),
			close: vi.fn(async () => {}),
		};
		const connection = {
			name: "github",
			config: { type: "stdio" as const, command: "github-mcp-server", args: ["serve"] },
			transport,
			serverInfo: { name: "GitHub MCP", version: "1.0.0" },
			capabilities: {},
		};
		const showError = vi.fn();
		const showStatus = vi.fn();
		const requestRender = vi.fn();
		const addChild = vi.fn();
		const refreshMCPTools = vi.fn();
		const connectToServer = vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(connection);
		const listTools = vi.spyOn(mcpClient, "listTools").mockResolvedValue([{ name: "search_issues" }] as never);
		const disconnectServer = vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue();
		const controller = new MCPCommandController({
			chatContainer: { addChild },
			present: (content: unknown) => {
				for (const item of Array.isArray(content) ? content : [content]) addChild(item);
				requestRender();
			},
			ui: { requestRender },
			editor: {},
			showError,
			showStatus,
			session: { refreshMCPTools },
			mcpManager: {
				prepareConfig: vi.fn(async config => config),
				getConnectionStatus: vi.fn(() => "connected"),
			},
		} as never);

		await controller.handle("/mcp test github");

		expect(showError).not.toHaveBeenCalled();
		expect(connectToServer).toHaveBeenCalledWith(
			"github",
			expect.objectContaining({ command: "github-mcp-server", args: ["serve"] }),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(listTools).toHaveBeenCalledWith(connection, expect.objectContaining({ signal: expect.any(AbortSignal) }));
		expect(disconnectServer).toHaveBeenCalledWith(connection);
		expect(requestRender).toHaveBeenCalled();
	});
});
