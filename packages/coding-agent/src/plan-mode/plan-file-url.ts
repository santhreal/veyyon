/**
 * The URL the agent's plan file is addressed by when the session has not named one. A producer
 * (`acp-agent.ts`) and a matcher (`plan-protection.ts`) each had their own copy; a drift silently
 * disables plan protection. `local://` means the path is relative to the session, not the filesystem.
 */

/** The plan file's address when the session has not specified one. */
export const DEFAULT_PLAN_FILE_URL = "local://PLAN.md";
