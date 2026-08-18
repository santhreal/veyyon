/**
 * A repository cannot name a server `/mcp` reaches or writes to — on EITHER
 * surface.
 *
 * `#findConfiguredServer` in the MCP command controller used to resolve four
 * files: the profile's `<agentDir>/mcp.json` plus three working-tree
 * candidates — `<cwd>/.veyyon/mcp.json`, `<cwd>/mcp.json` and
 * `<cwd>/.mcp.json`. Discovery stopped loading all three, so nothing connected
 * at boot, but `/mcp test` and `/mcp reauth` resolve through that function and
 * would have CONNECTED to a repo-declared server, and `/mcp enable` would have
 * written `enabled: true` back into the repository file.
 *
 * The fix landed on the TUI controller only, so this suite closed the incident
 * and not the class: the text/ACP handler (`slash-commands/helpers/mcp.ts`) kept
 * a `project` scope, defaulted to it, and wrote `<cwd>/.veyyon/mcp.json` through
 * `getMCPConfigPath("project", …)`. `loadAllMCPConfigs` reads no project-level
 * source, so that write reported `Added MCP server "x" (project).` and
 * configured nothing at all. Both surfaces are swept here now, and the scope
 * words are refused rather than accepted, because a word that silently
 * redirects a write is worse than one that is ignored.
 *
 * Every case declares the same server in all three working-tree files and
 * asserts the command cannot see it. The stdio command each entry carries
 * writes a sentinel file, so "did Veyyon connect" is answered by the
 * filesystem rather than by a mock: restoring the cwd candidates makes the
 * sentinel appear and every case fail.
 *
 * What this does NOT catch: a THIRD surface. Nothing here enumerates the
 * dispatch table, so a future `/mcp` entry point that resolves its own config
 * path would be uncovered until someone adds it below.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MCPServerConfig } from "@veyyon/coding-agent/mcp/types";
import { MCPCommandController } from "@veyyon/coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { BUILTIN_SLASH_COMMAND_DEFS } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import { handleMcpAcp } from "@veyyon/coding-agent/slash-commands/helpers/mcp";
import { MCP_SCOPE_REMOVED_REPLACEMENT, parseSlashCommand } from "@veyyon/coding-agent/slash-commands/helpers/parse";
import type { SlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";
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

/**
 * The text/ACP surface, driven the way `builtin-registry` drives it: a parsed
 * command and a runtime whose `cwd` is the repository. `output` collects what an
 * ACP client would be shown, which is where the false `(project)` success used to
 * appear.
 */
function textSurface(cwd: string) {
	const output: string[] = [];
	const runtime = {
		cwd,
		output: (text: string) => {
			output.push(text);
		},
		session: { modelRegistry: { authStorage: undefined } },
	} as unknown as SlashCommandRuntime;
	const run = async (text: string) => {
		const command = parseSlashCommand(text);
		if (!command) throw new Error(`${text} must parse as a slash command`);
		await handleMcpAcp(command, runtime);
		return output.join("\n");
	};
	return { run, output };
}

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

	/**
	 * Both spellings of "put this in the repository" must be refused. `--scope` is the
	 * option the grammar no longer has; `project` is the plain word that replaced it
	 * everywhere a scope still exists, and it must NOT quietly become one here. The
	 * bare separator that used to introduce the command tail is refused for the same
	 * reason: `run <command...>` takes the rest of the line now.
	 */
	test.each([
		"/mcp add repo-add --scope project -- echo hi",
		"/mcp add repo-add project run echo hi",
		"/mcp add repo-add -- echo hi",
	])("%p is refused instead of writing a repository file", async command => {
		const before = await readRepoFiles();
		const { controller, showError } = createController();

		await controller.handle(command);

		expect(showError).toHaveBeenCalledTimes(1);
		const message = showError.mock.calls[0]![0];
		expect(message).toContain("is gone");
		expect(message).toContain("Usage: /mcp add");
		expect(await readRepoFiles()).toEqual(before);
		expect(
			await pathExists(path.join(projectDir, ".veyyon", "mcp.json.tmp"), "a half-written repository mcp.json"),
		).toBe(false);
	});

	test("the refusal explains that MCP servers live in the profile, naming no option spelling", async () => {
		const { controller, showError } = createController();

		await controller.handle("/mcp add repo-add project url https://example.com");

		const message = showError.mock.calls[0]![0];
		expect(message).toContain("project is gone");
		expect(message).toContain("MCP servers are configured per profile, never per repository");
	});

	/**
	 * The text/ACP surface, which the fix originally missed. Every one of these
	 * used to succeed: the scope word was accepted, `project` was the DEFAULT, and
	 * the write went into the repository file.
	 */
	describe("the text/ACP surface refuses the same words", () => {
		test.each([
			"/mcp add repo-add project run echo hi",
			"/mcp add repo-add user run echo hi",
			"/mcp add repo-add --scope project run echo hi",
			"/mcp remove repo-add project",
			"/mcp smithery-search thing --scope project",
		])("%p is refused", async command => {
			const before = await readRepoFiles();
			const { run } = textSurface(projectDir);

			const shown = await run(command);

			expect(shown).toContain("is gone");
			// Word for word the same reason the TUI gives, from the one constant.
			expect(shown).toContain(MCP_SCOPE_REMOVED_REPLACEMENT);
			expect(await readRepoFiles()).toEqual(before);
		});

		/**
		 * The defect stated plainly: an ACP client asked for a server, was told it
		 * was added, and got a file no session loads. The success line must not
		 * mention a scope at all now, because there is only one place to write.
		 */
		test("/mcp add writes the profile config and says so without naming a scope", async () => {
			const before = await readRepoFiles();
			const { run } = textSurface(projectDir);

			const shown = await run("/mcp add profile-add url https://example.com");

			expect(shown).toBe('Added MCP server "profile-add".');
			expect(shown).not.toContain("project");
			expect(await readRepoFiles()).toEqual(before);
			const written = JSON.parse(await fs.readFile(getMCPConfigPath("user", projectDir, agentDir), "utf8")) as {
				mcpServers: Record<string, MCPServerConfig>;
			};
			expect(Object.keys(written.mcpServers)).toEqual(["profile-add"]);
		});

		test("/mcp list does not show a server only a repository declares", async () => {
			const { run } = textSurface(projectDir);

			const shown = await run("/mcp list");

			expect(shown).toBe("No MCP servers configured.");
			expect(shown).not.toContain(REPO_SERVER);
		});

		test("/mcp test does not connect to a server only a repository declares", async () => {
			const { run } = textSurface(projectDir);

			const shown = await run(`/mcp test ${REPO_SERVER}`);

			expect(await pathExists(sentinel, "the MCP connection sentinel")).toBe(false);
			expect(shown).toContain(`Server "${REPO_SERVER}" not found`);
		});

		test("/mcp enable writes into no repository file", async () => {
			const before = await readRepoFiles();
			const { run } = textSurface(projectDir);

			const shown = await run(`/mcp enable ${REPO_DISABLED_SERVER}`);

			expect(await readRepoFiles()).toEqual(before);
			expect(shown).toContain(`Server "${REPO_DISABLED_SERVER}"`);
		});

		test("/mcp resources and /mcp prompts query nothing a repository declared", async () => {
			const { run } = textSurface(projectDir);

			expect(await run("/mcp resources")).toBe("No MCP servers configured.");
			expect(await pathExists(sentinel, "the MCP connection sentinel")).toBe(false);

			const { run: runPrompts } = textSurface(projectDir);
			expect(await runPrompts("/mcp prompts")).toBe("No MCP servers configured.");
			expect(await pathExists(sentinel, "the MCP connection sentinel")).toBe(false);
		});

		/** The help an ACP client is shown must not advertise a scope it will refuse. */
		test("/mcp help advertises no scope", async () => {
			const { run } = textSurface(projectDir);

			const shown = await run("/mcp help");

			expect(shown).toContain("/mcp add");
			expect(shown).not.toContain("[project|user]");
		});

		/**
		 * The hole a mutation gate found: every case above passes while the DECLARED
		 * usage still advertises `[project|user]`. That string is not decoration —
		 * `buildSubcommandInlineHint` and `buildArgumentCompletions` read it, so it is
		 * the hint a terminal shows while you type, and a declaration offering a word
		 * the parser refuses teaches the operator a grammar that does not exist.
		 *
		 * So the words are taken from the declaration at run time and fed to the real
		 * handler: whatever a `/mcp` subcommand OFFERS in its usage, that subcommand
		 * must accept. It sweeps every subcommand the registry declares, so a scope
		 * restored to any of them fails, and so does any future word declared on one
		 * surface and refused on the other. Placeholders (`<url>`, `<limit 1-100>`)
		 * are skipped: they stand for text, not for a literal to type.
		 */
		test("every plain word a /mcp usage offers is a word the handler accepts", async () => {
			const mcp = (
				BUILTIN_SLASH_COMMAND_DEFS as ReadonlyArray<{
					name: string;
					subcommands?: ReadonlyArray<{ name: string; usage?: string }>;
				}>
			).find(def => def.name === "mcp");
			if (!mcp) throw new Error("the registry must declare /mcp");
			const subcommands = mcp.subcommands ?? [];
			expect(subcommands.length).toBeGreaterThan(0);

			const offered: Array<{ subcommand: string; word: string }> = [];
			for (const subcommand of subcommands) {
				for (const group of subcommand.usage?.match(/\[[^\]]+\]/g) ?? []) {
					const body = group.slice(1, -1);
					if (body.includes("<")) continue;
					for (const word of body.split("|")) offered.push({ subcommand: subcommand.name, word });
				}
			}
			// A usage that offers no plain word at all would pass this vacuously.
			expect(offered.map(entry => entry.word).sort()).toEqual(["http", "semantic", "sse"]);

			const refused: string[] = [];
			for (const { subcommand, word } of offered) {
				const { run } = textSurface(projectDir);
				const shown = await run(`/mcp ${subcommand} offered-name ${word}`);
				if (shown.includes("is gone") || shown.includes("Unknown argument")) {
					refused.push(`/mcp ${subcommand} … ${word}`);
				}
			}
			expect(refused).toEqual([]);
		});
	});
});
