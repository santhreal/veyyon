/**
 * Approval-mode value set — the ONE source of truth for "is this a real approval
 * mode".
 *
 * This module has ZERO runtime imports on purpose. The CLI flag table
 * (`cli/flag-tables.ts`) validates `--approval-mode` against it, and that file
 * must not transitively load `@veyyon/utils` (whose `env.ts` eagerly reads
 * `.env` during module init and would race the profile bootstrap). `approval.ts`
 * — which does import `@veyyon/utils` — re-exports these so tool code keeps a
 * single import site.
 */

/**
 * The autonomy ladder, in order of how much the agent may do unasked.
 *
 * - `plan`   — read-only planning. Not a rung you pick day to day; plan mode
 *              caps to it while a plan session is active.
 * - `ask`    — ask about everything. No tier runs unasked, reads included.
 * - `ask-command` — ask about commands only. Reads and workspace writes run;
 *              anything that executes (bash, eval, browser, ssh, task) asks.
 * - `auto`   — run every tier unasked, with the guards still on: per-tool
 *              policies, the cwd boundary, the secret-use boundary, and a tool's
 *              own `critical` calls all still stop and ask.
 * - `yolo`   — no prompts. The only things left are the blatantly destructive
 *              (`rm -rf /` and its expansions, via the bash guard's `critical`
 *              floor) and an explicit `tools.approval.<tool>: deny`.
 */
export type AutonomyLevel = "plan" | "ask" | "ask-command" | "auto" | "yolo";
/** Older names, still accepted from stored config and the CLI. */
export type LegacyApprovalMode = "always-ask" | "write" | "auto-edit";
export type ApprovalMode = AutonomyLevel | LegacyApprovalMode;

/**
 * The rung in force when nothing is configured.
 *
 * ONE literal, referenced everywhere the unset case has to be decided: the
 * `tools.approvalMode` schema default, `normalizeApprovalMode(undefined)`,
 * `resolveEffectiveApprovalMode(undefined)`, and the tool wrapper's read of a
 * missing `Settings`. Those four used to spell their own fallback, so the
 * effective default depended on which path ran first.
 *
 * `auto`, not `ask`: out of the box every tier runs, with the guards still on
 * (per-tool policies, the working-directory boundary, credential use, and a
 * tool's own critical calls all still stop and ask). An operator who wants a
 * stricter rung sets it once in `/settings`, in onboarding, or per session with
 * `/permissions`. A typo in a stored value is a different question and still
 * fails closed to `ask`, never up the ladder (see `normalizeApprovalMode`).
 */
export const DEFAULT_APPROVAL_MODE = "auto" satisfies AutonomyLevel;

/**
 * Every string the config/CLI accept for `tools.approvalMode`, including the
 * legacy aliases. The enum schema, the flag validator, and the normalizer all
 * consult this, so the accepted set never drifts between them.
 *
 * Ladder rungs first, in ladder order, because this array is also what `--help`
 * and the CLI error message print: a list that reads `plan, ask, ask-command,
 * auto, yolo` teaches the ordering, and one in declaration-accident order does
 * not.
 */
export const APPROVAL_MODE_VALUES: readonly ApprovalMode[] = [
	"plan",
	"ask",
	"ask-command",
	"auto",
	"yolo",
	"always-ask",
	"write",
	"auto-edit",
];

/**
 * Short label for each rung, shared by the status line and `/permissions`.
 *
 * One map, because the status line is where an operator learns which rung they
 * are on and `/permissions` is where they change it: two spellings of the same
 * rung across those two surfaces is how you end up unsure whether "Auto" and
 * "Auto-edit" are the same thing. Short enough for a status segment, which is
 * the tighter of the two budgets.
 */
export const AUTONOMY_LABEL: Record<AutonomyLevel, string> = {
	plan: "Plan",
	ask: "Ask all",
	"ask-command": "Ask cmds",
	auto: "Auto",
	yolo: "Yolo",
};
const APPROVAL_MODE_SET: ReadonlySet<string> = new Set(APPROVAL_MODE_VALUES);

/** True when `mode` is one of the accepted approval-mode strings (not a typo). */
export function isKnownApprovalMode(mode: unknown): mode is ApprovalMode {
	return typeof mode === "string" && APPROVAL_MODE_SET.has(mode);
}

/**
 * Standing per-tool decisions an operator took at an interactive approval
 * prompt and asked to keep for the rest of the session.
 *
 * Deliberately narrower than the Map behind it: two operations, no iteration,
 * no clear. A session grant is not a policy — `tools.approval` in settings is
 * the policy, and it is written by the operator, never by a dialog.
 */
export interface SessionToolApprovals {
	get(toolName: string): "allow" | "deny" | undefined;
	set(toolName: string, decision: "allow" | "deny"): void;
}
