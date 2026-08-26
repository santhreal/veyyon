/**
 * The process-global MCP manager slot. One owner, imports nothing. The slot was on `MCPManager` as
 * `static #instance`; reading it meant importing the class (870 modules). `mcp-protocol.ts` only needed
 * the slot, and through it 796 modules were pulled in. `MCPManager.instance()`/`setInstance()` still
 * work; they delegate here. `undefined` means no manager — ordinary for a process with no MCP servers.
 */

import type { MCPManager } from "./manager";

let current: MCPManager | undefined;

/** The installed manager, or `undefined` when this process has none. */
export function mcpManagerInstance(): MCPManager | undefined {
	return current;
}

/**
 * Install or clear the process-global manager. `sdk.ts` installs one for a top-level session; tests
 * must be able to clear it or the next suite reads a manager with closed transports.
 */
export function setMcpManagerInstance(value: MCPManager | undefined): void {
	current = value;
}
