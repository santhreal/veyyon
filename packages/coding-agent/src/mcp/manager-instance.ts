/** The process-global MCP manager slot. One owner, and it imports nothing. `MCPManager.instance()`. Reading it therefore meant importing the class, and the class is the MCP */

import type { MCPManager } from "./manager";

let current: MCPManager | undefined;

/** The installed manager, or `undefined` when this process has none. */
export function mcpManagerInstance(): MCPManager | undefined {
	return current;
}

/** Install or clear the process-global manager. Clearing is not a special case: `sdk.ts` installs one only for a top-level session, and a test that */
export function setMcpManagerInstance(value: MCPManager | undefined): void {
	current = value;
}
