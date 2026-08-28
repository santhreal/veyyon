/** Tool approval resolution. Approval policy is declared by each tool. This module only knows how to: */

import type { AgentTool, ToolApprovalDecision, ToolTier } from "@veyyon/agent-core";
import { isRecord, truncate } from "@veyyon/utils";
import type { ApprovalMode, AutonomyLevel } from "./approval-modes";
import { APPROVAL_MODE_VALUES, DEFAULT_APPROVAL_MODE, isKnownApprovalMode } from "./approval-modes";

export type { ToolApproval, ToolApprovalDecision, ToolTier } from "@veyyon/agent-core";
// Re-export the zero-dependency mode set so tool code keeps one import site.
export {
	APPROVAL_MODE_VALUES,
	type ApprovalMode,
	type AutonomyLevel,
	DEFAULT_APPROVAL_MODE,
	isKnownApprovalMode,
	type LegacyApprovalMode,
} from "./approval-modes";

export type ApprovalPolicy = "allow" | "deny" | "prompt";

export interface ApprovalResolutionOptions {
	/** When plan-mode session is active, write-tier tools may run (plan-file guard at execute). */
	planModeActive?: boolean;
	/** Full bypass (the `/yolo` command): every approval that would prompt is allowed instead, including per-tool `prompt` overrides and a tool's own */
	bypassAllApprovals?: boolean;
}

type ApprovalSubject = Pick<AgentTool, "name" | "approval" | "formatApprovalDetails">;

export interface ResolvedApproval {
	policy: ApprovalPolicy;
	tier: ToolTier;
	reason?: string;
	override: boolean;
	/** True when the tool judged this specific call dangerous enough to prompt even in yolo. Carried on the result so the `/yolo` bypass can tell a */
	critical?: boolean;
}

/** Every value `tools.approval.<tool>` accepts, in one place. Exported because a policy is a security control and its member list is what a */
export const APPROVAL_POLICY_VALUES: readonly ApprovalPolicy[] = ["allow", "deny", "prompt"];

const POLICY_VALUES: ReadonlySet<ApprovalPolicy> = new Set(APPROVAL_POLICY_VALUES);
const TIER_VALUES: ReadonlySet<ToolTier> = new Set(["read", "write", "exec"]);

const TIER_RANK: Record<ToolTier, number> = {
	read: 0,
	write: 1,
	exec: 2,
};

/** The highest tier each rung runs unasked, or `"none"` for a rung that runs nothing unasked. */
const AUTONOMY_MAX_TIER: Record<AutonomyLevel, ToolTier | "none"> = {
	plan: "read",
	ask: "none",
	"ask-command": "write",
	auto: "exec",
	yolo: "exec",
};

const DEFAULT_PROMPT_TRUNCATE_CHARS = 2000;

/** The rung each ACCEPTED `tools.approvalMode` value maps to. Exhaustive over `ApprovalMode` on purpose: the accepted set */
const RUNG_BY_ACCEPTED_MODE: Record<ApprovalMode, AutonomyLevel> = {
	plan: "plan",
	ask: "ask",
	"ask-command": "ask-command",
	auto: "auto",
	yolo: "yolo",
	// `always-ask` named the ask rung before it did.
	"always-ask": "ask",
	// `auto-edit` and `write` named the same rung before it did: reads and
	// writes run, commands ask.
	write: "ask-command",
	"auto-edit": "ask-command",
};

/** Map a stored setting / CLI value to the shipped autonomy ladder. `undefined` (no configured mode) maps to `DEFAULT_APPROVAL_MODE`, the one */
export function normalizeApprovalMode(mode: string | undefined): AutonomyLevel {
	if (mode === undefined) return DEFAULT_APPROVAL_MODE;
	// Only a value OUTSIDE the accepted set may reach the fail-closed branch.
	// The mapping of every accepted value is exhaustive by construction (see
	// RUNG_BY_ACCEPTED_MODE), so a known value can never land here by drift.
	return isKnownApprovalMode(mode) ? RUNG_BY_ACCEPTED_MODE[mode] : "ask";
}

/** Validate a stored `tools.approvalMode` value. Returns a loud warning string when the value is a non-empty string that is not a recognized mode (so the */
export function validateApprovalModeSetting(configured: unknown): string | undefined {
	if (configured === undefined || configured === null) return undefined;
	if (isKnownApprovalMode(configured)) return undefined;
	return (
		`tools.approvalMode is set to an unrecognized value (${JSON.stringify(configured)}); ` +
		`falling back to "ask" (safe). Valid values: ${APPROVAL_MODE_VALUES.join(", ")}.`
	);
}

/** Convert a stored `tools.approval.<tool>` value to a policy. An ABSENT key is unconfigured and returns `undefined`, which is what lets the rung decide. */
function normalizePolicy(value: unknown): ApprovalPolicy | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") {
		const lowered = value.trim().toLowerCase();
		if (POLICY_VALUES.has(lowered as ApprovalPolicy)) return lowered as ApprovalPolicy;
	}
	return "deny";
}

/** Validate a stored `tools.approval` record, one diagnostic per malformed entry. Returns the warnings the caller surfaces at startup (`configWarnings`, and the log), so a */
export function validateApprovalPolicySettings(configured: unknown): string[] {
	if (configured === undefined || configured === null) return [];
	const allowed = `Valid values: ${[...POLICY_VALUES].join(", ")}.`;
	if (!isRecord(configured)) {
		return [
			`tools.approval is set to ${JSON.stringify(configured)}, which is not a per-tool record; ` +
				`every tool policy in it is ignored. Expected { "<tool>": "allow" | "deny" | "prompt" }.`,
		];
	}
	const warnings: string[] = [];
	for (const [tool, value] of Object.entries(configured)) {
		if (value === undefined) continue;
		if (typeof value === "string" && POLICY_VALUES.has(value.trim().toLowerCase() as ApprovalPolicy)) continue;
		warnings.push(
			`tools.approval.${tool} is set to an unrecognized value (${JSON.stringify(value)}); ` +
				`the tool is DENIED until it is fixed (fail closed). ${allowed}`,
		);
	}
	return warnings;
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
	const ceiling = AUTONOMY_MAX_TIER[level];
	return ceiling !== "none" && TIER_RANK[tier] <= TIER_RANK[ceiling];
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

/** Resolve approval policy for a tool call. Resolution order: */
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
		// A critical decision has a floor: yolo used to return here before ever looking at `decision.override`, which inverted the severity ordering.
		if (decision.critical && userPolicy === undefined) {
			return {
				policy: "prompt",
				tier: decision.tier,
				override: true,
				critical: true,
				...(decision.reason ? { reason: decision.reason } : {}),
			};
		}
		// A configured policy on a critical decision keeps the critical flag. The flag is what the `/yolo` bypass reads to know which prompts it may lift,
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

	// An ACTIVE plan-mode session is a cap, not a default, and the cap outranks a per-tool `allow`. `resolveEffectiveApprovalMode` already forces the level to
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

/** The rung actually in force, before any per-tool policy is consulted. `--yolo` / `--auto-approve` is an explicit operator instruction and wins */
export function resolveEffectiveApprovalMode(
	configured: ApprovalMode | string | undefined,
	options?: { planModeActive?: boolean; cliAutoApprove?: boolean },
): ApprovalMode {
	if (options?.cliAutoApprove) return "yolo";
	if (options?.planModeActive) return "plan";
	return (configured ?? DEFAULT_APPROVAL_MODE) as ApprovalMode;
}

/** Check if a tool call requires user approval. `critical` travels with the answer because it changes WHO may dismiss the */
export function requiresApproval(
	tool: ApprovalSubject,
	args: unknown,
	mode: ApprovalMode,
	userConfig: Record<string, unknown> = {},
	options?: ApprovalResolutionOptions,
): { required: boolean; reason?: string; critical?: boolean } {
	const { policy, reason, critical } = resolveApproval(tool, args, mode, userConfig, options);

	if (policy === "deny") {
		const detail =
			reason ??
			`Tool "${tool.name}" is blocked by user policy.\n` +
				`To allow: remove "tools.approval.${tool.name}: deny" from config.`;
		throw new Error(detail);
	}

	if (policy === "prompt") return { required: true, reason, critical };
	return { required: false };
}

export function truncateForPrompt(value: string, maxChars = DEFAULT_PROMPT_TRUNCATE_CHARS): string {
	if (value.length <= maxChars) return value;
	const chars = [...value];
	if (chars.length <= maxChars) return value;
	return `${truncate(value, maxChars, "")}[…${chars.length - maxChars}ch elided…]`;
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

	const al = approvalDetailLines(tool, args);
	for (let li = 0; li < al.length; li++) lines.push(al[li]!);
	return lines.join("\n");
}

/** Format the richer interactive card without breaking prompt-text consumers. `requester` names the agent the call belongs to, and is set only for a spawned */
export function formatApprovalCard(tool: ApprovalSubject, args: unknown, reason?: string, requester?: string): string {
	const lines = ["## Permission required", `**Tool:** \`${tool.name}\``];
	if (requester) lines.push(`**Requested by:** \`${requester}\``);
	lines.push("**Scope:** This call only");

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
