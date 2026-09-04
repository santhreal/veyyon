/** Capability tier a tool exercises. Determines which approval modes auto-approve it. */
export type ToolTier = "read" | "write" | "exec";

/**
 * Per-tool approval declaration.
 * - bare tier ("read" / "write" / "exec") — static classification.
 * - object form — adds a `reason` (shown in the prompt) and/or `override: true`
 *   (force-prompt even in modes that would otherwise auto-approve this tier).
 * - function — dynamic, given parsed args. Returns either form above.
 *
 * `critical: true` is `override` with a floor under it. An override forces a
 * prompt in `plan`, `ask` and `auto-edit`, and yolo skips it entirely, so the
 * most dangerous calls were the ones most likely to run in the mode that
 * ignored the check. A critical decision still prompts in yolo and survives the
 * `/yolo` bypass. Setting `tools.approval.<tool>` explicitly remains
 * authoritative in both directions, so `allow` is the escape hatch and `deny`
 * is still a hard block.
 *
 * Omitted approvals are treated as "exec" by callers that enforce approvals.
 */
export type ToolApprovalDecision =
	| ToolTier
	| { tier: ToolTier; reason?: string; override?: boolean; critical?: boolean };
export type ToolApproval = ToolApprovalDecision | ((args: unknown) => ToolApprovalDecision);
