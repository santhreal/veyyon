/**
 * An MCP failure must name WHICH server failed and WHAT to do about it.
 *
 * THE MEASUREMENT THAT MOTIVATED THIS. An audit of operator- and model-facing
 * error strings put `mcp/**` last of seven surfaces: 4 of 67 detected messages
 * named a remedy, and the 4 were the pre-existing `mcpHttpFailureMessage` sites.
 * The remaining 63 named a failure and stopped.
 *
 * THE THREE DEFECTS, all of which this pins.
 *
 * 1. NO LOCATION. `"Transport not connected"` appeared at six sites across three
 *    transports and `"Request timeout after 30000ms"` at three. A session runs
 *    several MCP servers at once, so neither sentence told an operator or the
 *    model which one had failed. The transport layer holds a config with no
 *    server name in it (`MCPServerConfigBase` in `mcp/types.ts`), so the honest
 *    identifiers are the URL and the subprocess command, and those are what
 *    these messages now carry.
 *
 * 2. NO REMEDY. A timeout is a deadline the operator owns (`timeout` on the
 *    server entry, or `VEYYON_MCP_TIMEOUT_MS`, `0` to disable). A dead transport
 *    is a connection `/mcp reconnect` re-establishes. Neither message said so.
 *
 * 3. A REMEDY THAT WOULD DO HARM. The legacy-SSE cross-origin refusal is the
 *    defence against a server redirecting our `Authorization` header elsewhere.
 *    A first draft of its message told the operator to point the config at the
 *    origin it had just refused, which is the attack performed by hand. It is
 *    asserted here as an explicit prohibition rather than as prose.
 *
 * WHY THE COMMAND CHECKS ARE DERIVED. Asserting the literal `/mcp reconnect`
 * passes forever after the subcommand is renamed. Every `/mcp <sub>` these
 * messages emit is looked up in the real `BUILTIN_SLASH_COMMAND_DECLARATIONS`
 * table, and every `veyyon <sub>` in the real `commands` table, so a rename
 * fails here instead of shipping a dead instruction. `/mcp` carries
 * `textMode: true`, which is what makes naming it legitimate for a reader
 * without a TUI; there is no `veyyon mcp` command, and that is why none is named.
 */

import { describe, expect, it } from "bun:test";
import { commands } from "@veyyon/coding-agent/cli-commands";
import { isRetriableConnectionError } from "@veyyon/coding-agent/mcp/tool-bridge";
import { mcpHttpFailureMessage } from "@veyyon/coding-agent/mcp/transports/http-failure";
import {
	describeMCPServerTarget,
	describeMCPTarget,
	isMCPTransportStateMessage,
	mcpEmptyResponseBodyMessage,
	mcpNoResponseForRequestMessage,
	mcpNotConnectedMessage,
	mcpStreamClosedMessage,
	mcpTimeoutMessage,
} from "@veyyon/coding-agent/mcp/transports/transport-failure";
import { validateServerConfig } from "@veyyon/coding-agent/mcp/validate";
import { BUILTIN_SLASH_COMMAND_DECLARATIONS } from "@veyyon/coding-agent/slash-commands/builtin-declarations";

const REGISTERED_COMMANDS: ReadonlySet<string> = new Set(
	commands.flatMap(entry => [entry.name, ...(entry.aliases ?? [])]),
);

/** The `/mcp` subcommands the slash-command registry really declares. */
const MCP_SUBCOMMANDS: ReadonlySet<string> = new Set(
	(BUILTIN_SLASH_COMMAND_DECLARATIONS.find(entry => entry.name === "mcp")?.subcommands ?? []).map(sub => sub.name),
);

/** Any `veyyon <sub>` a message tells the reader to run that the CLI does not route. */
function unroutableSubcommandsIn(text: string): string[] {
	return [...text.matchAll(/veyyon ([a-z][a-z0-9-]*)/g)]
		.map(match => match[1] as string)
		.filter(name => !REGISTERED_COMMANDS.has(name));
}

/**
 * Any `/mcp <sub>` a message names that the registry does not declare.
 *
 * Anchored on the opening backtick because a configured MCP URL commonly ends in
 * `/mcp`, so an unanchored scan reads the next word of the sentence as a
 * subcommand. Every command these messages name is backtick-quoted.
 */
function undeclaredMcpSubcommandsIn(text: string): string[] {
	return [...text.matchAll(/`\/mcp ([a-z][a-z-]*)/g)]
		.map(match => match[1] as string)
		.filter(name => !MCP_SUBCOMMANDS.has(name));
}

const URL_TARGET = { url: "https://mcp.example.com/mcp" } as const;
const STDIO_TARGET = { command: "npx" } as const;

describe("every MCP failure builder names a target and a fix", () => {
	/**
	 * The whole set in one pass, because a remedy added for the branch someone
	 * happened to open is the defect being fixed. Each entry is a real call, not
	 * a description of one.
	 */
	const messages = (): string[] => [
		mcpNotConnectedMessage(URL_TARGET, 'request "tools/call"'),
		mcpNotConnectedMessage(STDIO_TARGET, 'notification "notifications/initialized"'),
		mcpTimeoutMessage(URL_TARGET, 'request "tools/list"', 30_000),
		mcpTimeoutMessage(STDIO_TARGET, 'notification "x"', 5_000),
		mcpEmptyResponseBodyMessage(URL_TARGET),
		mcpNoResponseForRequestMessage(URL_TARGET, "abc123"),
		mcpStreamClosedMessage(URL_TARGET, "its SSE stream ended"),
		mcpStreamClosedMessage(STDIO_TARGET),
		mcpHttpFailureMessage(URL_TARGET.url, 401, "denied"),
		mcpHttpFailureMessage(URL_TARGET.url, 418, "teapot"),
		mcpHttpFailureMessage(URL_TARGET.url, 503, "down"),
	];

	it("names a fix in every message", () => {
		for (const message of messages()) {
			expect(message).toContain("Fix: ");
		}
	});

	it("names the failing server in every message", () => {
		for (const message of messages()) {
			expect(message).toMatch(/MCP server (at https:\/\/mcp\.example\.com\/mcp|"npx")|mcp\.example\.com/);
		}
	});

	it("names only commands that exist", () => {
		for (const message of messages()) {
			expect(unroutableSubcommandsIn(message)).toEqual([]);
			expect(undeclaredMcpSubcommandsIn(message)).toEqual([]);
		}
	});
});

describe("the target phrase is the identifier the layer actually has", () => {
	it("uses the URL for http and sse and the command for stdio", () => {
		expect(describeMCPTarget(URL_TARGET)).toBe("MCP server at https://mcp.example.com/mcp");
		expect(describeMCPTarget(STDIO_TARGET)).toBe('MCP server "npx"');
	});

	/**
	 * The config-shaped twin, used by the manager and the OAuth refresh path.
	 * A config with neither field is one `validateServerConfig` rejects, so the
	 * fallback states its ignorance rather than inventing an identifier.
	 */
	it("derives the same phrase from a server config, and does not invent one when it cannot", () => {
		expect(describeMCPServerTarget({ type: "http", url: "https://x.example/mcp" })).toBe(
			"MCP server at https://x.example/mcp",
		);
		expect(describeMCPServerTarget({ type: "stdio", command: "uvx" })).toBe('MCP server "uvx"');
		expect(describeMCPServerTarget({ type: "stdio" } as never)).toBe("this MCP server");
	});
});

describe("a timeout message names the deadline and both knobs that move it", () => {
	it("reports the resolved deadline in the message", () => {
		expect(mcpTimeoutMessage(URL_TARGET, 'request "tools/list"', 30_000)).toBe(
			'MCP server at https://mcp.example.com/mcp did not complete request "tools/list" within 30000ms. ' +
				'Fix: raise this server\'s deadline with `"timeout": <milliseconds>` on its entry in your MCP config, ' +
				"or set `VEYYON_MCP_TIMEOUT_MS` (`0` disables the deadline entirely). " +
				"Run `/mcp test <name>` to check whether the server answers at all.",
		);
	});

	/**
	 * `timeout: 0` is a supported configuration meaning "no deadline", and the
	 * message must not then claim the server failed to answer "within 0ms",
	 * which reads as an impossible budget rather than a disabled one.
	 */
	it("says `disabled` rather than `0ms` when the operator turned the deadline off", () => {
		expect(mcpTimeoutMessage(URL_TARGET, "the handshake", 0)).toContain(
			"did not complete the handshake within disabled",
		);
	});
});

describe("a not-connected message names what was lost, not just that something was", () => {
	/**
	 * A notification is retried by nothing, so which one was dropped is the fact
	 * that decides whether the failure matters.
	 */
	it("names the operation that did not go out", () => {
		expect(mcpNotConnectedMessage(STDIO_TARGET, 'notification "notifications/initialized"')).toBe(
			'MCP server "npx" is not connected, so the notification "notifications/initialized" was not sent. ' +
				"Fix: run `/mcp list` to find this server's name, then `/mcp reconnect <name>`. " +
				"If reconnecting fails, `/mcp test <name>` reports why.",
		);
	});
});

describe("a stream that ended without answering is not a timeout", () => {
	/**
	 * Waiting longer would not have helped, so the remedy must not be "raise the
	 * deadline". This is the one pair of failures whose fixes point in different
	 * directions, which is why they are separate builders.
	 */
	it("does not tell the reader to raise the deadline", () => {
		const message = mcpNoResponseForRequestMessage(URL_TARGET, 42);
		expect(message).toContain("closed its response stream without answering request 42");
		expect(message).not.toContain("timeout");
		expect(message).not.toContain("VEYYON_MCP_TIMEOUT_MS");
	});
});

/**
 * THE COUPLING THAT REWORDING WOULD HAVE BROKEN SILENTLY.
 *
 * `isRetriableConnectionError` decides whether a failed MCP tool call is worth a
 * reconnect-and-retry, and it decides it by reading the message. It used to
 * match the literals `"transport not connected"` and `"transport closed"` — the
 * exact sentences these builders replaced — so this rewording would have turned
 * every recoverable stale connection into a hard tool failure with nothing
 * failing. The phrases now live next to the strings that must contain them and
 * are reached through one exported predicate.
 */
describe("the reconnect decision still fires on the new wording", () => {
	it("classifies every transport-state message as retriable", () => {
		for (const message of [
			mcpNotConnectedMessage(URL_TARGET, "request"),
			mcpNotConnectedMessage(STDIO_TARGET, "notification"),
			mcpStreamClosedMessage(URL_TARGET, "its SSE stream ended"),
		]) {
			expect(isMCPTransportStateMessage(message)).toBe(true);
			expect(isRetriableConnectionError(new Error(message))).toBe(true);
		}
	});

	it("does not classify a timeout or a 4xx refusal as retriable", () => {
		expect(isMCPTransportStateMessage(mcpTimeoutMessage(URL_TARGET, "request", 100))).toBe(false);
		expect(isRetriableConnectionError(new Error(mcpHttpFailureMessage(URL_TARGET.url, 400, "bad")))).toBe(false);
	});

	/**
	 * The stale-session statuses, which had ALREADY stopped being detected before
	 * this lane touched anything: the regex was anchored (`/^http (404|502|503):/`)
	 * and `mcpHttpFailureMessage` leads with the URL, so the status sits
	 * mid-sentence and nothing matched.
	 */
	it("detects a stale session when the status is mid-sentence", () => {
		for (const status of [404, 502, 503]) {
			const message = mcpHttpFailureMessage(URL_TARGET.url, status, "session gone");
			expect(message).not.toStartWith("HTTP ");
			expect(isRetriableConnectionError(new Error(message))).toBe(true);
		}
	});
});

describe("a config validation failure shows the shape that would be valid", () => {
	/**
	 * "requires \"command\" field" states the rule and leaves the reader to guess
	 * the syntax. The example is the remedy: it is what distinguishes a message
	 * that ends the search from one that starts another.
	 */
	it("gives a stdio server a concrete command to copy", () => {
		expect(validateServerConfig("fs", {} as never)).toEqual([
			'Server "fs" is a stdio server with no "command" to spawn. Fix: add the executable, for example ' +
				'`"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]`. ' +
				'If this is a remote server, set `"type": "http"` and give it a "url" instead.',
		]);
	});

	/** Both directions, because the reader who set the wrong one is the reader here. */
	it("points an http server at the stdio alternative and back", () => {
		expect(validateServerConfig("api", { type: "http" } as never)[0]).toContain(
			'If this is a local server you want spawned, set `"type": "stdio"` and give it a "command" instead.',
		);
		expect(validateServerConfig("both", { command: "npx", url: "https://x" } as never)[0]).toContain(
			"Fix: delete whichever one is wrong",
		);
	});

	it("names every real transport type when the configured one is unknown", () => {
		const [error] = validateServerConfig("odd", { type: "grpc" } as never);
		expect(error).toContain('"stdio"');
		expect(error).toContain('"http"');
		expect(error).toContain('"sse"');
	});
});
