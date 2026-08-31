/**
 * The synthetic tool name eval uses to reach the `agent()` helper.
 *
 * A leaf with no imports so a dispatcher can RECOGNIZE the name without loading the bridge that
 * implements it. `agent-bridge.ts` runs a real subagent and reaches 475 modules -- the MCP
 * manager, task discovery, the prompt registry -- and `js/tool-bridge` imported it eagerly to
 * compare one string, so every Python, Ruby, Julia and JS eval path paid for the whole agent
 * stack whether or not any eval ever called `agent()`.
 */

/** Synthetic bridge name reserved for the `agent()` helper across both runtimes. */
export const EVAL_AGENT_BRIDGE_NAME = "__agent__";
