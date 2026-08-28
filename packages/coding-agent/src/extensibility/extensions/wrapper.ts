import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { ImageContent, Static, TextContent, TSchema } from "@veyyon/ai";
import { errorMessage, isCancellation, toError } from "@veyyon/utils";
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

const APPROVAL_CHOICE = {
	approveOnce: "Approve",
	approveSession: "Approve for session",
	denyOnce: "Deny",
	denySession: "Deny for session",
} as const;

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

const IN_FLIGHT_APPROVALS = new Map<string, Promise<void>>();

export class RegisteredToolAdapter implements AgentTool<TSchema, unknown, unknown> {
	declare name: string;
	declare description: string;
	declare parameters: TSchema;
	declare label: string;
	declare strict: boolean;

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

export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	return new RegisteredToolAdapter(registeredTool, runner);
}

export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map(rt => wrapRegisteredTool(rt, runner));
}

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
		const cliAutoApprove = context?.autoApprove === true;
		const settings: Settings | undefined = context?.settings;
		const configuredMode = settings?.get("tools.approvalMode") as ApprovalMode | undefined;
		const planModeActive = context?.planModeActive === true;
		const bypassAllApprovals = context?.bypassAllApprovals === true;
		const approvalMode = resolveEffectiveApprovalMode(configuredMode, { planModeActive, cliAutoApprove });
		const userPolicies = (settings?.get("tools.approval") ?? {}) as Record<string, unknown>;
		const approvalCheck = requiresApproval(this.tool, params, approvalMode, userPolicies, {
			planModeActive,
			bypassAllApprovals,
		});

		const boundaryTargets =
			approvalMode === "yolo" || bypassAllApprovals
				? []
				: cwdEscapingTargets(this.tool, params, context?.sessionManager?.getCwd?.() ?? "");
		const boundaryReason =
			boundaryTargets.length > 0
				? formatCwdBoundaryReason(context?.sessionManager?.getCwd?.() ?? "", boundaryTargets)
				: undefined;
		const secretReason =
			approvalMode === "yolo" || bypassAllApprovals ? undefined : secretUseApprovalReason(params, context);
		const approvalRequired = approvalCheck.required || boundaryReason !== undefined || secretReason !== undefined;
		const approvalReason =
			[approvalCheck.reason, boundaryReason, secretReason]
				.filter((part): part is string => part !== undefined)
				.join(" ") || undefined;

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

			const requester = this.runner.agentId;

			if (!this.runner.hasUI()) {
				const reason = "no interactive UI available";
				await resolveApproval(false, reason);
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
			if (requester) {
				registry.setPendingApproval(requester, {
					toolName: this.tool.name,
					...(approvalReason ? { reason: approvalReason } : {}),
					since: Date.now(),
				});
			}
			const inFlightKey = sessionId ? `${sessionId}\u0000${this.tool.name}` : undefined;
			let dismissedByGrant = false;
			while (inFlightKey && !dismissedByGrant) {
				const pending = IN_FLIGHT_APPROVALS.get(inFlightKey);
				if (!pending) break;
				await pending;
				const settledStanding = sessionApprovals?.get(this.tool.name);
				if (settledStanding === "deny") {
					await resolveApproval(false, "denied for this session");
					throw new Error(`Tool call denied for this session: ${this.tool.name}`);
				}
				if (settledStanding === "allow" && grantMayApply) dismissedByGrant = true;
			}

			if (!dismissedByGrant) {
				const { promise: promptSettled, resolve: releaseWaiters } = Promise.withResolvers<void>();
				if (inFlightKey) IN_FLIGHT_APPROVALS.set(inFlightKey, promptSettled);
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
					if (grantMayApply) {
						if (choice === APPROVAL_CHOICE.approveSession) sessionApprovals?.set(this.tool.name, "allow");
						else if (choice === APPROVAL_CHOICE.denySession) sessionApprovals?.set(this.tool.name, "deny");
					}
					if (inFlightKey) IN_FLIGHT_APPROVALS.delete(inFlightKey);
					releaseWaiters();
				}
				const approved = choice === APPROVAL_CHOICE.approveOnce || choice === APPROVAL_CHOICE.approveSession;
				await resolveApproval(approved, approved ? undefined : "denied by user");
				if (!approved) {
					throw new Error(`Tool call denied by user: ${this.tool.name}`);
				}
			} else {
				await resolveApproval(true);
			}
		}

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
					const reason =
						callResult.reason ||
						`An extension blocked this ${this.tool.name} call and gave no reason. Do not retry it; tell ` +
							"the operator which extension is blocking so they can fix or remove it.";
					throw new Error(reason);
				}
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(
					`An extension threw a non-error value while vetting this ${this.tool.name} call, so the call was ` +
						`blocked rather than run unchecked: ${errorMessage(err)}. Do not retry it; tell the operator that ` +
						"extension is failing.",
				);
			}
		}

		let result: { content: AgentToolResult<TDetails, TParameters>["content"]; details?: TDetails };
		let executionError: Error | undefined;

		try {
			result = await this.tool.execute(toolCallId, params, signal, onUpdate, context);
		} catch (err) {
			if (isCancellation(err)) throw err;
			executionError = toError(err);
			result = {
				content: [{ type: "text", text: executionError.message }],
				details: undefined as TDetails,
			};
		}

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

				const effectiveError = resultResult.isError ?? !!executionError;

				return {
					content: modifiedContent,
					details: modifiedDetails,
					...(effectiveError ? { isError: true } : {}),
				};
			}
		}

		if (executionError) {
			throw executionError;
		}
		return result;
	}
}
