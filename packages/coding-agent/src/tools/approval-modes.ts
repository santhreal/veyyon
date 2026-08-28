/** Approval-mode value set — the ONE source of truth for "is this a real approval mode". */

/** The autonomy ladder, in order of how much the agent may do unasked. - `plan` — read-only planning. Not a rung you pick day to day; plan mode */
export type AutonomyLevel = "plan" | "ask" | "ask-command" | "auto" | "yolo";
/** Older names, still accepted from stored config and the CLI. */
export type LegacyApprovalMode = "always-ask" | "write" | "auto-edit";
export type ApprovalMode = AutonomyLevel | LegacyApprovalMode;

/** The rung in force when nothing is configured. ONE literal, referenced everywhere the unset case has to be decided: the */
export const DEFAULT_APPROVAL_MODE = "auto" satisfies AutonomyLevel;

/** Every string the config/CLI accept for `tools.approvalMode`, including the legacy aliases. The enum schema, the flag validator, and the normalizer all */
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

/** Short label for each rung, shared by the status line and `/permissions`. One map, because the status line is where an operator learns which rung they */
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

/** Standing per-tool decisions an operator took at an interactive approval prompt and asked to keep for the rest of the session. */
export interface SessionToolApprovals {
	get(toolName: string): "allow" | "deny" | undefined;
	set(toolName: string, decision: "allow" | "deny"): void;
}
