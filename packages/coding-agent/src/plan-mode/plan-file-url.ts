/**
 * The URL the agent's plan file is addressed by when the session has not named one.
 *
 * A producer and a matcher in two modules: `modes/acp/acp-agent.ts` reports this as the session's
 * `planFilePath`, and `plan-mode/plan-protection.ts` compares a tool's target against it to decide whether an
 * edit is touching the plan. Each declared its own copy.
 *
 * A drift does not raise anything. The protection check simply stops matching, so plan mode keeps reporting
 * that it is protecting the plan file while an edit to that exact path is allowed through, which is the one
 * outcome plan mode exists to prevent.
 *
 * The `local://` scheme means the path is relative to the session rather than to the filesystem, so this value
 * is not a filesystem path and is not resolved as one.
 */

/** The plan file's address when the session has not specified one. */
export const DEFAULT_PLAN_FILE_URL = "local://PLAN.md";
