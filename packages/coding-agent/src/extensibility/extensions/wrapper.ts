/**
 * Tool wrappers for extensions.
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { ImageContent, Static, TextContent, TSchema } from "@veyyon/ai";
import { isCancellation } from "@veyyon/utils";
import type { Settings } from "../../config/settings";
import type { Theme } from "../../modes/theme/theme";
import { AgentRegistry } from "../../registry/agent-registry";
import {
	type ApprovalMode,
	formatApprovalCard,
	requiresApproval,
	resolveEffectiveApprovalMode,
} from "../../tools/approval";
import { cwdEscapingTargets, formatCwdBoundaryReason } from "../../tools/cwd-boundary";
import { secretUseApprovalReason } from "../../tools/secret-use-boundary";
import { normalizeToolEventInput, resolveToolEventInput } from "../tool-event-input";
import { applyToolProxy } from "../tool-proxy";
import type { ExtensionRunner } from "./runner";
import type {
	ExtensionUIDialogOptions,
	ExtensionUISelectOption,
	RegisteredTool,
	ToolCallEventResult,
	ToolRenderResultOptions,
} from "./types";

/**
 * The four row labels, named ONCE.
 *
 * The dialog returns the selected row's label as a bare string, and `execute`
 * decides what happened by comparing it. Those comparisons used to be four more
 * literals restating this list, so renaming a row here without editing all four
 * turned that row into a silent denial: the operator picks "Approve", the
 * comparison misses, and the call is refused with "denied by user". Nothing on
 * screen would say the two lists had drifted.
 */
const APPROVAL_CHOICE = {
	approveOnce: "Approve",
	approveSession: "Approve for session",
	denyOnce: "Deny",
	denySession: "Deny for session",
} as const;

/**
 * The choices offered at an interactive one-call approval.
 *
 * The two "for this session" rows are what make the `ask` and `ask-command`
 * rungs usable rather than merely safe. A run that edits twenty files asks
 * twenty times without them, and an operator who has to answer that many
 * identical prompts turns approvals off entirely, so a dialog with no memory is
 * not a stricter product, it is the same yolo reached by a worse road.
 *
 * The memory is SESSION-scoped and never written to settings. A standing grant
 * in `tools.approval` outlives the task it was granted for and is invisible the
 * next time you launch; this one dies with the session, so tomorrow asks again.
 * Writing a permanent policy stays an explicit act in `/settings`.
 */
export const APPROVAL_SELECT_OPTIONS: ExtensionUISelectOption[] = [
	{ label: APPROVAL_CHOICE.approveOnce, description: "Run this call once. Nothing is remembered." },
	{
		label: APPROVAL_CHOICE.approveSession,
		description: "Run this and every later call to this tool, until you exit.",
	},
	{ label: APPROVAL_CHOICE.denyOnce, description: "Do not run this call." },
	{
		label: APPROVAL_CHOICE.denySession,
		description: "Refuse this and every later call to this tool, until you exit.",
	},
];
export const APPROVAL_DIALOG_OPTIONS: ExtensionUIDialogOptions = {
	selectionMarker: "radio",
	helpText: "↑/↓ navigate  enter confirm  esc cancel",
};

/**
 * Adapts a RegisteredTool into an AgentTool.
 */
export class RegisteredToolAdapter implements AgentTool<TSchema, unknown, unknown> {
	declare name: string;
	declare description: string;
	declare parameters: TSchema;
	declare label: string;
	declare strict: boolean;

	// `theme` stays unknown to satisfy the default AgentTool TTheme; the
	// constructor narrows it once when bridging to the definition's Theme.
	renderCall?: (args: Static<TSchema>, options: ToolRenderResultOptions, theme: unknown) => unknown;
	renderResult?: (
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: unknown,
		args?: Static<TSchema>,
	) => unknown;

	constructor(
		private registeredTool: RegisteredTool,
		private runner: ExtensionRunner,
	) {
		applyToolProxy(registeredTool.definition, this);

		// Only define render methods when the underlying definition provides them.
		// If these exist unconditionally on the prototype, ToolExecutionComponent
		// enters the custom-renderer path, gets undefined back, and silently
		// discards tool result text (extensions without renderers show blank).
		if (registeredTool.definition.renderCall) {
			this.renderCall = (args, options, theme) =>
				registeredTool.definition.renderCall!(args, options, theme as Theme);
		}
		if (registeredTool.definition.renderResult) {
			this.renderResult = (result, options, theme, args) =>
				registeredTool.definition.renderResult!(
					result,
					{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
					theme as Theme,
					args,
				);
		}
	}

	async execute(
		toolCallId: string,
		params: Static<TSchema>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
		_context?: AgentToolContext,
	) {
		return this.registeredTool.definition.execute(toolCallId, params, signal, onUpdate, this.runner.createContext());
	}
}

/**
 * Backward-compatible factory function wrapper.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	return new RegisteredToolAdapter(registeredTool, runner);
}

/**
 * Wrap all registered tools into AgentTools.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map(rt => wrapRegisteredTool(rt, runner));
}

/**
 * Wraps a tool with extension callbacks for interception.
 * - Emits tool_call event before execution (can block)
 * - Emits tool_result event after execution (can modify result)
 */
export class ExtensionToolWrapper<TParameters extends TSchema = TSchema, TDetails = unknown>
	implements AgentTool<TParameters, TDetails>
{
	declare name: string;
	declare description: string;
	declare parameters: TParameters;
	declare label: string;
	declare strict: boolean;

	constructor(
		private tool: AgentTool<TParameters, TDetails>,
		private runner: ExtensionRunner,
	) {
		applyToolProxy(tool, this);
	}

	/**
	 * Forward browser mode changes when available.
	 */
	restartForModeChange(): Promise<void> {
		const target = this.tool as { restartForModeChange?: () => Promise<void> };
		if (!target.restartForModeChange) return Promise.resolve();
		return target.restartForModeChange();
	}

	async execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<TDetails, TParameters>> {
		// 1. Check approval policy (before extension handlers).
		// CLI `--auto-approve` / `--yolo` sets approval mode to yolo.
		// User `tools.approval.<tool>` policies are still applied in all modes.
		const cliAutoApprove = context?.autoApprove === true;
		const settings: Settings | undefined = context?.settings;
		// No fallback spelled here. An absent `Settings` means nothing is
		// configured, and `resolveEffectiveApprovalMode` decides that case from
		// `DEFAULT_APPROVAL_MODE`, the schema's own default. A literal here would
		// be a second source of truth: a `yolo` one used to silently outrank a
		// missing setting, which is how an approval system nobody had configured
		// became an approval system that never fired.
		const configuredMode = settings?.get("tools.approvalMode") as ApprovalMode | undefined;
		const planModeActive = context?.planModeActive === true;
		const bypassAllApprovals = context?.bypassAllApprovals === true;
		const approvalMode = resolveEffectiveApprovalMode(configuredMode, { planModeActive, cliAutoApprove });
		const userPolicies = (settings?.get("tools.approval") ?? {}) as Record<string, unknown>;
		const approvalCheck = requiresApproval(this.tool, params, approvalMode, userPolicies, {
			planModeActive,
			bypassAllApprovals,
		});

		// Filesystem cwd boundary: a read/write whose target escapes the session
		// working directory requires explicit permission in every non-yolo mode.
		// yolo (autonomy or the `/yolo` bypass) opts out of all permission, so it
		// opts out of this too. The read/write *tier* auto-approves by tier alone
		// and never inspects the path, so this is the only place out-of-cwd access
		// is gated. See cwd-boundary.ts. A `deny` already threw above, so this only
		// adds a prompt; it never downgrades a denial.
		const boundaryTargets =
			approvalMode === "yolo" || bypassAllApprovals
				? []
				: cwdEscapingTargets(this.tool, params, context?.sessionManager?.getCwd?.() ?? "");
		const boundaryReason =
			boundaryTargets.length > 0
				? formatCwdBoundaryReason(context?.sessionManager?.getCwd?.() ?? "", boundaryTargets)
				: undefined;
		// Secret-use boundary: a call whose arguments carry a real credential needs
		// explicit permission in every non-yolo mode, by the same rule as the cwd
		// boundary above. The tier decides what kind of tool this is and never what
		// the arguments contain, so without this a `bash` that spends a stored token
		// was indistinguishable from one that lists a directory. Expansion was
		// audited and never gated, so the log could say afterwards which credential
		// was spent and nothing could ask first. See secret-use-boundary.ts.
		const secretReason =
			approvalMode === "yolo" || bypassAllApprovals ? undefined : secretUseApprovalReason(params, context);
		const approvalRequired = approvalCheck.required || boundaryReason !== undefined || secretReason !== undefined;
		const approvalReason =
			[approvalCheck.reason, boundaryReason, secretReason]
				.filter((part): part is string => part !== undefined)
				.join(" ") || undefined;

		// A standing answer the operator already gave at this dialog, this session.
		//
		// IT IS AN ANSWER ABOUT A TOOL NAME, so it may only retire a prompt that
		// was raised about the tool name: the ordinary tier/policy one. Three
		// prompts are raised about these ARGUMENTS instead, and no answer given on
		// an earlier call can have been about them:
		//
		//   - `critical`: the bash guard judged THIS command destructive.
		//   - the cwd boundary: THIS path leaves the working directory.
		//   - the secret-use boundary: THESE arguments spend a stored credential.
		//
		// Without this bound the grant defeated all three. Measured: rung `ask`,
		// `bash ls`, answer "Approve for session", then `bash rm -rf $HOME` ran
		// with no prompt at all — including under `yolo`, whose critical floor
		// exists because "every published home-directory wipe happened in exactly
		// that configuration". The dialog says "Run this and every later call to
		// this tool"; an operator reading that has not consented to a later call
		// that wipes their home directory, and the card they read it on says the
		// scope is this call only.
		//
		// A `deny` grant is not bounded the same way. It only ever refuses more,
		// so applying it everywhere is the safe direction.
		const sessionApprovals = context?.sessionApprovals;
		const grantMayApply =
			approvalCheck.critical !== true && boundaryReason === undefined && secretReason === undefined;
		const standing = approvalRequired ? sessionApprovals?.get(this.tool.name) : undefined;
		if (standing === "deny") {
			throw new Error(`Tool call denied for this session: ${this.tool.name}`);
		}

		if (approvalRequired && !(standing === "allow" && grantMayApply)) {
			const hasApprovalHandlers =
				this.runner.hasHandlers("tool_approval_requested") || this.runner.hasHandlers("tool_approval_resolved");
			const sessionId = context?.sessionManager?.getSessionId() ?? "";
			if (hasApprovalHandlers) {
				await this.runner.emit({
					type: "tool_approval_requested",
					sessionId,
					toolName: this.tool.name,
					toolCallId,
					...(approvalReason ? { reason: approvalReason } : {}),
					approvalMode,
				});
			}

			const resolveApproval = async (approved: boolean, reason?: string) => {
				if (!hasApprovalHandlers) return;
				await this.runner.emit({
					type: "tool_approval_resolved",
					sessionId,
					toolName: this.tool.name,
					toolCallId,
					approved,
					...(reason ? { reason } : {}),
				});
			};

			// The agent this call belongs to, when it is a spawned subagent. Both
			// the byline on the card and the observable waiting state below are
			// keyed off it, and a root session has neither.
			const requester = this.runner.agentId;

			// Check if UI is available
			if (!this.runner.hasUI()) {
				const reason = "no interactive UI available";
				await resolveApproval(false, reason);
				// Lead with the specific reason (e.g. the cwd-boundary path) so a
				// headless run reports WHY it was blocked, not only that a prompt was
				// needed.
				//
				// A subagent reaches here only when the ROOT session has no UI either,
				// because the spawner hands the root's surface down (see
				// `resolveRootUIContext` in `task/executor.ts`). So the refusal has to
				// read as a decision about the run's configuration rather than as a
				// crash inside the child: this text is the entire explanation the
				// child's tool result carries, and the operator sees it attributed to
				// the child with no card ever having been drawn.
				const detail = approvalReason ? `${approvalReason}\n` : "";
				const forAgent = requester ? ` (requested by ${requester})` : "";
				throw new Error(
					`${detail}Tool "${this.tool.name}"${forAgent} requires approval but no interactive UI available.\n` +
						`Options:\n` +
						`  1. Raise tools.approvalMode (ask-command / auto / yolo) in /settings, or pass --approval-mode\n` +
						`  2. Add tools.approval.${this.tool.name}: allow to config\n` +
						`  3. Use an interactive UI to approve the tool call`,
				);
			}

			const uiContext = this.runner.getUIContext();
			const registry = AgentRegistry.global();
			let choice: string | undefined;
			// Observable waiting state, published for the whole process rather than
			// kept as a private boolean here. A blocked agent's status is `running`
			// (it is mid-turn), so nothing downstream can otherwise tell an agent
			// stopped at a prompt from an agent grinding through a build: the runtime
			// budget charges it the operator's reading time and the dashboard renders
			// it as busy. Set immediately before the await and cleared in the
			// `finally` that also covers the throw, so no abort, refusal or dialog
			// error can leave it stuck on.
			if (requester) {
				registry.setPendingApproval(requester, {
					toolName: this.tool.name,
					...(approvalReason ? { reason: approvalReason } : {}),
					since: Date.now(),
				});
			}
			try {
				choice = await uiContext.select(
					formatApprovalCard(this.tool, params, approvalReason, requester),
					APPROVAL_SELECT_OPTIONS,
					APPROVAL_DIALOG_OPTIONS,
				);
			} catch (err) {
				await resolveApproval(false, err instanceof Error ? err.message : "approval aborted");
				throw err;
			} finally {
				if (requester) registry.setPendingApproval(requester, undefined);
			}
			const approved = choice === APPROVAL_CHOICE.approveOnce || choice === APPROVAL_CHOICE.approveSession;
			// Record a grant only from an ordinary prompt. A critical or boundary
			// prompt is about THESE arguments, so "for session" answered there says
			// nothing about the tool in general, and storing it would put a
			// tool-wide allow on the books off the back of the scariest card the
			// operator ever sees. The call itself still proceeds; nothing is
			// remembered.
			if (grantMayApply) {
				if (choice === APPROVAL_CHOICE.approveSession) sessionApprovals?.set(this.tool.name, "allow");
				else if (choice === APPROVAL_CHOICE.denySession) sessionApprovals?.set(this.tool.name, "deny");
			}
			await resolveApproval(approved, approved ? undefined : "denied by user");
			if (!approved) {
				throw new Error(`Tool call denied by user: ${this.tool.name}`);
			}
		}

		// 2. Emit tool_call event - extensions can block execution
		if (this.runner.hasHandlers("tool_call")) {
			try {
				const callResult = (await this.runner.emitToolCall({
					type: "tool_call",
					toolName: this.tool.name,
					toolCallId,
					input: normalizeToolEventInput(
						this.tool.name,
						resolveToolEventInput(this.tool, params as Record<string, unknown>),
					),
				})) as ToolCallEventResult | undefined;

				if (callResult?.block) {
					const reason = callResult.reason || "Tool execution was blocked by an extension";
					throw new Error(reason);
				}
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		}

		// Execute the actual tool
		let result: { content: AgentToolResult<TDetails, TParameters>["content"]; details?: TDetails };
		let executionError: Error | undefined;

		try {
			result = await this.tool.execute(toolCallId, params, signal, onUpdate, context);
		} catch (err) {
			// A CANCELLATION IS NOT A FAILED CALL, so it never becomes one here. The
			// `tool_result` path below deliberately turns a thrown error into a
			// resolved `isError: true` result when a handler returns replacement
			// content, which is right for a tool that failed and wrong for a tool the
			// operator stopped: it swallows the abort, so the agent loop reads a
			// retryable failure and re-issues the very work the user cancelled. There
			// is also nothing for a handler to usefully rewrite, since the "content"
			// of a cancelled call is the fact that it did not happen.
			// `isCancellation`, so a deadline is not swallowed either. Both mean the
			// call did not happen, and turning either into a result the handlers can
			// rewrite invites the agent loop to re-issue the work.
			if (isCancellation(err)) throw err;
			executionError = err instanceof Error ? err : new Error(String(err));
			result = {
				content: [{ type: "text", text: executionError.message }],
				details: undefined as TDetails,
			};
		}

		// Emit tool_result event - extensions can modify the result and error status
		if (this.runner.hasHandlers("tool_result")) {
			const resultResult = await this.runner.emitToolResult({
				type: "tool_result",
				toolName: this.tool.name,
				toolCallId,
				input: normalizeToolEventInput(
					this.tool.name,
					resolveToolEventInput(this.tool, params as Record<string, unknown>),
				),
				content: result.content,
				details: result.details,
				isError: !!executionError,
			});

			if (resultResult) {
				const modifiedContent: (TextContent | ImageContent)[] = resultResult.content ?? result.content;
				const modifiedDetails = (resultResult.details ?? result.details) as TDetails;

				// Effective error state: an explicit handler override wins; otherwise the
				// original execution outcome stands. This lets a handler rewrite a failed
				// call's model-visible content/details while keeping it an error, flip a
				// failure to success, or flag a success as an error.
				const effectiveError = resultResult.isError ?? !!executionError;

				// Return the (possibly modified) result carrying the error flag rather than
				// rethrowing the original exception. The agent loop honors
				// `AgentToolResult.isError` and surfaces it as a tool error on the wire (see
				// `coerceToolResult` in agent-loop), so replacement failure content reaches
				// the model while the call remains an error — the original exception text is
				// no longer forced through, which previously discarded the replacement.
				return {
					content: modifiedContent,
					details: modifiedDetails,
					...(effectiveError ? { isError: true } : {}),
				};
			}
		}

		// No extension modification
		if (executionError) {
			throw executionError;
		}
		return result;
	}
}
