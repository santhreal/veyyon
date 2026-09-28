/**
 * WHY: `/mcp` manages MCP servers through subcommands declared inline in
 * `MCPCommandController.handle`. A new subcommand with no desktop decision is a
 * server operation the window cannot perform, with nothing to say so. This
 * sweep reads the routes the controller hands its dispatcher at run time and
 * fails on a route with no row and on a row whose route is gone. The recorded
 * gaps are pinned by exact equality, so closing or opening one is a decision.
 *
 * Not caught: whether `SetMcpEnabled` persists a disabled server the way the
 * terminal's `disable` does; this sweep checks the decision, not the effect.
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

const RECORDED_GAPS = [
	"add",
	"notifications",
	"prompts",
	"reauth",
	"reload",
	"remove",
	"resources",
	"smithery-login",
	"smithery-logout",
	"smithery-search",
	"test",
	"unauth",
];

describe("the /mcp subcommands on the desktop", () => {
	it("decides every subcommand the terminal routes, and only those", async () => {
		const subcommands = await terminalMcpSubcommands();
		expect(subcommands.filter(name => !(name in MCP_SUBCOMMAND_CARRIERS))).toEqual([]);
		expect(Object.keys(MCP_SUBCOMMAND_CARRIERS).filter(name => !subcommands.includes(name))).toEqual([]);
	});

	it("pins the carried subcommands, the opt-outs and the recorded gaps", () => {
		expect(membersCarriedBy(MCP_SUBCOMMAND_CARRIERS, "action")).toEqual(["disable", "enable", "list", "reconnect"]);
		expect(membersCarriedBy(MCP_SUBCOMMAND_CARRIERS, "optOut")).toEqual([]);
		expect(membersCarriedBy(MCP_SUBCOMMAND_CARRIERS, "gap")).toEqual(RECORDED_GAPS);
	});
});
