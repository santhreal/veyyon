/**
 * WHY: `/mcp` manages MCP servers through subcommands declared inline in
 * `MCPCommandController.handle`. A new subcommand with no desktop decision is a
 * server operation the window cannot perform, with nothing to say so. This
 * sweep reads the routes the controller hands its dispatcher at run time and
 * fails on a route with no row and on a row whose route is gone. The recorded
 * gaps are pinned by exact equality, so closing or opening one is a decision.
 *
 * Not caught: what a carrier does once sent. The effects are pinned by
 * `an-mcp-server-is-managed-from-the-desktop-as-the-terminal-manages-it.test.ts`.
 */
import { describe, expect, it, spyOn } from "bun:test";
import { membersCarriedBy } from "../../../src/gui-host/desktop-parity/carrier";
import { MCP_SUBCOMMAND_CARRIERS } from "../../../src/gui-host/desktop-parity/mcp";
import * as shared from "../../../src/modes/terminal/controllers/command-controller-shared";
import {
	MCPCommandController,
	type McpCommandControllerContext,
} from "../../../src/modes/terminal/controllers/mcp-command-controller";

/** The route names `/mcp` declares, read from the routes the controller hands its dispatcher. */
async function terminalMcpSubcommands(): Promise<string[]> {
	let routes: readonly shared.SubcommandRouteDef[] = [];
	const dispatch = spyOn(shared, "dispatchSubcommand").mockImplementation(async (_text, _command, declared) => {
		routes = declared;
	});
	try {
		await new MCPCommandController({} as McpCommandControllerContext).handle("/mcp");
	} finally {
		dispatch.mockRestore();
	}
	return routes.map(route => route.name).sort();
}

/** Every carried subcommand, with the action or section that carries it. */
const CARRIED = {
	add: "AddMcpServer",
	disable: "SetMcpEnabled",
	enable: "SetMcpEnabled",
	list: "RefreshMcp",
	notifications: "McpCatalog",
	prompts: "McpCatalog",
	reauth: "ReauthMcpServer",
	reconnect: "SetMcpEnabled",
	reload: "ReloadMcp",
	remove: "RemoveMcpServer",
	resources: "McpCatalog",
	"smithery-login": "LoginMcpRegistry",
	"smithery-logout": "LogoutMcpRegistry",
	"smithery-search": "SearchMcpRegistry",
	test: "TestMcpServer",
	unauth: "ClearMcpServerAuth",
};

describe("the /mcp subcommands on the desktop", () => {
	it("decides every subcommand the terminal routes, and only those", async () => {
		const subcommands = await terminalMcpSubcommands();
		expect(subcommands.filter(name => !(name in MCP_SUBCOMMAND_CARRIERS))).toEqual([]);
		expect(Object.keys(MCP_SUBCOMMAND_CARRIERS).filter(name => !subcommands.includes(name))).toEqual([]);
	});

	it("pins the carrier of every subcommand, and records no gap and no opt-out", () => {
		const carried = Object.fromEntries(
			Object.entries(MCP_SUBCOMMAND_CARRIERS).flatMap(([name, carrier]): [string, string][] => {
				if ("action" in carrier) return [[name, carrier.action]];
				if ("section" in carrier) return [[name, carrier.section]];
				return [];
			}),
		);
		expect(carried).toEqual(CARRIED);
		expect(membersCarriedBy(MCP_SUBCOMMAND_CARRIERS, "optOut")).toEqual([]);
		expect(membersCarriedBy(MCP_SUBCOMMAND_CARRIERS, "gap")).toEqual([]);
	});
});
