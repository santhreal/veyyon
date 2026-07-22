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

/** Shipped autonomy ladder (A2). */
export type AutonomyLevel = "plan" | "ask" | "auto-edit" | "yolo";
/** Legacy omp names, still accepted in config/CLI. */
export type LegacyApprovalMode = "always-ask" | "write";
export type ApprovalMode = AutonomyLevel | LegacyApprovalMode;

/**
 * Every string the config/CLI accept for `tools.approvalMode`, including the two
 * legacy aliases. The enum schema, the flag validator, and the normalizer all
 * consult this, so the accepted set never drifts between them.
 */
export const APPROVAL_MODE_VALUES: readonly ApprovalMode[] = [
	"plan",
	"ask",
	"auto-edit",
	"yolo",
	"always-ask",
	"write",
];

const APPROVAL_MODE_SET: ReadonlySet<string> = new Set(APPROVAL_MODE_VALUES);

/** True when `mode` is one of the accepted approval-mode strings (not a typo). */
export function isKnownApprovalMode(mode: unknown): mode is ApprovalMode {
	return typeof mode === "string" && APPROVAL_MODE_SET.has(mode);
}
