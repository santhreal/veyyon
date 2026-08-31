/**
 * The process-global MCP manager slot. One owner, and it imports nothing.
 *
 * WHY THE SLOT IS NOT ON THE CLASS. It was: a `static #instance` on `MCPManager`, read through
 * `MCPManager.instance()`. Reading it therefore meant importing the class, and the class is the MCP
 * client, the transports, the tool loader and the servers' schemas: 870 modules.
 *
 * `internal-urls/mcp-protocol.ts` only ever needed the slot. It uses `MCPManager` as a TYPE everywhere
 * else, and its one value use was `MCPManager.instance()`, so a `mcp://` handler that asks "is there a
 * manager, and if so read this resource from it" pulled the whole client in. `internal-urls/router.ts`
 * constructs every handler, `tools/read.ts` consults the router (a `read` of `mcp://…` is a real
 * feature), and 54 test files import `read`. So 796 modules reached only through that one edge.
 *
 * `MCPManager.instance()` and `MCPManager.setInstance()` still exist and still work; they delegate here,
 * so there is exactly one slot and every existing caller is unchanged. Import this module directly when
 * you want to READ the slot without depending on the client.
 *
 * NOTHING IS SILENT ABOUT AN EMPTY SLOT. `undefined` means no manager was installed, which is the
 * ordinary state of a process that configured no MCP servers, and every reader already handles it by
 * saying so: the `mcp://` handler throws "No MCP manager available. MCP servers may not be configured."
 * with the available-resource list. That is unchanged, because the slot is filled by `sdk.ts` at the
 * point it builds a manager and not by the class being imported.
 */

import type { MCPManager } from "./manager";

let current: MCPManager | undefined;

/** The installed manager, or `undefined` when this process has none. */
export function mcpManagerInstance(): MCPManager | undefined {
	return current;
}

/**
 * Install or clear the process-global manager.
 *
 * Clearing is not a special case: `sdk.ts` installs one only for a top-level session, and a test that
 * installs a manager has to be able to put the slot back or the next suite in the same process reads a
 * manager whose transports are closed.
 */
export function setMcpManagerInstance(value: MCPManager | undefined): void {
	current = value;
}
