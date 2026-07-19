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

export type { ToolApproval, ToolApprovalDecision, ToolTier } from "@veyyon/agent-core";

export type ApprovalPolicy = "allow" | "deny" | "prompt";

/** Shipped autonomy ladder (A2). Legacy omp names remain accepted in config/CLI. */
export type AutonomyLevel = "plan" | "ask" | "auto-edit" | "yolo";
export type LegacyApprovalMode = "always-ask" | "write";
export type ApprovalMode = AutonomyLevel | LegacyApprovalMode;

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

/** Map stored setting / CLI values to the shipped autonomy ladder. */
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
		default:
			return "yolo";
	}
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
		return {
			tier,
			override: record.override === true,
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
 *  2. User per-tool override, if set and valid.
 *  3. Active autonomy level tier comparison (`plan` denies mutations; `ask` prompts).
 *
 * In yolo mode, override-based tool prompts are ignored; user `tools.approval`
 * settings remain authoritative.
 *
 * When `options.bypassAllApprovals` is set (the `/yolo` command), any result
 * that would still prompt is turned into `allow` as a final step. A `deny` is a
 * hard block, not a prompt, so it survives the bypass unchanged.
 */
export function resolveApproval(
	tool: ApprovalSubject,
	args: unknown,
	mode: ApprovalMode,
	userConfig: Record<string, unknown> = {},
	options?: ApprovalResolutionOptions,
): ResolvedApproval {
	const resolved = resolveApprovalInner(tool, args, mode, userConfig, options);
	if (options?.bypassAllApprovals && resolved.policy === "prompt") {
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
		return { policy: userPolicy ?? "allow", tier: decision.tier, override: false };
	}

	if (decision.override) {
		if (userPolicy === "deny") {
			return { policy: "deny", tier: decision.tier, override: true };
		}
		return {
			policy: "prompt",
			tier: decision.tier,
			override: true,
			...(decision.reason ? { reason: decision.reason } : {}),
		};
	}

	if (userPolicy) {
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

	const details = tool.formatApprovalDetails?.(args);
	if (typeof details === "string") {
		if (details.length > 0) lines.push(details);
	} else if (Array.isArray(details)) {
		for (const detail of details) {
			if (detail.length > 0) lines.push(detail);
		}
	}

	return lines.join("\n");
}
