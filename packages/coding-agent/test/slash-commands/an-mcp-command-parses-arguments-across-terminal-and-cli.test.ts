/**
 * Arguments to `/mcp` subcommands are parsed through a shared grammar while
 * preserving surface-specific policies (such as trailing scope-word differences
 * between the interactive terminal and non-interactive CLI/ACP handlers).
 *
 * THE DEFECT CLASS: Argument parsing across terminal and CLI previously drifted
 * because each surface maintained its own private parser copy. The terminal
 * parser and CLI parser differed in trailing scope-word handling during search:
 * the terminal controller rejects trailing `project` and `user` words as removed
 * options, whereas the CLI / ACP handler treats trailing unflagged words as
 * search keywords.
 *
 * THE INVARIANT:
 *   1. Argument tails are parsed without interpreting their contents as another command.
 *   2. Trailing plain scope words (`project`, `user`) are refused on the terminal
 *      surface and preserved as search terms on the CLI surface.
 *   3. Removed dashed options are refused with identical descriptive messages on both surfaces.
 *   4. Bare removed options retain each surface's vocabulary and case sensitivity.
 *
 * Provider requests are intercepted; network transport and interactive wizard completion
 * are outside this suite.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as mcpConfigWriter from "@veyyon/coding-agent/mcp/config-writer";
import * as smitheryAuth from "@veyyon/coding-agent/mcp/smithery-auth";
import * as smitheryRegistry from "@veyyon/coding-agent/mcp/smithery-registry";
import type { MCPServerConfig } from "@veyyon/coding-agent/mcp/types";
import { MCPCommandController } from "@veyyon/coding-agent/modes/terminal/controllers/mcp-command-controller";
import { handleMcpAcp } from "@veyyon/coding-agent/slash-commands/helpers/mcp";
import {
	MCP_ADD_REMOVED_OPTIONS,
	MCP_ADD_USAGE,
	MCP_REMOVE_REMOVED_OPTIONS,
	MCP_REMOVE_USAGE,
	MCP_SEARCH_REMOVED_OPTIONS,
	MCP_SEARCH_USAGE,
} from "@veyyon/coding-agent/slash-commands/helpers/mcp-args";
import { MCP_SCOPE_REMOVED_REPLACEMENT, parseSlashCommand } from "@veyyon/coding-agent/slash-commands/helpers/parse";
import type { SlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";

function createTerminalHarness() {
	const errors: string[] = [];
	const messages: string[] = [];
	const showError = vi.fn((msg: string) => {
		errors.push(msg);
	});
	const showStatus = vi.fn();
	const present = vi.fn();
	const mcpManager = {
		disconnectAll: vi.fn(async () => {}),
		invalidateCommandCredentials: vi.fn(() => 0),
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
		prepareConfig: vi.fn(async (config: unknown) => config),
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
			obfuscateProviderText: (t: string) => t,
		},
		mcpManager,
	} as never);

	return {
		controller,
		errors,
		messages,
		mcpManager,
	};
}

function createCliHarness(cwd = "/workspace") {
	const outputs: string[] = [];
	const runtime = {
		cwd,
		output: async (text: string) => {
			outputs.push(text);
		},
		session: {
			modelRegistry: { authStorage: undefined },
			obfuscateProviderText: (t: string) => t,
		},
	} as unknown as SlashCommandRuntime;

	const run = async (line: string) => {
		const parsed = parseSlashCommand(line);
		if (!parsed) throw new Error(`Invalid slash command line: ${line}`);
		return await handleMcpAcp(parsed, runtime);
	};

	return { run, outputs };
}

/** What each search sends to the registry boundary, with the API key answered so the search proceeds. */
function recordSearches(): { keyword: string; limit: number | undefined; includeSemantic: boolean | undefined }[] {
	const searches: { keyword: string; limit: number | undefined; includeSemantic: boolean | undefined }[] = [];
	vi.spyOn(smitheryRegistry, "searchSmitheryRegistry").mockImplementation(async (keyword, options) => {
		searches.push({ keyword, limit: options?.limit, includeSemantic: options?.includeSemantic });
		return [];
	});
	vi.spyOn(smitheryAuth, "getSmitheryApiKey").mockImplementation(async () => "test-api-key");
	return searches;
}

describe("an MCP command parses arguments across terminal and CLI", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("search argument trailing scope-word distinction", () => {
		it("rejects trailing scope words on terminal surface", async () => {
			const harness = createTerminalHarness();

			await harness.controller.handle("/mcp smithery-search redis project");
			expect(harness.errors).toHaveLength(1);
			expect(harness.errors[0]).toContain("project is gone:");
			expect(harness.errors[0]).toContain(MCP_SCOPE_REMOVED_REPLACEMENT);

			harness.errors.length = 0;
			await harness.controller.handle("/mcp smithery-search redis user");
			expect(harness.errors).toHaveLength(1);
			expect(harness.errors[0]).toContain("user is gone:");
			expect(harness.errors[0]).toContain(MCP_SCOPE_REMOVED_REPLACEMENT);

			harness.errors.length = 0;
			await harness.controller.handle("/mcp smithery-search redis project 50");
			expect(harness.errors).toHaveLength(1);
			expect(harness.errors[0]).toContain("project is gone:");
		});

		it("keeps trailing scope words as keyword text on CLI surface", async () => {
			const searches = recordSearches();

			const harness = createCliHarness();
			await harness.run("/mcp smithery-search redis project");

			expect(searches).toEqual([{ keyword: "redis project", limit: 20, includeSemantic: false }]);
			expect(harness.outputs[0]).toContain('No Smithery results found for "redis project".');

			searches.length = 0;
			harness.outputs.length = 0;
			await harness.run("/mcp smithery-search redis user 10 semantic");
			expect(searches).toEqual([{ keyword: "redis user", limit: 10, includeSemantic: true }]);
		});

		it("preserves quoted scope words on terminal surface without refusal", async () => {
			const searches = recordSearches();

			const harness = createTerminalHarness();
			await harness.controller.handle('/mcp smithery-search "redis project"');

			expect(harness.errors).toHaveLength(0);
			expect(searches.map(search => search.keyword)).toEqual(["redis project"]);
		});
	});

	describe("search argument validation parity", () => {
		it("refuses empty keyword on both surfaces", async () => {
			const term = createTerminalHarness();
			await term.controller.handle("/mcp smithery-search");
			expect(term.errors[0]).toBe(`Keyword required.\n${MCP_SEARCH_USAGE}`);

			const cli = createCliHarness();
			await cli.run("/mcp smithery-search");
			expect(cli.outputs[0]).toBe(`Keyword required.\n${MCP_SEARCH_USAGE}`);
		});

		it("refuses out-of-range numeric limits on both surfaces", async () => {
			const term = createTerminalHarness();
			await term.controller.handle("/mcp smithery-search redis 0");
			expect(term.errors[0]).toBe(`Invalid limit: 0. Use an integer between 1 and 100.\n${MCP_SEARCH_USAGE}`);

			term.errors.length = 0;
			await term.controller.handle("/mcp smithery-search redis 101");
			expect(term.errors[0]).toBe(`Invalid limit: 101. Use an integer between 1 and 100.\n${MCP_SEARCH_USAGE}`);

			const cli = createCliHarness();
			await cli.run("/mcp smithery-search redis 0");
			expect(cli.outputs[0]).toBe(`Invalid limit: 0. Use an integer between 1 and 100.\n${MCP_SEARCH_USAGE}`);
		});

		it("refuses duplicate options on both surfaces", async () => {
			const term = createTerminalHarness();
			await term.controller.handle("/mcp smithery-search redis semantic semantic");
			expect(term.errors[0]).toBe(`\`semantic\` given twice.\n${MCP_SEARCH_USAGE}`);

			term.errors.length = 0;
			await term.controller.handle("/mcp smithery-search redis 10 20");
			expect(term.errors[0]).toBe(`\`limit\` given twice.\n${MCP_SEARCH_USAGE}`);

			const cli = createCliHarness();
			await cli.run("/mcp smithery-search redis semantic semantic");
			expect(cli.outputs[0]).toBe(`\`semantic\` given twice.\n${MCP_SEARCH_USAGE}`);

			cli.outputs.length = 0;
			await cli.run("/mcp smithery-search redis 10 20");
			expect(cli.outputs[0]).toBe(`\`limit\` given twice.\n${MCP_SEARCH_USAGE}`);
		});

		it("refuses dashed options on both surfaces", async () => {
			for (const key of Object.keys(MCP_SEARCH_REMOVED_OPTIONS)) {
				const term = createTerminalHarness();
				await term.controller.handle(`/mcp smithery-search redis --${key}`);
				expect(term.errors[0]).toContain(`--${key} is gone:`);

				const cli = createCliHarness();
				await cli.run(`/mcp smithery-search redis --${key}`);
				expect(cli.outputs[0]).toContain(`--${key} is gone:`);
			}
		});
	});

	it.each([
		{ verb: "add", expected: `Unknown argument: add\n${MCP_ADD_USAGE}` },
		{ verb: "remove", expected: `Unknown argument: remove\n${MCP_REMOVE_USAGE}` },
		{ verb: "smithery-search", expected: 'No Smithery results found for "/mcp smithery-search redis".' },
	])("does not reinterpret a $verb argument as another command", async ({ verb, expected }) => {
		vi.spyOn(smitheryAuth, "getSmitheryApiKey").mockResolvedValue("test-api-key");
		vi.spyOn(smitheryRegistry, "searchSmitheryRegistry").mockResolvedValue([]);
		vi.spyOn(mcpConfigWriter, "removeMCPServer").mockResolvedValue(undefined);
		const cli = createCliHarness();
		await cli.run(`/mcp ${verb} /mcp ${verb} redis`);
		expect(cli.outputs).toEqual([expected]);
	});

	for (const [verb, options, usage] of [
		["add", MCP_ADD_REMOVED_OPTIONS, MCP_ADD_USAGE],
		["remove", MCP_REMOVE_REMOVED_OPTIONS, MCP_REMOVE_USAGE],
	] as const) {
		const words = Object.keys(options)
			.filter(word => word !== "" && word !== "url" && word !== "token")
			.flatMap(word => [word, word.toUpperCase()]);
		it.each(words)(`${verb} preserves surface-specific bare option %s`, async word => {
			const term = createTerminalHarness();
			await term.controller.handle(`/mcp ${verb} server ${word}`);
			if (word === "project" || word === "user") {
				expect(term.errors[0]).toContain("is gone:");
			} else {
				expect(term.errors).toEqual([`Unknown argument: ${word}\n${usage}`]);
			}
			const cli = createCliHarness();
			await cli.run(`/mcp ${verb} server ${word}`);
			expect(cli.outputs[0]).toContain("is gone:");
		});
	}

	describe("add and remove argument validation parity", () => {
		it("refuses removed scope options on /mcp add", async () => {
			const term = createTerminalHarness();
			await term.controller.handle("/mcp add my-server project");
			expect(term.errors[0]).toContain("project is gone:");
			expect(term.errors[0]).toContain(MCP_SCOPE_REMOVED_REPLACEMENT);

			const cli = createCliHarness();
			await cli.run("/mcp add my-server project");
			expect(cli.outputs[0]).toContain("project is gone:");
			expect(cli.outputs[0]).toContain(MCP_SCOPE_REMOVED_REPLACEMENT);
		});

		it("refuses removed scope options on /mcp remove", async () => {
			const term = createTerminalHarness();
			await term.controller.handle("/mcp remove my-server project");
			expect(term.errors[0]).toContain("project is gone:");
			expect(term.errors[0]).toContain(MCP_SCOPE_REMOVED_REPLACEMENT);

			const cli = createCliHarness();
			await cli.run("/mcp remove my-server project");
			expect(cli.outputs[0]).toContain("project is gone:");
			expect(cli.outputs[0]).toContain(MCP_SCOPE_REMOVED_REPLACEMENT);
		});

		it("refuses unknown extra arguments on /mcp remove", async () => {
			const term = createTerminalHarness();
			await term.controller.handle("/mcp remove my-server extra");
			expect(term.errors[0]).toBe(`Unknown argument: extra\n${MCP_REMOVE_USAGE}`);

			const cli = createCliHarness();
			await cli.run("/mcp remove my-server extra");
			expect(cli.outputs[0]).toBe(`Unknown argument: extra\n${MCP_REMOVE_USAGE}`);
		});

		it("correctly adds stdio server via CLI", async () => {
			const added: { name: string; config: MCPServerConfig }[] = [];
			vi.spyOn(mcpConfigWriter, "addMCPServer").mockImplementation(async (_filePath, name, config) => {
				added.push({ name, config });
			});

			const cli = createCliHarness();
			await cli.run("/mcp add echo-server run echo hello");

			expect(added).toHaveLength(1);
			expect(added[0]?.name).toBe("echo-server");
			expect(added[0]?.config).toMatchObject({ type: "stdio", command: "echo", args: ["hello"] });
			expect(cli.outputs[0]).toBe('Added MCP server "echo-server".');
		});
	});
});
