/**
 * What one tool call's permission prompt is about, and which answers it offers.
 *
 * A call raises zero or more CONCERNS, each in one {@link ApprovalCategory}: the tool's tier
 * prompted (`command`, `edit`, `read`), the tool judged these arguments destructive, a path leaves
 * the working directory, or the arguments spend a stored secret. The prompt is the highest-ranked
 * open concern, and that category selects the answers the prompt offers and what a "for session"
 * answer remembers:
 *
 *   - a tier prompt remembers the TOOL NAME (or the pattern the tool reported);
 *   - a secret prompt remembers the SECRET NAMES, whatever tool spends them next;
 *   - a destructive or outside-the-directory prompt remembers nothing: it is about these
 *     arguments, and no earlier answer can have been about them.
 *
 * Every other concern open on the same card is answered for this call only. A standing answer
 * retires a concern only in its own category, so "allow bash for the session" never lets a later
 * `bash` spend a credential unasked, and "allow GITHUB_TOKEN" never runs a destructive command.
 *
 * This module holds no UI and no runner. `extensions/wrapper.ts` raises the prompt it describes.
 */
import type { AgentTool, AgentToolContext } from "@veyyon/agent-core";
import type { TSchema } from "@veyyon/ai";
import type { Settings } from "../../config/settings";
import { type ApprovalMode, requiresApproval, resolveEffectiveApprovalMode, type ToolTier } from "./approval";
import { patternGrantKey, type SessionToolApprovals } from "./approval-modes";
import { cwdEscapingTargets, formatCwdBoundaryReason } from "./cwd-boundary";
import { secretUse } from "./secret-use-boundary";

/** What a permission prompt asks about. */
export type ApprovalCategory = "destructive" | "secret" | "outside" | "command" | "edit" | "read";

/** Every category, highest rank first: a card leads with the first one it carries. */
export const APPROVAL_CATEGORIES: readonly ApprovalCategory[] = [
	"destructive",
	"secret",
	"outside",
	"command",
	"edit",
	"read",
];

/** The category of a prompt raised by the tool's tier or a `tools.approval` policy. */
const TIER_CATEGORY: Record<ToolTier, ApprovalCategory> = { exec: "command", write: "edit", read: "read" };

/**
 * How a standing session answer retires a concern of each category: `any` of its keys allowed,
 * `every` one of them allowed, or `never`. `every` over no keys retires nothing, so a secret with
 * no name (an unnamed value, a `replace`-mode value, uninspectable arguments) always asks.
 *
 * `never` is the bound that keeps a tool-wide grant from answering a question nobody asked. Before
 * it, rung `ask`, `bash ls` answered "Approve for session", then `bash rm -rf $HOME` ran with no
 * prompt at all, under `yolo` too, whose critical floor exists for exactly that command.
 */
const RETIRED_BY: Record<ApprovalCategory, "any" | "every" | "never"> = {
	destructive: "never",
	secret: "every",
	outside: "never",
	command: "any",
	edit: "any",
	read: "any",
};

/** One reason a call prompts. */
export interface ApprovalConcern {
	category: ApprovalCategory;
	/** Why, in one or two sentences. Never contains a secret value. */
	text: string;
	/** The session-store keys a standing answer about this concern is recorded under. */
	keys: readonly string[];
	/** What a "for session" answer covers, for the row label: the tool name or the secret names. */
	scope?: string;
}

/** What one call needs from the approval policy, resolved before any prompt is raised. */
export interface ApprovalGate {
	toolName: string;
	mode: ApprovalMode;
	/** Every concern the call raises, highest rank first; empty when it runs unasked. */
	concerns: readonly ApprovalConcern[];
	/** The pattern the tool reported for a pattern-scoped grant, on a plain tier prompt only. */
	pattern: string | undefined;
}

/** The session-store key for a standing answer about one stored secret. */
export function secretGrantKey(name: string): string {
	// NUL cannot occur in a tool name, so no secret key equals a tool key or a pattern key.
	return `\u0000secret\u0000${name}`;
}

/** Resolve the approval mode, the policy prompt and every argument boundary for one call. */
export function resolveApprovalGate<TParameters extends TSchema, TDetails>(
	tool: AgentTool<TParameters, TDetails>,
	params: unknown,
	context: AgentToolContext | undefined,
): ApprovalGate {
	// CLI `--auto-approve` / `--yolo` sets approval mode to yolo.
	// User `tools.approval.<tool>` policies are still applied in all modes.
	const settings: Settings | undefined = context?.settings;
	// No fallback spelled here. An absent `Settings` means nothing is configured, and
	// `resolveEffectiveApprovalMode` decides that case from `DEFAULT_APPROVAL_MODE`, the schema's
	// own default. A literal here would be a second source of truth: a `yolo` one used to silently
	// outrank a missing setting, which is how an approval system nobody had configured became an
	// approval system that never fired.
	const planModeActive = context?.planModeActive === true;
	const bypassAllApprovals = context?.bypassAllApprovals === true;
	const mode = resolveEffectiveApprovalMode(settings?.get("tools.approvalMode"), {
		planModeActive,
		cliAutoApprove: context?.autoApprove === true,
	});
	const userPolicies = (settings?.get("tools.approval") ?? {}) as Record<string, unknown>;
	// A `deny` throws here, before any boundary is read, so a boundary only ever adds a prompt.
	const check = requiresApproval(tool, params, mode, userPolicies, { planModeActive, bypassAllApprovals });

	const concerns: ApprovalConcern[] = [];
	if (check.required) {
		const category = check.critical ? "destructive" : TIER_CATEGORY[check.tier];
		const pattern = check.critical ? undefined : check.pattern;
		concerns.push({
			category,
			text: check.reason ?? "",
			keys:
				category === "destructive"
					? []
					: [tool.name, ...(pattern === undefined ? [] : [patternGrantKey(tool.name, pattern)])],
			...(category === "destructive" ? {} : { scope: tool.name }),
		});
	}

	// yolo (autonomy or the `/yolo` bypass) opts out of all permission, so it opts out of both
	// argument boundaries. The read/write tier approves by tier alone and never inspects a path or a
	// value, so these are the only places an out-of-cwd path or a spent credential is asked about.
	const unbounded = mode === "yolo" || bypassAllApprovals;
	if (!unbounded) {
		const cwd = context?.sessionManager?.getCwd?.() ?? "";
		const escaping = cwdEscapingTargets(tool, params, cwd);
		if (escaping.length > 0) {
			concerns.push({ category: "outside", text: formatCwdBoundaryReason(cwd, escaping), keys: [] });
		}
		// `secrets.askBeforeUse: false` lets an agent spend a stored secret unasked; audit logging is
		// unaffected. An absent setting asks, the schema default.
		if (settings?.get("secrets.askBeforeUse") !== false) {
			const spent = secretUse(params, context);
			if (spent !== undefined) {
				const named = spent.named && spent.names.length > 0;
				concerns.push({
					category: "secret",
					text: spent.reason,
					keys: named ? spent.names.map(secretGrantKey) : [],
					...(named ? { scope: spent.names.join(", ") } : {}),
				});
			}
		}
	}

	concerns.sort((a, b) => APPROVAL_CATEGORIES.indexOf(a.category) - APPROVAL_CATEGORIES.indexOf(b.category));
	// A pattern grant is offered only when the tier prompt would lead the card alone: the resolver
	// reports a pattern only for a plain prompt, and an argument-scoped concern beside it is about
	// something the pattern does not describe.
	const pattern = concerns.length === 1 && concerns[0]!.category !== "destructive" ? check.pattern : undefined;
	return { toolName: tool.name, mode, concerns, pattern };
}

/** Whether a standing session answer retires `concern`. */
function retired(concern: ApprovalConcern, approvals: SessionToolApprovals | undefined): boolean {
	const allowed = (key: string): boolean => approvals?.get(key) === "allow";
	switch (RETIRED_BY[concern.category]) {
		case "any":
			return concern.keys.some(allowed);
		case "every":
			return concern.keys.length > 0 && concern.keys.every(allowed);
		case "never":
			return false;
	}
}

/** The concerns no standing session answer retires, highest rank first. */
export function openConcerns(
	gate: ApprovalGate,
	approvals: SessionToolApprovals | undefined,
): readonly ApprovalConcern[] {
	return gate.concerns.filter(concern => !retired(concern, approvals));
}

/**
 * The standing session refusal that blocks this call, as the error it throws, or undefined.
 *
 * A refusal only ever refuses more, so it is not bounded by category the way a grant is: a tool
 * refused for the session stays refused whatever else the call raises, and a refused secret is
 * refused whichever tool spends it.
 */
export function standingRefusal(gate: ApprovalGate, approvals: SessionToolApprovals | undefined): Error | undefined {
	if (gate.concerns.length === 0 || approvals === undefined) return undefined;
	if (approvals.get(gate.toolName) === "deny") {
		return new Error(`Tool call denied for this session: ${gate.toolName}`);
	}
	for (const concern of gate.concerns) {
		if (concern.category !== "secret") continue;
		const refused = concern.keys.filter(key => approvals.get(key) === "deny");
		if (refused.length > 0) {
			return new Error(`Tool call denied for this session: ${gate.toolName} spends ${concern.scope}`);
		}
	}
	return undefined;
}

/** What one answer at a permission prompt does. */
export type ApprovalChoiceId = "once" | "pattern" | "session" | "deny" | "never";

/** One row a permission prompt offers. */
export interface ApprovalChoice {
	id: ApprovalChoiceId;
	/** The select label the dialog returns; unique within one prompt. */
	label: string;
	description: string;
	allow: boolean;
	/** What a session answer covers: the tool name, the pattern, or the secret names. */
	scope?: string;
	/** The session-store keys this answer records, with the decision it records. */
	records: readonly string[];
}

/** One prompt: the category it leads with, every open concern on it, and the answers it offers. */
export interface ApprovalPrompt {
	category: ApprovalCategory;
	concerns: readonly ApprovalConcern[];
	/** Every open concern's text, joined. */
	reason: string | undefined;
	choices: readonly ApprovalChoice[];
}

/**
 * The prompt for `open`, the concerns still open on this call. The answers depend on the lead
 * category alone; every other open concern is approved for this call only.
 *
 * The approve rows come first and stay adjacent, so the destructive row is never the one under
 * the cursor by accident, and "for session" rows are offered only where the lead concern has keys
 * to record them under: a row that records nothing would read as a grant it is not.
 */
export function approvalPrompt(gate: ApprovalGate, open: readonly ApprovalConcern[]): ApprovalPrompt {
	const lead = open[0];
	if (lead === undefined) throw new Error(`No open approval concern for ${gate.toolName}`);
	// Only a tier or a named secret concern has keys and a scope; the rest are about these arguments.
	const remembers = lead.keys.length > 0 && lead.scope !== undefined;
	const secret = lead.category === "secret";
	const subject = secret ? "call that spends" : "call to";
	const choices: ApprovalChoice[] = [
		{
			id: "once",
			label: "Approve",
			description: "Run this call once. Nothing is remembered.",
			allow: true,
			records: [],
		},
	];
	// `gate.pattern` is set only when a plain tier prompt is the call's one concern.
	if (gate.pattern !== undefined) {
		choices.push({
			id: "pattern",
			label: `Approve "${gate.pattern}" for session`,
			description: "Run this and every later call with this same pattern, until you exit.",
			allow: true,
			scope: gate.pattern,
			records: [patternGrantKey(gate.toolName, gate.pattern)],
		});
	}
	// Tier prompts record the tool name only, never the pattern key the concern also matches.
	const sessionKeys = secret ? lead.keys : [gate.toolName];
	if (remembers) {
		choices.push({
			id: "session",
			label: secret ? `Approve ${lead.scope} for session` : "Approve for session",
			description: `Run this and every later ${subject} ${lead.scope}, until you exit.`,
			allow: true,
			scope: lead.scope,
			records: sessionKeys,
		});
	}
	choices.push({ id: "deny", label: "Deny", description: "Do not run this call.", allow: false, records: [] });
	if (remembers) {
		choices.push({
			id: "never",
			label: secret ? `Deny ${lead.scope} for session` : "Deny for session",
			description: `Refuse this and every later ${subject} ${lead.scope}, until you exit.`,
			allow: false,
			scope: lead.scope,
			records: sessionKeys,
		});
	}
	const reason = open
		.map(concern => concern.text)
		.filter(text => text.length > 0)
		.join(" ");
	return { category: lead.category, concerns: open, reason: reason || undefined, choices };
}

/** Record the standing answer `choice` gives, if it gives one. */
export function recordAnswer(choice: ApprovalChoice, approvals: SessionToolApprovals | undefined): void {
	for (const key of choice.records) approvals?.set(key, choice.allow ? "allow" : "deny");
}
