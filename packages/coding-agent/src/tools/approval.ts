/**
 * Tool approval resolution.
 *
 * Approval policy is declared by each tool. This module only knows how to:
 * - normalize user `tools.approval.<tool>: allow | deny | prompt` overrides,
 * - compare a tool capability tier against the active autonomy / approval mode,
 * - format the generic approval prompt body.
 */

import type { AgentTool, ToolApprovalDecision, ToolTier } from "@veyyon/agent-core";
import { isRecord } from "@veyyon/utils";
import type { ApprovalMode, AutonomyLevel } from "./approval-modes";
import { APPROVAL_MODE_VALUES, isKnownApprovalMode } from "./approval-modes";

export type { ToolApproval, ToolApprovalDecision, ToolTier } from "@veyyon/agent-core";
// Re-export the zero-dependency mode set so tool code keeps one import site.
export {
	APPROVAL_MODE_VALUES,
	type ApprovalMode,
	type AutonomyLevel,
	isKnownApprovalMode,
	type LegacyApprovalMode,
} from "./approval-modes";

export type ApprovalPolicy = "allow" | "deny" | "prompt";

export interface ApprovalResolutionOptions {
	/** When plan-mode session is active, write-tier tools may run (plan-file guard at execute). */
	planModeActive?: boolean;
	/**
	 * Full bypass (the `/yolo` command): every approval that would prompt is
	 * allowed instead, including per-tool `prompt` overrides and a tool's own
	 * `approval(args)` prompt. This is stronger than the `yolo` autonomy level,
	 * which still honors per-tool `prompt`/`deny`. A hard `deny` is never a
	 * prompt, so bypass never overrides one: an explicit user
	 * `tools.approval.<tool>: deny` and a plan-mode mutation block both still
	 * stop the call (fail closed on real denials).
	 */
	bypassAllApprovals?: boolean;
}

type ApprovalSubject = Pick<AgentTool, "name" | "approval" | "formatApprovalDetails">;

export interface ResolvedApproval {
	policy: ApprovalPolicy;
	tier: ToolTier;
	reason?: string;
	override: boolean;
	/**
	 * True when the tool judged this specific call dangerous enough to prompt
	 * even in yolo. Carried on the result so the `/yolo` bypass can tell a
	 * routine prompt from a floor it must not lift.
	 */
	critical?: boolean;
}

const POLICY_VALUES: ReadonlySet<ApprovalPolicy> = new Set(["allow", "deny", "prompt"]);
const TIER_VALUES: ReadonlySet<ToolTier> = new Set(["read", "write", "exec"]);

const TIER_RANK: Record<ToolTier, number> = {
	read: 0,
	write: 1,
	exec: 2,
};

const AUTONOMY_MAX_TIER: Record<AutonomyLevel, ToolTier> = {
	plan: "read",
	ask: "read",
	"auto-edit": "write",
	yolo: "exec",
};

const DEFAULT_PROMPT_TRUNCATE_CHARS = 2000;

/**
 * Map a stored setting / CLI value to the shipped autonomy ladder.
 *
 * `undefined` (no configured mode) maps to `yolo`, the documented product
 * default for a fresh install. An unrecognized NON-EMPTY value (a hand-edited
 * config typo like `askk`) FAILS CLOSED to `ask` — never to `yolo`. Mapping a
 * typo to yolo would silently turn a user's intended safety setting into
 * auto-approve-everything; a security control must fail closed, not open. The
 * typo is surfaced loudly by the startup config check (see
 * `validateApprovalModeSetting`), so this is not a silent fallback.
 */
export function normalizeApprovalMode(mode: string | undefined): AutonomyLevel {
	switch (mode) {
		case "plan":
			return "plan";
		case "ask":
		case "always-ask":
			return "ask";
		case "auto-edit":
		case "write":
			return "auto-edit";
		case "yolo":
			return "yolo";
		case undefined:
			return "yolo";
		default:
			return "ask";
	}
}

/**
 * Validate a stored `tools.approvalMode` value. Returns a loud warning string
 * when the value is a non-empty string that is not a recognized mode (so the
 * caller can surface it at startup); `undefined` when the value is absent or
 * valid. Keeps the "fail closed on a typo" decision (see `normalizeApprovalMode`)
 * visible to the operator instead of silently applying `ask`.
 */
export function validateApprovalModeSetting(configured: unknown): string | undefined {
	if (configured === undefined || configured === null) return undefined;
	if (isKnownApprovalMode(configured)) return undefined;
	return (
		`tools.approvalMode is set to an unrecognized value (${JSON.stringify(configured)}); ` +
		`falling back to "ask" (safe). Valid values: ${APPROVAL_MODE_VALUES.join(", ")}.`
	);
}

/** Best-effort conversion of an arbitrary user-supplied value to a policy. */
function normalizePolicy(value: unknown): ApprovalPolicy | undefined {
	if (typeof value !== "string") return undefined;
	const lowered = value.trim().toLowerCase();
	return POLICY_VALUES.has(lowered as ApprovalPolicy) ? (lowered as ApprovalPolicy) : undefined;
}

function isToolTier(value: unknown): value is ToolTier {
	return typeof value === "string" && TIER_VALUES.has(value as ToolTier);
}

function normalizeDecision(value: unknown): Omit<ResolvedApproval, "policy"> {
	if (isToolTier(value)) {
		return { tier: value, override: false };
	}

	if (isRecord(value)) {
		const record = value as Record<string, unknown>;
		const tier = isToolTier(record.tier) ? record.tier : "exec";
		const reason = typeof record.reason === "string" && record.reason.length > 0 ? record.reason : undefined;
		// `critical` implies `override`: a decision that must survive yolo must
		// also beat a per-tool allow, and requiring both flags at every call site
		// is a way to eventually forget one.
		const critical = record.critical === true;
		return {
			tier,
			override: critical || record.override === true,
			...(critical ? { critical: true } : {}),
			...(reason ? { reason } : {}),
		};
	}

	return { tier: "exec", override: false };
}

function getToolDecision(tool: ApprovalSubject, args: unknown): Omit<ResolvedApproval, "policy"> {
	const approval = tool.approval;
	const decision: ToolApprovalDecision | undefined = typeof approval === "function" ? approval(args) : approval;
	return normalizeDecision(decision);
}

function autonomyApprovesTier(level: AutonomyLevel, tier: ToolTier): boolean {
	return TIER_RANK[tier] <= TIER_RANK[AUTONOMY_MAX_TIER[level]];
}

function planAutonomyBlocksMutation(
	level: AutonomyLevel,
	tier: ToolTier,
	options?: ApprovalResolutionOptions,
): boolean {
	if (level !== "plan") return false;
	if (tier === "read") return false;
	if (options?.planModeActive && tier === "write") return false;
	return true;
}

/**
 * Resolve approval policy for a tool call.
 *
 * Resolution order:
 *  1. Tool `approval(args)` decision, defaulting to tier "exec" when omitted.
 *  2. User per-tool override, if set and valid, EXCEPT that an active plan-mode
 *     session blocks mutations regardless of a per-tool `allow` (a `deny` still
 *     wins, and a configured `plan` level with no active session does not cap).
 *  3. Active autonomy level tier comparison (`plan` denies mutations; `ask` prompts).
 *
 * In yolo mode, override-based tool prompts are ignored; user `tools.approval`
 * settings remain authoritative. The exception is a decision the tool marked
 * `critical`, which still prompts in yolo unless `tools.approval.<tool>` says
 * otherwise. Without that floor the ordering is inverted: the calls a tool
 * considers most dangerous are the ones most likely to run in the mode that
 * skips the check.
 *
 * When `options.bypassAllApprovals` is set (the `/yolo` command), any result
 * that would still prompt is turned into `allow` as a final step, EXCEPT a
 * critical one. A `deny` is a hard block, not a prompt, so it survives the
 * bypass unchanged.
 */
export function resolveApproval(
	tool: ApprovalSubject,
	args: unknown,
	mode: ApprovalMode,
	userConfig: Record<string, unknown> = {},
	options?: ApprovalResolutionOptions,
): ResolvedApproval {
	const resolved = resolveApprovalInner(tool, args, mode, userConfig, options);
	// A critical prompt is a floor, not a prompt the bypass may lift. `/yolo`
	// is a statement about routine friction, not consent to delete a home
	// directory unasked.
	if (options?.bypassAllApprovals && resolved.policy === "prompt" && !resolved.critical) {
		return { ...resolved, policy: "allow" };
	}
	return resolved;
}

function resolveApprovalInner(
	tool: ApprovalSubject,
	args: unknown,
	mode: ApprovalMode,
	userConfig: Record<string, unknown> = {},
	options?: ApprovalResolutionOptions,
): ResolvedApproval {
	const level = normalizeApprovalMode(mode);
	const decision = getToolDecision(tool, args);
	const userPolicy = Object.hasOwn(userConfig, tool.name) ? normalizePolicy(userConfig[tool.name]) : undefined;

	if (level === "yolo") {
		// A critical decision has a floor: yolo used to return here before ever
		// looking at `decision.override`, which inverted the severity ordering.
		// The most dangerous commands are the ones most likely to be run in the
		// mode that ignored the check, and every published home-directory wipe
		// happened in exactly that configuration. An explicit
		// `tools.approval.<tool>` still wins in both directions, so `allow` is
		// the escape hatch and `deny` is still a hard block.
		if (decision.critical && userPolicy === undefined) {
			return {
				policy: "prompt",
				tier: decision.tier,
				override: true,
				critical: true,
				...(decision.reason ? { reason: decision.reason } : {}),
			};
		}
		// A configured policy on a critical decision keeps the critical flag. The
		// flag is what the `/yolo` bypass reads to know which prompts it may lift,
		// so dropping it here made `tools.approval.<tool> = "prompt"` buy LESS
		// protection than configuring nothing at all: the unconfigured branch above
		// returns `critical: true` and survives the bypass, while a deliberately
		// requested prompt was silently turned into `allow`.
		return {
			policy: userPolicy ?? "allow",
			tier: decision.tier,
			override: false,
			...(decision.critical ? { critical: true } : {}),
		};
	}

	if (decision.override) {
		if (userPolicy === "deny") {
			return { policy: "deny", tier: decision.tier, override: true };
		}
		// `critical` has to travel with the result, not just be acted on above:
		// this is the branch the non-yolo modes take, and the `/yolo` bypass
		// reads the flag off the result to know which prompts it may lift.
		return {
			policy: "prompt",
			tier: decision.tier,
			override: true,
			...(decision.critical ? { critical: true } : {}),
			...(decision.reason ? { reason: decision.reason } : {}),
		};
	}

	// An ACTIVE plan-mode session is a cap, not a default, and the cap outranks a
	// per-tool `allow`. `resolveEffectiveApprovalMode` already forces the level to
	// `plan` while plan mode is active precisely so a configured `yolo` cannot beat
	// it; letting `tools.approval.bash = "allow"` through would reintroduce the same
	// escape one tool at a time, and "exec is blocked in plan mode" would hold only
	// for operators who never configured a tool. A `deny` is a hard block either
	// way, and a configured `plan` autonomy level with no active plan-mode session
	// keeps the documented precedence where the per-tool setting wins.
	const planCapBlocks = options?.planModeActive === true && planAutonomyBlocksMutation(level, decision.tier, options);
	if (userPolicy && !(planCapBlocks && userPolicy !== "deny")) {
		return { policy: userPolicy, tier: decision.tier, override: false };
	}

	if (planAutonomyBlocksMutation(level, decision.tier, options)) {
		return {
			policy: "deny",
			tier: decision.tier,
			override: false,
			reason: options?.planModeActive
				? "Plan mode: mutating tools are blocked (draft the plan via local:// plan files only)."
				: "Plan autonomy: non-mutating tools only (read/search/grep/lsp). Raise autonomy to ask or higher to mutate.",
		};
	}

	if (autonomyApprovesTier(level, decision.tier)) {
		return { policy: "allow", tier: decision.tier, override: false };
	}

	return {
		policy: "prompt",
		tier: decision.tier,
		override: false,
		...(decision.reason ? { reason: decision.reason } : {}),
	};
}

/**
 * Effective autonomy when plan-mode session is active: cap to `plan` unless CLI yolo.
 */
export function resolveEffectiveApprovalMode(
	configured: ApprovalMode | string | undefined,
	options?: { planModeActive?: boolean; cliAutoApprove?: boolean },
): ApprovalMode {
	if (options?.cliAutoApprove) return "yolo";
	if (options?.planModeActive) return "plan";
	return (configured ?? "yolo") as ApprovalMode;
}

/**
 * Check if a tool call requires user approval.
 *
 * @throws Error if policy is 'deny'
 * @returns Object with required flag and optional reason for the prompt
 */
export function requiresApproval(
	tool: ApprovalSubject,
	args: unknown,
	mode: ApprovalMode,
	userConfig: Record<string, unknown> = {},
	options?: ApprovalResolutionOptions,
): { required: boolean; reason?: string } {
	const { policy, reason } = resolveApproval(tool, args, mode, userConfig, options);

	if (policy === "deny") {
		const detail =
			reason ??
			`Tool "${tool.name}" is blocked by user policy.\n` +
				`To allow: remove "tools.approval.${tool.name}: deny" from config.`;
		throw new Error(detail);
	}

	if (policy === "prompt") return { required: true, reason };
	return { required: false };
}

export function truncateForPrompt(value: string, maxChars = DEFAULT_PROMPT_TRUNCATE_CHARS): string {
	if (value.length <= maxChars) return value;
	const omitted = value.length - maxChars;
	return `${value.slice(0, maxChars)}[…${omitted}ch elided…]`;
}

/**
 * Format the approval prompt body shown to the user.
 */
export function formatApprovalPrompt(tool: ApprovalSubject, args: unknown, reason?: string): string {
	const lines = [`Allow tool: ${tool.name}`];

	if (tool.name.startsWith("mcp__") && tool.approval === undefined) {
		lines.push("Origin: MCP server tool");
	}

	if (reason) {
		lines.push(`Reason: ${reason}`);
	}

	lines.push(...approvalDetailLines(tool, args));
	return lines.join("\n");
}

/** Format the richer interactive card without breaking prompt-text consumers. */
export function formatApprovalCard(tool: ApprovalSubject, args: unknown, reason?: string): string {
	const lines = ["## Permission required", `**Tool:** \`${tool.name}\``, "**Scope:** This call only"];

	if (tool.name.startsWith("mcp__") && tool.approval === undefined) {
		lines.push("**Origin:** MCP server tool");
	}

	if (reason) {
		lines.push(`**Reason:** ${reason}`);
	}

	const details = approvalDetailLines(tool, args);
	if (details.length > 0) {
		lines.push("", "**Requested action**", ...details);
	}
	return lines.join("\n");
}

function approvalDetailLines(tool: ApprovalSubject, args: unknown): string[] {
	const details = tool.formatApprovalDetails?.(args);
	if (typeof details === "string") return details.length > 0 ? [details] : [];
	if (Array.isArray(details)) return details.filter(detail => detail.length > 0);
	return [];
}
