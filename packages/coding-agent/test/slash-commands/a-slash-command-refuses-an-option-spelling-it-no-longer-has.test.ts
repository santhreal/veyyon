/**
 * A slash command's arguments are plain words, and an argument written in the
 * option style the grammar no longer has is REFUSED.
 *
 * THE DEFECT CLASS. `/mcp`, `/ssh` and `/stats` read dash-prefixed options
 * (`--url`, `--token`, `--scope`, `--host`, `--user`, `--port`, `--key`,
 * `--limit`, `--semantic`, and a bare `--` separator). Converting them to plain
 * words leaves two ways to be wrong, and both are silent:
 *
 *   - ACCEPT the old spelling, and the grammar nobody can see stays alive, so the
 *     documented one is a suggestion;
 *   - IGNORE the old spelling, and the command runs missing the very thing that
 *     was asked for — a server registered with no URL, a host written to the wrong
 *     port, a dashboard on a port the operator did not choose.
 *
 * So the contract is a third thing: refuse, name the plain word that replaced it,
 * and reach no writer. This suite drives the REAL interactive controllers, which
 * are the surface an operator types at, and asserts the refusal and the absence of
 * the write together. Asserting only the message would pass while the config was
 * being written anyway.
 *
 * THE INVARIANT, not the reproduction: on every converted subcommand, a token
 * starting with `-` is refused. That is asserted per subcommand rather than per
 * removed option, so an option name nobody thought to list is still covered.
 *
 * WHAT THIS DOES NOT CATCH. `/stats` has no controller — its grammar is a pure
 * parser, and its refusals are pinned in `stats-dashboard-args.test.ts`. The ACP
 * surface of the same two commands is pinned in `acp-builtins.test.ts`. And a
 * plain word that fits no slot is a different failure (`Unknown argument`), which
 * the parser suites own.
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as mcpConfigWriter from "@veyyon/coding-agent/mcp/config-writer";
import { MCPCommandController } from "@veyyon/coding-agent/modes/controllers/mcp-command-controller";
import { SSHCommandController } from "@veyyon/coding-agent/modes/controllers/ssh-command-controller";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import * as sshConfigWriter from "@veyyon/coding-agent/ssh/config-writer";

/** Every `/mcp` grammar that was converted, and a dash token it must now refuse. */
const MCP_DASH_INVOCATIONS = [
	"/mcp add srv --url https://example.com",
	"/mcp add srv --token secret",
	"/mcp add srv --transport sse",
	"/mcp add srv --scope project",
	"/mcp add srv -- npx some-server",
	"/mcp add --anything",
	"/mcp remove srv --scope user",
	"/mcp rm srv --scope user",
	"/mcp smithery-search files --limit 5",
	"/mcp smithery-search files --semantic",
	"/mcp smithery-search --scope project",
];

/** The same for `/ssh`, whose add grammar carried five of them. */
const SSH_DASH_INVOCATIONS = [
	"/ssh add box --host example.com",
	"/ssh add box example.com --user root",
	"/ssh add box example.com --port 2222",
	"/ssh add box example.com --key ~/.ssh/id_ed25519",
	"/ssh add box example.com --desc laptop",
	"/ssh add --anything",
	"/ssh remove box --scope user",
	"/ssh rm box --scope user",
];

function createMcpController() {
	const showError = vi.fn();
	const present = vi.fn();
	const controller = new MCPCommandController({
		chatContainer: { addChild: vi.fn() },
		present,
		ui: { requestRender: vi.fn() },
		editor: {},
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		showError,
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		oauthManualInput: { hasPending: vi.fn(() => false), pendingProviderId: undefined, tryClaimInput: vi.fn() },
		session: { refreshMCPTools: vi.fn(async () => {}), modelRegistry: { authStorage: undefined } },
		mcpManager: { getAllServerNames: vi.fn(() => [] as string[]), getServerConfig: vi.fn(() => undefined) },
	} as never);
	return { controller, showError, present };
}

function createSshController() {
	const showError = vi.fn();
	const present = vi.fn();
	const refreshSshTool = vi.fn(async () => {});
	const controller = new SSHCommandController({
		present,
		showError,
		session: { refreshSshTool },
	} as never);
	return { controller, showError, present, refreshSshTool };
}

/**
 * The two shapes a removed-option refusal takes: `<token> is gone: <plain word>`
 * when the option has a named replacement, and `Arguments are plain words, and
 * <token> is not one` when it never had one. Asserting one of these — rather than
 * "the message mentions the token" — is what stops a generic `Unknown argument:
 * --user` from passing as a refusal: the operator would learn the word is wrong
 * without learning what to write instead.
 */
function expectRemovedOptionRefusal(message: string, token: string, usagePrefix: string): void {
	expect(message).toContain(token);
	expect(message).toContain(usagePrefix);
	expect(message.includes("is gone:") || message.includes("is not one")).toBe(true);
}

describe("a converted slash command refuses an option spelling it no longer has", () => {
	beforeAll(() => {
		initTheme();
	});

	it.each(MCP_DASH_INVOCATIONS)("/mcp refuses %p and writes no server config", async command => {
		const write = vi.spyOn(mcpConfigWriter, "addMCPServer").mockResolvedValue(undefined);
		try {
			const { controller, showError, present } = createMcpController();

			await controller.handle(command);

			expect(write).not.toHaveBeenCalled();
			expect(showError).toHaveBeenCalledTimes(1);
			const message = showError.mock.calls[0]![0];
			// The refusal names the token the operator wrote and the grammar that
			// replaced it, so the next attempt can succeed without reading the source.
			expectRemovedOptionRefusal(message, command.split(/\s+/).find(word => word.startsWith("-"))!, "Usage: /mcp");
			// A refusal is not a result: nothing is presented to the transcript.
			expect(present).not.toHaveBeenCalled();
		} finally {
			write.mockRestore();
		}
	});

	it.each(SSH_DASH_INVOCATIONS)("/ssh refuses %p and writes no host config", async command => {
		const write = vi.spyOn(sshConfigWriter, "addSSHHost").mockResolvedValue(undefined);
		const remove = vi.spyOn(sshConfigWriter, "removeSSHHost").mockResolvedValue(undefined);
		try {
			const { controller, showError, present, refreshSshTool } = createSshController();

			await controller.handle(command);

			expect(write).not.toHaveBeenCalled();
			expect(remove).not.toHaveBeenCalled();
			expect(refreshSshTool).not.toHaveBeenCalled();
			expect(showError).toHaveBeenCalledTimes(1);
			const message = showError.mock.calls[0]![0];
			expectRemovedOptionRefusal(message, command.split(/\s+/).find(word => word.startsWith("-"))!, "Usage: /ssh");
			expect(present).not.toHaveBeenCalled();
		} finally {
			write.mockRestore();
			remove.mockRestore();
		}
	});

	/**
	 * The positive control. Without it every assertion above could pass on a
	 * controller that refuses everything, including the grammar it documents.
	 */
	it("/ssh add reads the plain-word grammar all the way to the config writer", async () => {
		const write = vi.spyOn(sshConfigWriter, "addSSHHost").mockResolvedValue(undefined);
		try {
			const { controller, showError } = createSshController();

			await controller.handle("/ssh add box example.com user root 2222 key ~/.ssh/id_ed25519 desc laptop compat");

			expect(showError).not.toHaveBeenCalled();
			expect(write).toHaveBeenCalledTimes(1);
			const [, name, hostConfig] = write.mock.calls[0]!;
			expect(name).toBe("box");
			expect(hostConfig).toEqual({
				host: "example.com",
				username: "root",
				port: 2222,
				keyPath: "~/.ssh/id_ed25519",
				description: "laptop",
				compat: true,
			});
		} finally {
			write.mockRestore();
		}
	});

	/**
	 * POSITION is the first disambiguation mechanism, and this is what it buys: a
	 * host whose address is literally a keyword of the same grammar. Position 2 is
	 * the address whatever it spells, so nothing needs escaping.
	 */
	it("/ssh add reads a keyword-looking address by position", async () => {
		const write = vi.spyOn(sshConfigWriter, "addSSHHost").mockResolvedValue(undefined);
		try {
			const { controller, showError } = createSshController();

			await controller.handle("/ssh add user key");

			expect(showError).not.toHaveBeenCalled();
			const [, name, hostConfig] = write.mock.calls[0]!;
			expect(name).toBe("user");
			expect(hostConfig).toEqual({ host: "key" });
		} finally {
			write.mockRestore();
		}
	});

	it("/ssh add refuses a port outside 1-65535 rather than writing it", async () => {
		const write = vi.spyOn(sshConfigWriter, "addSSHHost").mockResolvedValue(undefined);
		try {
			const { controller, showError } = createSshController();

			await controller.handle("/ssh add box example.com 70000");

			expect(write).not.toHaveBeenCalled();
			expect(showError.mock.calls[0]![0]).toContain("Invalid port: 70000");
		} finally {
			write.mockRestore();
		}
	});

	it("/ssh add refuses a word that fits no slot instead of ignoring it", async () => {
		const write = vi.spyOn(sshConfigWriter, "addSSHHost").mockResolvedValue(undefined);
		try {
			const { controller, showError } = createSshController();

			await controller.handle("/ssh add box example.com bogus");

			expect(write).not.toHaveBeenCalled();
			expect(showError.mock.calls[0]![0]).toContain("Unknown argument: bogus");
		} finally {
			write.mockRestore();
		}
	});

	it("/ssh add refuses a repeated word rather than letting the last one win", async () => {
		const write = vi.spyOn(sshConfigWriter, "addSSHHost").mockResolvedValue(undefined);
		try {
			const { controller, showError } = createSshController();

			await controller.handle("/ssh add box example.com user root user admin");

			expect(write).not.toHaveBeenCalled();
			expect(showError.mock.calls[0]![0]).toContain("`user` given twice.");
		} finally {
			write.mockRestore();
		}
	});
});
